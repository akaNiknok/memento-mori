#!/usr/bin/env node
/**
 * test.js — `npm test`. No Google account, no Cloudflare account, no dependencies.
 *
 * Three layers, in the order they run:
 *   1. the Apps Script leftovers (Gmail.gs, Backup.gs) through a vm, the same flat-
 *      namespace trick as v1 — Tests.gs PURE_TESTS still drives them;
 *   2. worker/src/*.js as plain ESM imports. Most of what used to need a vm is now a
 *      normal module, so most of this is normal unit testing;
 *   3. contract guards — source-text assertions over things whose FAILURE IS SILENT:
 *      a read that stops carrying an ETag, a create path that loses its idempotency
 *      clause, a read route named so the SPA would POST it. Each of these breaks
 *      something far away from the edit that caused it.
 *
 * What is NOT here: anything needing a real database — that is test-api.js, which runs
 * the handlers against node:sqlite. The v1 cutover tools that used to sit behind this
 * line (migrate/import.js, migrate/verify.js) are gone; `git show v2.3.1:` for them.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { test, describe } = require('node:test');
const { pathToFileURL } = require('url');
// worker.js imports cloudflare:workers (the Glance RPC entrypoint), which only workerd
// provides. Node gets a stand-in that keeps ctx/env the way the real base class does.
require('node:module').registerHooks({ resolve: (s, c, next) => s !== 'cloudflare:workers' ? next(s, c)
  : { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }') } });

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── 1. Apps Script leftovers ────────────────────────────────────────────────
describe('Apps Script (vm)', () => {
  const src = fs.readdirSync(__dirname).filter((f) => f.endsWith('.gs')).sort()
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n;\n');
  // ponytail: Logger and console are the only globals the pure tests touch.
  const sandbox = { console, Logger: { log: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'all.gs' });
  sandbox.PURE_TESTS.forEach((name) => test(name, () => vm.runInContext(name + '()', sandbox)));
});

/**
 * gmail_ingest's watermark — the only GAS logic left that carries state, and the one
 * that lost three MariBank alerts on 2026-09-03/04 by stepping over a failed post.
 * The arithmetic lives inside the loop, so it is driven through the vm with stubs
 * rather than extracted into a helper nothing else would call.
 */
describe('Gmail courier watermark (vm)', () => {
  const src = fs.readdirSync(__dirname).filter((f) => f.endsWith('.gs')).sort()
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n;\n');

  // One run over `msgs` (newest last), with the posts named in `failing` throwing.
  function run(msgs, failing) {
    const props = { WORKER_URL: 'https://worker.example', INGEST_TOKEN: 't', GMAIL_LAST_TS: '0' };
    const trashed = [], posted = [];
    const box = {
      console: { warn: () => {}, error: () => {} }, Logger: { log: () => {} },
      LockService: { getUserLock: () => ({ tryLock: () => true }) },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; }
      }) },
      UrlFetchApp: { fetch: (url, opt) => {
        const id = JSON.parse(opt.payload).messageId;
        posted.push(id);
        if (failing.indexOf(id) !== -1) throw new Error('Gemini 503');
        return { getResponseCode: () => 200,
                 getContentText: () => JSON.stringify({ status: 'success', logged: 1, total: 1, ids: [id] }) };
      } },
      GmailApp: { search: () => [{ getMessages: () => msgs.map((m) => ({
        getId: () => m.id, getFrom: () => 'alerts@maribank.com.ph',
        getSubject: () => 'Successful Debit Card Transaction',
        getDate: () => new Date(m.ts), getPlainBody: () => 'PHP 56.43',
        moveToTrash: () => { trashed.push(m.id); }
      })) }] }
    };
    vm.createContext(box);
    vm.runInContext(src, box, { filename: 'all.gs' });
    vm.runInContext('gmail_ingest()', box);
    return { mark: Number(props.GMAIL_LAST_TS), trashed, posted,
             retryMs: vm.runInContext('GMAIL_RETRY_MS_', box) };
  }

  test('a failed post holds the mark below it, even when a later one succeeds', () => {
    const now = Date.now();
    const a = now - 120000, b = now - 60000;
    const r = run([{ id: 'a', ts: a }, { id: 'b', ts: b }], ['a']);
    assert.deepStrictEqual(r.trashed, ['b']);                 // the good one still lands
    assert.strictEqual(r.mark, a - 1);                        // and 'a' comes back next tick
  });

  test('a clean run still moves the mark to the newest message', () => {
    const now = Date.now();
    const b = now - 60000;
    const r = run([{ id: 'a', ts: now - 120000 }, { id: 'b', ts: b }], []);
    assert.strictEqual(r.mark, b);
  });

  test('a message older than GMAIL_RETRY_MS_ is given up on, not retried for ever', () => {
    const now = Date.now();
    const probe = run([{ id: 'x', ts: now }], []);
    const old = now - probe.retryMs - 1000;
    const r = run([{ id: 'old', ts: old }, { id: 'new', ts: now - 1000 }], ['old']);
    assert.strictEqual(r.mark, now - 1000);
  });
});

(async function () {
  const load = (p) => import(pathToFileURL(path.join(__dirname, 'worker', p)).href);
  const db = await load('src/db.js');
  const jobs = await load('src/jobs.js');
  const tg = await load('src/telegram.js');
  const worker = await load('worker.js');
  const api = await load('src/api.js');
  const gemini = await load('src/gemini.js');

  // ── 2. units ──────────────────────────────────────────────────────────────
  describe('Worker units', () => {

    test('micros round-trip exactly', () => {
      [0, 1, 0.01, 1234.56, -47.89, 2.5, 1e6].forEach((v) => assert.strictEqual(db.fromU(db.toU(v)), v));
      assert.strictEqual(db.toU(1234.565), 1234565000);   // no float dust in the integer
    });

    test('month keys are yyyy-MMM, everywhere', () => {
      assert.strictEqual(db.monthOf('2026-08-23'), '2026-Aug');
      assert.strictEqual(db.monthOf('2026-01-01'), '2026-Jan');
      assert.strictEqual(db.monthOf('2026-12-31'), '2026-Dec');
      assert.deepStrictEqual(db.parseMonthKey('2026-08'), { y: 2026, m: 7 });
      assert.deepStrictEqual(db.parseMonthKey('2026-Aug'), { y: 2026, m: 7 });
      assert.deepStrictEqual(db.parseMonthKey('2026-august'), { y: 2026, m: 7 });
      assert.strictEqual(db.parseMonthKey('nonsense'), null);
      // The SQL generated column builds the same string with substr on the date — if
      // these two ever disagree, every month-keyed screen silently matches nothing.
      const sqlish = (iso) => iso.slice(0, 4) + '-' +
        'JanFebMarAprMayJunJulAugSepOctNovDec'.substr((Number(iso.slice(5, 7)) - 1) * 3, 3);
      ['2026-01-05', '2026-06-30', '2026-11-11'].forEach((d) => assert.strictEqual(db.monthOf(d), sqlish(d)));
    });

    test('shiftMonth wraps years in both directions', () => {
      assert.deepStrictEqual(db.shiftMonth(2026, 0, -1), { y: 2025, m: 11 });
      assert.deepStrictEqual(db.shiftMonth(2026, 11, 1), { y: 2027, m: 0 });
      assert.deepStrictEqual(db.shiftMonth(2026, 7, -5), { y: 2026, m: 2 });
    });

    test('periodMonths gives the calendar quarter', () => {
      assert.deepStrictEqual(db.periodMonths('Monthly', { y: 2026, m: 7 }), ['2026-Aug']);
      assert.deepStrictEqual(db.periodMonths('Quarterly', { y: 2026, m: 7 }), ['2026-Jul', '2026-Aug', '2026-Sep']);
      assert.deepStrictEqual(db.periodMonths('Quarterly', { y: 2026, m: 0 }), ['2026-Jan', '2026-Feb', '2026-Mar']);
    });

    test('manilaToday is Manila, not UTC', () => {
      // 2026-08-23T17:00Z is already the 24th in Manila (UTC+8). A bare toISOString here
      // is the bug the helper exists to prevent — a transaction with no Date would land
      // on tomorrow's day, and a BIR quarter would end, for eight hours out of every
      // twenty-four.
      assert.strictEqual(db.manilaToday(new Date('2026-08-23T17:00:00Z')), '2026-08-24');
      assert.strictEqual(db.manilaToday(new Date('2026-08-23T15:59:00Z')), '2026-08-23');
    });

    test('manilaYesterday is the month-close boundary', () => {
      // The cron fires 06:00 Manila. On the 1st it must close the month that just
      // ended — stamping today's month there would leave that month's last day out of
      // its own close and disagree with the backfill.
      assert.strictEqual(db.manilaYesterday(new Date('2026-09-01T00:00:00Z')), '2026-08-31');
      assert.strictEqual(db.monthOf(db.manilaYesterday(new Date('2026-08-31T22:00:00Z'))), '2026-Aug');
      // 22:00Z on the 31st is already 06:00 on the 1st in Manila — the run that closes August.
      assert.strictEqual(db.manilaYesterday(new Date('2026-08-31T22:00:00Z')), '2026-08-31');
      // Mid-month it is just yesterday, so the current month keeps refreshing.
      assert.strictEqual(db.manilaYesterday(new Date('2026-08-15T22:00:00Z')), '2026-08-15');
    });

    test('parsePeriod normalises or throws — never writes a dead key', () => {
      assert.strictEqual(db.parsePeriod('2026-08'), '2026-Aug');
      assert.strictEqual(db.parsePeriod('2026-AUGUST'), '2026-Aug');
      assert.strictEqual(db.parsePeriod(''), '');
      assert.strictEqual(db.parsePeriod(null), '');
      assert.throws(() => db.parsePeriod('Aug 2026'));
      assert.throws(() => db.parsePeriod('2026-13'));
    });

    test('parseDate keeps an ISO date and never day-shifts it', () => {
      assert.strictEqual(db.parseDate('2026-01-02'), '2026-01-02');
      assert.strictEqual(db.parseDate(''), db.manilaToday());
    });

    test('deltas: liabilities invert, transfers move both sides', () => {
      // The whole balance model in one fold. Asset 1 earns and spends, liability 2 is
      // charged and partly paid off by a transfer, asset 3 funds that transfer.
      const refs = { acctById: { 1: { type: 'Asset' }, 2: { type: 'Liability' }, 3: { type: 'Asset' } } };
      const canned = [
        [{ id: 1, type: 'Income', s: 1000 }, { id: 1, type: 'Expense', s: 400 },
         { id: 2, type: 'Expense', s: 250 }, { id: 3, type: 'Transfer', s: 100 }],
        [{ id: 2, s: 50 }]
      ];
      const stmt = { bind: () => stmt };
      const env = { DB: { prepare: () => stmt, batch: async () => canned.map((results) => ({ results })) } };
      return db.deltas(env, refs).then((net) => {
        assert.strictEqual(net[1], 600);          // +1000 -400
        assert.strictEqual(net[2], 200);          // liability: -(-250) + -(50) = +250 -50
        assert.strictEqual(net[3], -100);         // transfer out
      });
    });

    test('shapeAccounts: signs, credit, and share pricing', () => {
      const refs = { accounts: [
        { id: 1, name: 'Cash', currency: 'PHP', subtype: 'Savings', type: 'Asset', starting_balance_u: 1e6 },
        { id: 2, name: 'Card', currency: 'PHP', subtype: 'Credit', type: 'Liability', starting_balance_u: 0, credit_limit_u: 50e6 },
        { id: 3, name: 'IBKR', currency: 'SHARES', subtype: 'Shares', type: 'Asset', symbol: 'VOO', starting_balance_u: 0 }
      ] };
      const out = db.shapeAccounts(refs, { 1: 0.5e6, 2: 20e6, 3: 2.5e6 },
        { VOO: { price: 500, currency: 'USD' } }, { PHP: 1, USD: 50 });
      const by = Object.fromEntries(out.map((a) => [a.name, a]));
      assert.ok(near(by.Cash.balancePhp, 1.5) && near(by.Cash.netWorthPhp, 1.5));
      assert.strictEqual(by.Card.balancePhp, 20);        // as shown: a liability is positive
      assert.strictEqual(by.Card.netWorthPhp, -20);      // signed: it pulls net worth down
      assert.strictEqual(by.Card.availableCredit, 30);
      assert.strictEqual(by.Cash.availableCredit, null); // an asset has none
      assert.strictEqual(by.IBKR.balanceNative, 2.5);    // native = the QUANTITY
      assert.strictEqual(by.IBKR.balancePhp, 62500);     // 2.5 x $500 x 50
      assert.ok(by.IBKR.isShares && by.IBKR.isInvestment && !by.Cash.isInvestment);
    });

    test('isInvestedNetWorth: a share-priced EF holding is liquid but stays a holding', () => {
      // IB01: a treasury ETF (currency Shares) parked as an emergency fund (subtype EF).
      const ib01 = { currency: 'Shares', subtype: 'EF' };
      const voo = { currency: 'Shares', subtype: 'Stocks' };
      assert.ok(db.isInvestmentAcct(ib01), 'IB01 still counts as a Holdings position');
      assert.ok(!db.isInvestedNetWorth(ib01), 'but it sits with LIQUID in the net-worth split');
      assert.ok(db.isInvestmentAcct(voo) && db.isInvestedNetWorth(voo), 'a real stock is invested in both');
    });

    test('shapeTx blanks are the sheet blanks the SPA expects', () => {
      const refs = { acctById: { 1: { name: 'Cash', currency: 'PHP' } },
                     catById: { 9: { name: 'Food', type: 'Expense', segment: 'Essentials' } } };
      const t = db.shapeTx({ id: 'x', date: '2026-08-01', period: null, category_id: 9, description: null,
                             account_id: 1, amount_u: 12345000, fx_rate: null, to_account_id: null,
                             to_amount_u: null, month: '2026-Aug', amount_php_u: 12345000 }, refs);
      assert.strictEqual(t.Amount, 12.345);
      assert.strictEqual(t['Amount (PHP)'], 12.345);
      ['Period', 'Description', 'ExchangeRate', 'ToAccount', 'ToAmount', 'ToCurrency']
        .forEach((k) => assert.strictEqual(t[k], '', k + ' must be "" and not null'));
      assert.strictEqual(t.Type, 'Expense');
    });

    test('parsePositions reads an IBKR Flex statement', () => {
      const xml = '<FlexQueryResponse><FlexStatement fromDate="20260822" toDate="20260822">' +
        '<OpenPositions><OpenPosition symbol="VOO" position="2.5" markPrice="512.34" currency="USD" />' +
        '<OpenPosition symbol="BAD" position="1" markPrice="" currency="USD" />' +
        '</OpenPositions></FlexStatement></FlexQueryResponse>';
      const p = jobs.parsePositions(xml);
      assert.strictEqual(p.length, 1);                   // a price-less row is skipped, not zeroed
      assert.deepStrictEqual(p[0], { symbol: 'VOO', price: 512.34, currency: 'USD', position: 2.5, pricedAt: '2026-08-22' });
    });

    test('flexWhy keeps the evidence a failed poll would otherwise throw away', () => {
      // ErrorCode present -> the code, so 1019 vs a real fault is readable.
      assert.strictEqual(
        jobs.flexWhy(200, '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode>' +
          '<ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>'),
        '200 1019 Statement generation in progress.');
      // No ErrorCode (a block page) -> the status and stripped text, NOT a bare "not ready".
      assert.strictEqual(jobs.flexWhy(403, '<html><body>  Access\n Denied </body></html>'),
        '403 Access Denied');
      assert.strictEqual(jobs.flexWhy(502, ''), '502 (empty body)');
    });

    test('the prices poll retries what IBKR says to retry, and only that', () => {
      // 2026-08-31: the poll stopped on every code but 1019, so one 1020 ("Invalid
      // request or unable to validate request") killed a whole night of prices. IBKR's
      // table splits by the message: "Please try again shortly" means poll again.
      ['1001', '1004', '1005', '1006', '1007', '1008', '1009', '1018', '1019', '1021']
        .forEach((c) => assert.ok(jobs.flexRetryable(c), c + ' says "try again shortly" and must be polled'));
      // The catch-all. SendRequest has already passed on this token, so the codes that
      // need a human are ruled out and what is left clears by itself.
      assert.ok(jobs.flexRetryable('1020'));
      // These need the owner. Polling them only delays the Telegram message.
      ['1003', '1010', '1011', '1012', '1013', '1014', '1015', '1016', '1017']
        .forEach((c) => assert.ok(!jobs.flexRetryable(c), c + ' needs a human and must fail fast'));
      assert.ok(!jobs.flexRetryable(''));
      assert.ok(jobs.flexRetryable(1019));            // a number reads the same as its string
      assert.ok(jobs.flexRetryable('\n  1019\n'));    // and so does a pretty-printed one
    });

    test('a padded or attributed Flex tag still reads as its error code', () => {
      // xmlTag tolerates an attribute and trims the value, and it must: a code read as
      // ' 1020 ' matches nothing in the retry set, so a transient fault would abort the
      // job, and a tag carrying an attribute would read as absent — which is worse, as
      // the poll then reports "not ready" and hides the code entirely.
      assert.strictEqual(jobs.flexWhy(200, '<ErrorCode> 1020 </ErrorCode>' +
        '<ErrorMessage>  Invalid request.  </ErrorMessage>'), '200 1020 Invalid request.');
      assert.strictEqual(jobs.flexWhy(200, '<ErrorCode type="int">1021</ErrorCode>' +
        '<ErrorMessage lang="en">Try again shortly.</ErrorMessage>'), '200 1021 Try again shortly.');
    });

    test('telegram undo payloads round-trip inside the 64-byte cap', () => {
      assert.deepStrictEqual(tg.undoIds(tg.undoData('tg-90210', [0, 2])), ['tg-90210-0', 'tg-90210-2']);
      const gm = tg.undoData('gm-198f2a3b4c5d6e7f', [0]);
      assert.ok(gm.length <= 64);
      assert.deepStrictEqual(tg.undoIds(gm), ['gm-198f2a3b4c5d6e7f-0']);
      // Receipts sent before the prefix named a source are digits-only and mean Telegram.
      assert.deepStrictEqual(tg.undoIds('u:90210:1'), ['tg-90210-1']);
      ['', null, 'u:90210:', 'u::0', 'undo', 'u:90210:0;DROP'].forEach((bad) =>
        assert.strictEqual(tg.undoIds(bad).length, 0, 'accepted ' + JSON.stringify(bad)));
    });

    test('telegram account matching and balance text', () => {
      const accts = [{ name: 'Maya Savings', currency: 'PHP', balancePhp: 100, netWorthPhp: 100 },
                     { name: 'BPI', currency: 'PHP', balancePhp: 50, netWorthPhp: 50 },
                     { name: 'Card', currency: 'PHP', balancePhp: 20, netWorthPhp: -20, isLiability: true }];
      assert.strictEqual(tg.matchAccounts(accts, 'maya').length, 1);
      assert.strictEqual(tg.matchAccounts(accts, '').length, 3);
      const text = tg.balanceText(accts, null);
      assert.ok(text.includes('owed'), 'a liability must be marked owed');
      assert.ok(text.includes('₱130'), 'total is signed net worth (100+50-20), got: ' + text);
    });

    test('resolveAccountName turns what the model wrote into the ledger name', () => {
      const accts = [{ name: 'MariBank' }, { name: 'Wise' }, { name: 'Wise Savings' },
                     { name: 'BPI Banko' }, { name: 'GCash' }];
      const r = (n) => tg.resolveAccountName(accts, n);
      assert.strictEqual(r('MariBank'), 'MariBank');            // exact
      assert.strictEqual(r('Maribank'), 'MariBank');            // the 2026-08-30 failure
      assert.strictEqual(r('MARIBANK'), 'MariBank');            // an ingested email shouts
      assert.strictEqual(r(' maribank '), 'MariBank');
      assert.strictEqual(r('mari bank'), 'MariBank');           // letters and digits only
      assert.strictEqual(r('bpi'), 'BPI Banko');                // one substring hit
      assert.strictEqual(r('Wise'), 'Wise', 'an exact name must win over its own prefix');
      // Two candidates is not a guess: the name passes through and the API refuses it.
      assert.strictEqual(r('wis'), 'wis');
      assert.strictEqual(r('Nowhere Bank'), 'Nowhere Bank');
      // Too short to substring-match, so it never lands on GCash by accident.
      assert.strictEqual(r('ca'), 'ca');
      [undefined, null, ''].forEach((v) => assert.strictEqual(r(v), v));
    });

    test('querySummary sums absolute PHP and caps the list', () => {
      const rows = Array.from({ length: 7 }, (_, i) =>
        ({ Date: '2026-08-0' + (i + 1), Category: 'Food', 'Amount (PHP)': -10 }));
      const s = tg.querySummary(rows, 7);
      assert.ok(s.includes('₱70'), s);
      assert.ok(s.includes('2 more'), s);
      assert.strictEqual(tg.querySummary([], 0), 'No matching transactions.');
    });

    test('querySummary refuses to add a share quantity to money', () => {
      // A sell leg's Amount is a QUANTITY, so its 'Amount (PHP)' is a share count read
      // as pesos. The row still counts and still lists — it just cannot be summed.
      const rows = [{ Date: '2026-06-10', Category: 'Investment: Growth', Currency: 'Shares', 'Amount (PHP)': 2 },
                    { Date: '2026-06-11', Category: 'Food', Currency: 'PHP', 'Amount (PHP)': 40 }];
      const s = tg.querySummary(rows, 2);
      assert.ok(s.includes('₱40'), s);
      assert.ok(s.includes('2 tx'), 'the trade still happened, so it still counts: ' + s);
    });
  });

  // ── 3. contract guards ────────────────────────────────────────────────────
  describe('Contract guards', () => {

    test('the model fallback chain is bounded as a WHOLE, not per model', () => {
      // The 2026-09-02 loss. A chat turn runs in ctx.waitUntil; Cloudflare cancels
      // waitUntil work that outlives its allowance and the task is torn down, so no
      // catch runs and nothing is sent. Three unbounded tries in a row is how the parse
      // outlived it. A per-model cap alone does not fix that — 3 x 7s still overruns —
      // so the budget must span the chain and stop it when the time is gone.
      const models = ['a', 'b', 'c'];
      let clock = 0;
      const now = () => clock;
      const asked = [];
      // Every model burns most of the budget, then fails.
      const slow = (m, ms) => { asked.push([m, ms]); clock += ms; return Promise.reject(new Error('slow ' + m)); };
      return gemini.tryModels(models, slow, 10000, now).then(
        () => assert.fail('a chain that never succeeds must throw'),
        (err) => {
          assert.ok(asked.length < models.length,
            'the chain tried every model with no time left — it is not bounded as a whole');
          // Each attempt is capped, and a later one may only use what is still left.
          asked.forEach(([m, ms]) => assert.ok(ms <= gemini.MODEL_TIMEOUT_MS,
            'model ' + m + ' was given ' + ms + 'ms, over the per-attempt cap'));
          assert.ok(clock <= 10000 + gemini.MODEL_TIMEOUT_MS, 'the chain spent ' + clock + 'ms of a 10000ms budget');
          assert.ok(/slow|ran out of time/.test(err.message), err.message);
        });
    });

    test('the whole turn fits inside its ceiling, with room to speak', () => {
      // Three numbers that only mean anything together. Since v2.11.0 the turn holds
      // Telegram's webhook connection, so TURN_CEILING_MS is the room and the parse
      // must leave enough of it for the D1 writes and the send that follow — the
      // message saying "Gemini timed out" is sent AFTER the parse gives up, so the
      // slack IS the feature. Raise the budget without raising the ceiling and the
      // silence comes straight back, with nothing else failing.
      assert.ok(gemini.MODEL_TIMEOUT_MS <= gemini.PARSE_BUDGET_MS,
        'one attempt may not outlast the whole chain');
      assert.ok(gemini.PARSE_BUDGET_MS + 4000 <= tg.TURN_CEILING_MS,
        'the parse may run ' + gemini.PARSE_BUDGET_MS + 'ms of a ' + tg.TURN_CEILING_MS +
        'ms turn, leaving too little to write the rows and send the receipt');
    });

    test('the email courier parses on its own clock, under UrlFetchApp', () => {
      // The email path is NOT a chat turn: Apps Script holds the connection and no human
      // waits, so Telegram's 9s cap only manufactured failures on a 3000-char body
      // (2026-09-04). Its ceiling is UrlFetchApp's ~60s instead.
      assert.ok(gemini.EMAIL_TIMEOUT_MS > gemini.MODEL_TIMEOUT_MS,
        'the email path gains nothing over the chat turn — the 9s cap is back');
      assert.ok(gemini.EMAIL_TIMEOUT_MS <= gemini.EMAIL_BUDGET_MS,
        'one attempt may not outlast the whole chain');
      assert.ok(gemini.EMAIL_BUDGET_MS <= 55000,
        'the parse may run ' + gemini.EMAIL_BUDGET_MS + 'ms, past what UrlFetchApp waits for');
    });

    test('/tg AWAITS the turn and never hands it to waitUntil', () => {
      // The 2026-09-02 loss, as a guard. Cloudflare cancels waitUntil work that
      // outlives its allowance and tears the task down WITHOUT throwing, so no catch
      // runs, nothing is sent, and the transaction is gone with a runtime warning as
      // its only trace. Handing the turn back to waitUntil looks like a harmless
      // latency win and silently restores that.
      // Comments are stripped first: this handler EXPLAINS the waitUntil trap at
      // length, and a guard that reads prose would fail on its own documentation.
      const code = fs.readFileSync(path.join(__dirname, 'worker', 'worker.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const fn = /async function telegram\(([\s\S]*?)\n}/.exec(code);
      assert.ok(fn, 'the /tg handler is not called telegram() any more — re-point this guard');
      assert.ok(/await handleUpdate\(/.test(fn[1]),
        '/tg no longer awaits handleUpdate — a slow turn will be cancelled in silence');
      assert.ok(!/waitUntil/.test(fn[1]),
        '/tg hands the turn to waitUntil again; Cloudflare cancels that without an error and the message is lost');
    });

    test('the scheduled handler awaits its job and dispatches on event.cron', () => {
      // Same trap as /tg, on the other entry point: a cancelled waitUntil task is torn
      // down without throwing, so a cut-off cron reports nothing at all. There are two
      // schedules now, and dispatching on the wrong one would run the IBKR pull every
      // two minutes — its rate limit refuses that, so the prices job would simply stop.
      const code = fs.readFileSync(path.join(__dirname, 'worker', 'worker.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const fn = /async scheduled\(([\s\S]*?)\n  }/.exec(code);
      assert.ok(fn, 'the scheduled handler moved — re-point this guard');
      assert.ok(!/waitUntil/.test(fn[1]),
        'scheduled hands its job to waitUntil; Cloudflare cancels that without an error');
      assert.ok(/event\s*&&\s*event\.cron|event\.cron/.test(fn[1]),
        'scheduled ignores event.cron — every schedule would run the same job');
    });

    test('wrangler.toml schedules exactly the crons jobs.js can dispatch', () => {
      // The two lists are the same fact written twice, and nothing at deploy time
      // compares them. A drifted string is silent in both directions: the drain never
      // runs (messages go back to being lost) and runScheduled falls through to a
      // warning, so the daily job never runs either.
      const toml = fs.readFileSync(path.join(__dirname, 'worker', 'wrangler.toml'), 'utf8');
      const block = /\[triggers\][\s\S]*?crons\s*=\s*\[([^\]]*)\]/.exec(toml);
      assert.ok(block, '[triggers] crons is gone — the Worker now has no schedule at all');
      const scheduled = (block[1].match(/"([^"]*)"/g) || []).map((x) => x.slice(1, -1));
      assert.deepStrictEqual(scheduled.slice().sort(), [jobs.CRON_DAILY, jobs.CRON_RETRY, jobs.CRON_DRAIN].sort(),
        'wrangler.toml schedules ' + JSON.stringify(scheduled) + ', which is not what runScheduled() dispatches');
    });

    test('the rescue drain waits out a live turn before it starts a second one', () => {
      // STALE_MS decides when an unfinished row counts as dead work. Set it below the
      // turn ceiling and the drain races turns that are merely slow: no duplicate row
      // (the ids are idempotent) but a duplicate receipt for a message the owner is
      // still waiting on, which is the confusion this whole area exists to remove.
      assert.ok(tg.STALE_MS > tg.TURN_CEILING_MS * 2,
        'the drain calls a turn dead at ' + tg.STALE_MS + 'ms, too close to the ' +
        tg.TURN_CEILING_MS + 'ms a live turn may take');
      assert.ok(tg.MAX_ATTEMPTS >= 1 && tg.DRAIN_LIMIT >= 1,
        'a drain that rescues nothing per firing is not a drain');
    });

    test('the claim carries the update, and the sweep spares unfinished work', () => {
      // The two halves of option ②, in the two statements that can quietly undo it.
      // seen() must store the payload — a claim with no payload is indistinguishable
      // from a lost message, which is exactly the ambiguity that destroyed one.
      // The sweep must skip pending rows: deleting one is the silent loss, restored.
      const src = fs.readFileSync(path.join(__dirname, 'worker', 'src', 'telegram.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const seen = /async function seen\(([\s\S]*?)\n}/.exec(src);
      assert.ok(seen, 'seen() moved — re-point this guard');
      assert.ok(/INSERT INTO seen_updates[^;]*payload/.test(seen[1]),
        'seen() claims the update without storing it — an unfinished turn is unrecoverable again');
      assert.ok(/DELETE FROM seen_updates WHERE done = 1/.test(seen[1]),
        'the sweep no longer spares pending rows — it will delete work the drain has not run yet');

      // The drain must call route(), not handleUpdate(): handleUpdate claims first, and
      // the row it would find claimed is its own, so every rescue would return at once.
      const drain = /export async function drainUpdates\(([\s\S]*?)\n}/.exec(src);
      assert.ok(drain, 'drainUpdates() moved — re-point this guard');
      assert.ok(/await route\(/.test(drain[1]) && !/handleUpdate\(/.test(drain[1]),
        'the drain goes through handleUpdate, which will see its own claim and rescue nothing');
    });

    test('read routes are named get…/list…, write routes are not', () => {
      // worker/public/app.js picks GET vs POST off this prefix instead of shipping a
      // second copy of the table. Break the rule and the symptom is remote: a write
      // silently goes out as a GET and the API answers "requires POST".
      const READY = /^(get|list)/;
      Object.keys(worker.ROUTES_READ).forEach((a) =>
        assert.ok(READY.test(a), "read action '" + a + "' must be named get…/list…"));
      Object.keys(worker.ROUTES_WRITE).forEach((a) =>
        assert.ok(!READY.test(a), "write action '" + a + "' reads as a get…/list… name, so the SPA will GET it"));
    });

    test('fireEta solves the annuity, and its date holds still inside the month', () => {
      const eta = (o) => api.fireEta(Object.assign(
        { netWorthPhp: 500000, monthlyExpensePhp: 20000, monthlySavingsPhp: 25000,
          realReturnPct: 5, today: '2026-09-02' }, o));

      // 25 x annual spend is the target, and the 4% rule is what that multiple IS.
      assert.strictEqual(eta({}).targetPhp, 6000000);
      assert.strictEqual(eta({}).withdrawalRatePct, 4);

      // The compound answer must beat the linear one, or the model is not compounding:
      // (6000000 - 500000) / 25000 = 220 months of pure saving, ~6694 days.
      const days = eta({}).days;
      assert.ok(days > 0 && days < 6694, 'growth must shorten the wait, got ' + days);
      // ...and a higher real return must shorten it further.
      assert.ok(eta({ realReturnPct: 8 }).days < days, 'a better return must pull the date in');
      // With no return at all it IS the linear answer.
      assert.ok(Math.abs(eta({ realReturnPct: 0 }).days - 6694) < 40);

      // THE POINT OF THE WHOLE FEATURE: the inputs are closed months, so the projected
      // DATE is identical on every day of the month and the countdown falls by one day
      // a day. Anchor the projection to `today` instead and both of these break.
      const a = eta({ today: '2026-09-02' }), b = eta({ today: '2026-09-27' });
      assert.strictEqual(a.date, b.date, 'the ETA date must not move inside the month');
      assert.strictEqual(a.days - b.days, 25, 'the countdown must fall one day per day');

      // Already there, and never.
      assert.strictEqual(eta({ netWorthPhp: 9000000 }).days, 0);
      assert.strictEqual(eta({ monthlySavingsPhp: 0, realReturnPct: 0 }).days, null);
      assert.strictEqual(eta({ monthlySavingsPhp: -5000, realReturnPct: 0 }).days, null);
      // No spend history means no target to aim at — no card, not a zero.
      assert.strictEqual(eta({ monthlyExpensePhp: 0 }), null);
    });

    test('the Flex poll classifies the error code and never compares it to a literal', () => {
      // Silent failure: comparing the code against a literal looks correct and passes
      // every day the statement is simply slow. It only shows up as a lost night of
      // prices the first morning IBKR answers with a different transient code. Asserted
      // over the module text, not one function, so moving the poll does not fake a pass.
      const src = fs.readFileSync(path.join(__dirname, 'worker', 'src', 'jobs.js'), 'utf8');
      assert.ok(src.includes('flexRetryable('), 'jobs.js no longer classifies the error code');
      assert.ok(!/\bcode\s*[!=]==\s*'\d+'/.test(src), 'jobs.js is back to testing the code against one literal');
      // The pace exists for the tests; production must never be handed a faster one.
      assert.ok(/pricesJob\(env\)/.test(src), 'runCron must call pricesJob with the real pace');
    });

    test('every read is answered with an ETag and honours If-None-Match', () => {
      // The whole client cache hangs off this one function. test-api.js proves it with
      // real requests; this proves the read path still ROUTES through it, which is the
      // part a refactor of api() could quietly drop.
      const src = fs.readFileSync(path.join(__dirname, 'worker', 'worker.js'), 'utf8');
      assert.ok(/readResponse\(body, request\)/.test(src), 'GET reads no longer go through readResponse');
      assert.ok(/If-None-Match/.test(src) && /304/.test(src), 'readResponse no longer answers 304');
    });

    test('both create paths keep their idempotency contract', () => {
      // The SPA's offline queue replays creates, and a replay may be of a write that
      // ALREADY landed (the connection can die after the row was committed). The only
      // thing making that safe is the conflict clause plus the 'duplicate' status; the
      // Telegram retry dedup rides on the same two.
      ['createTransaction', 'createTransfer'].forEach((name) => {
        const src = worker.ROUTES_WRITE[name].toString();
        assert.ok(src.includes('ON CONFLICT(id) DO NOTHING'), name + ' lost its ON CONFLICT clause');
        assert.ok(src.includes("'duplicate'"), name + ' no longer reports {status:"duplicate"}');
        assert.ok(src.includes('meta.changes'), name + ' no longer detects the no-op insert');
      });
    });

    test('every peso aggregate that can see a Transfer excludes share-priced sources', () => {
      // On a share-priced account amount_u is a QUANTITY, and a sell leg gets no
      // fx_rate — so amount_php_u is a share count read as pesos. Budgets are the one
      // report that counts Transfers, so they are the one that can ingest it, and the
      // failure is silent: a 30-share sale reports as ₱30 of spending.
      const src = fs.readFileSync(path.join(__dirname, 'worker', 'src', 'api.js'), 'utf8');
      assert.ok(src.includes('NOT_SHARES_SRC'),
        'budgetsPayload no longer excludes share-priced sources from its peso sums');
      assert.ok(/SHARES/.test(db.NOT_SHARES_SRC) && /stock/.test(db.NOT_SHARES_SRC),
        'NOT_SHARES_SRC must mirror isSharesAcct — currency AND subtype');
    });

    test('button glyphs stay outside the emoji set', () => {
      // A text variation selector does NOT stop Telegram emoji-fying a glyph: it renders
      // every Emoji=Yes codepoint with its own emoji font and ignores U+FE0E, which is
      // how "↩︎ Undo" once shipped as a yellow ↩️. ❌ and ⛔ are deliberately emoji.
      // Comments stripped first: the file's own header names the banned glyphs in order
      // to explain the rule, and that must not trip the rule.
      const src = fs.readFileSync(path.join(__dirname, 'worker', 'src', 'telegram.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      ['↩', '✉', '📧', '✏'].forEach((bad) =>
        assert.ok(!src.includes(bad), bad + ' is Emoji=Yes — use ↻ / ⌕ / ✎ instead'));
      ['↻', '⌕', '✎'].forEach((good) => assert.ok(src.includes(good), 'lost the ' + good + ' button glyph'));
    });

    test('the staging environment cannot inherit the cron or share the live database', () => {
      // Wrangler inherits MOST keys into a named environment but not the bindings, and
      // both halves of that bite. `triggers` IS inherited, so without an empty override
      // staging runs the 06:00 IBKR job and the net-worth snapshot on its own schedule.
      // `d1_databases` is NOT, so a copied block that keeps the production id points a
      // staging Worker at the real ledger. Neither failure says anything at deploy time.
      const toml = fs.readFileSync(path.join(__dirname, 'worker', 'wrangler.toml'), 'utf8');
      const sections = [];
      let cur = null;
      toml.split(/\r?\n/).forEach((line) => {
        const head = line.match(/^\s*\[\[?([^\]]+?)\]\]?\s*$/);
        if (head) sections.push((cur = { name: head[1], body: [] }));
        else if (cur) cur.body.push(line);
      });
      const val = (sec, key) => {
        const m = sec.body.join('\n').match(new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'm'));
        return m && m[1];
      };
      const named = (n) => sections.filter((sec) => sec.name === n);

      const live = named('d1_databases'), staging = named('env.staging.d1_databases');
      assert.strictEqual(staging.length, live.length,
        'every [[d1_databases]] needs an [[env.staging.d1_databases]] copy — bindings are not inherited');
      live.forEach((l) => {
        const copy = staging.find((x) => val(x, 'binding') === val(l, 'binding'));
        assert.ok(copy, 'no staging copy of the D1 binding ' + val(l, 'binding'));
        assert.notStrictEqual(val(copy, 'database_id'), val(l, 'database_id'),
          'staging binding ' + val(l, 'binding') + ' points at the PRODUCTION database');
        [l, copy].forEach((x) => assert.ok(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(val(x, 'database_id')),
          val(x, 'database_name') + ' has no real database_id — run `wrangler d1 create` and paste it'));
      });

      const trig = named('env.staging.triggers')[0];
      assert.ok(trig && /crons\s*=\s*\[\s*\]/.test(trig.body.join('\n')),
        '[env.staging.triggers] crons = [] is missing — staging would inherit the production cron');

      // vars are not inherited either, so a top-level block needs a staging counterpart.
      if (named('vars').length) assert.ok(named('env.staging.vars').length,
        'a top-level [vars] block needs an [env.staging.vars] copy — vars are not inherited');
    });

    test('the Scriptable widget compiles and calls a real read route', () => {
      // It runs only on a phone, so nothing else here would notice it break. Scriptable
      // wraps a script in an async function (top-level await), hence the wrapper.
      const src = fs.readFileSync(path.join(__dirname, 'widgets', 'memento-mori.js'), 'utf8');
      new vm.Script('(async () => {' + src + '\n})');
      const used = src.match(/action=(\w+)/g).map((m) => m.slice(7));
      used.forEach((a) => assert.ok(a in worker.ROUTES_READ, 'the widget calls ' + a + ', which is not a read route'));
    });

    test('the topbar version matches package.json', () => {
      // The header badge is hardcoded (no build step stamps the SPA), so this is the
      // only thing that stops it drifting a release behind.
      const ver = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
      const html = fs.readFileSync(path.join(__dirname, 'worker', 'public', 'index.html'), 'utf8');
      assert.ok(html.includes('<span class="brand-ver">v' + ver + '</span>'),
        'index.html brand-ver is not v' + ver + ' — bump it with the version');
    });

    test('the SPA loads, and its pure helpers still answer', () => {
      // Running app.js in a vm proves it parses, and hands every pure helper below to
      // node's assert without a browser.
      const noop = () => {};
      // Enough DOM to let the chart builders run: they only set attributes and append.
      const mkNode = (tag) => ({ tag, attrs: {}, kids: [], style: {},
        setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); return c; },
        addEventListener: noop });
      const app = {
        console: { log: noop, warn: noop, error: noop },
        navigator: {}, window: { addEventListener: noop },
        document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                    createElement: mkNode, createElementNS: (_ns, t) => mkNode(t) },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        setTimeout, clearTimeout, Date, Math, JSON, encodeURIComponent, URLSearchParams,
        AbortSignal,   // gs() arms a timeout with it; without it here app.js throws on load
        crypto, structuredClone,   // gs() stamps the offline-replay ID and clones the body
        history: {}, location: { search: '', href: 'https://x/' }
      };
      app.globalThis = app;
      let seen = '', seenInit = null;
      app.fetch = (u, i) => { seen = u; seenInit = i; return Promise.resolve({ status: 200, headers: { get: () => '"tag"' },
                                                                json: () => Promise.resolve({ status: 'ok' }) }); };
      vm.createContext(app);
      vm.runInContext(fs.readFileSync(path.join(__dirname, 'worker', 'public', 'app.js'), 'utf8'), app, { filename: 'app.js' });
      assert.ok(app.SCREEN_FNS.admin, 'the Admin screen is not registered');
      // The shell's sync words: a queue always shows, offline wins over "Synced".
      assert.strictEqual(app.syncText(false, 0, 0, 0), 'Synced');
      assert.strictEqual(app.syncText(false, 0, 1000, 1000 + 30e3), 'Synced just now');
      assert.strictEqual(app.syncText(false, 0, 0 + 1, 5 * 60e3 + 1), 'Synced 5 min ago');
      assert.strictEqual(app.syncText(true, 0, 1, 2), 'Offline');
      assert.strictEqual(app.syncText(true, 2, 1, 2), 'Offline · 2 waiting to sync');
      // The tooltip body escapes its inputs and bolds only the result rows.
      // Swap: floor = (usd − your fee) × mid, ceiling = usd × mid + their fee; the split shares the pot.
      const sw = app.swapCalc(1000, 60, 4, 150, 50);
      assert.strictEqual(sw.floor, 59760); assert.strictEqual(sw.ceil, 60150);
      assert.strictEqual(sw.pot, 390); assert.strictEqual(sw.deal, 59955);
      assert.strictEqual(sw.youSave + sw.theySave, sw.pot);
      assert.strictEqual(app.swapCalc(1000, 60, 4, 150, 0).deal, 59760, 'a 0% share is the Wise floor');
      // Tax quarters: filed only when every salary in it is; Q4 is due on the annual return.
      const tq = app.taxQuarters([
        { 'Date Received': '2026-02-01', 'Filed?': '2026-Q1', 'Total Income': 100, '8% Tax': 8 },
        { 'Date Received': '2026-08-01', 'Filed?': '', 'Total Income': 200, '8% Tax': 16 },
        { 'Date Received': '2026-07-01', 'Filed?': '2026-Q3', 'Total Income': 50, '8% Tax': 4 },
        { 'Date Received': '⚠ transaction deleted', 'Filed?': '', 'Total Income': 999, '8% Tax': 80 },
        { 'Date Received': '2025-12-01', 'Filed?': '', 'Total Income': 999, '8% Tax': 80 }
      ], '2026', '2026-09-19');
      assert.strictEqual(tq.map((q) => q.state).join(), 'filed,empty,due,future');
      assert.strictEqual(tq[2].php, 250); assert.strictEqual(tq[2].tax, 20); assert.ok(tq[2].current);
      assert.strictEqual(tq[2].due, '2026-11-15'); assert.strictEqual(tq[3].due, '2027-04-15');
      // A changed figure rolls only when the text around the number is the same.
      assert.strictEqual(app.rollPlan('₱1,200', '₱1,350').text(1275), '₱1,275');
      assert.strictEqual(app.rollPlan('5.2 months', '5.4 months').text(5.3), '5.3 months');
      assert.strictEqual(app.rollPlan('—', '₱0'), null);
      assert.strictEqual(app.rollPlan('₱5', '₱5'), null);
      const tipH = app.tipHTML({ title: 'A<b>', rows: [['In', '1'], ['Out', '2', true]], note: 'n' });
      assert.ok(tipH.includes('A&lt;b&gt;') && !tipH.includes('A<b>'), 'tipHTML must escape');
      // Accounts rows: interest_rate is a fraction, and a 0% rate says nothing.
      assert.strictEqual(app.rateText({ interestRate: 0.0325, interestFrequency: 'Monthly' }), '3.25% a year · monthly interest');
      assert.strictEqual(app.rateText({ interestRate: 0.05, interestFrequency: 'None' }), '5.00% a year');
      assert.strictEqual(app.rateText({ interestRate: 0 }), '');
      assert.ok(app.signedPhp(-5).startsWith('−') && !app.signedPhp(5).startsWith('−'), 'a liability reads with a real minus');
      assert.strictEqual((tipH.match(/class="b"/g) || []).length, 2, 'only the bold row carries class b');
      // A new transaction defaults to the date the list is filtered to, not today.
      app.S.screen = 'transactions'; app.S.tx.filters = { date: '2026-02-14' };
      assert.strictEqual(app.newTxDate(), '2026-02-14');
      app.S.tx.filters = {};
      assert.strictEqual(app.newTxDate(), app.isoDate(new Date()));
      app.S.screen = 'dashboard'; app.S.tx.filters = { date: '2026-02-14' };
      assert.strictEqual(app.newTxDate(), app.isoDate(new Date()), 'off-screen filter must not leak into the date');
      app.S.screen = 'dashboard'; app.S.tx.filters = {};
      // Net worth: last point = current total; earlier months roll back through
      // that month's savings UNLESS a real snapshot pins them.
      const cf = [{ month: '2026-Jun', income: 80, expense: 30 },
                  { month: '2026-Jul', income: 100, expense: 40 },
                  { month: '2026-Aug', income: 200, expense: 50 }];
      const est = app.netWorthSeries(cf, 1000);
      assert.strictEqual(est[2].nw, 1000);               // last point = current net worth
      assert.strictEqual(est[2].real, true);             // live point is real
      assert.strictEqual(est[1].nw, 1000 - (200 - 50));  // undo August's +150 savings
      assert.strictEqual(est[1].real, false);            // no snapshot → estimated
      // A snapshot pins that month and re-anchors the roll-back for earlier ones.
      const real = app.netWorthSeries(cf, 1000, { '2026-Jul': 900 });
      assert.strictEqual(real[1].nw, 900);
      assert.strictEqual(real[1].real, true);
      assert.strictEqual(real[0].nw, 900 - (100 - 40));  // rolls back from the snapshot, not the live total
      // roll=false (the invested series): no snapshot → hold the current value flat,
      // never roll it back through savings (the market moves it, cash flow does not).
      const held = app.netWorthSeries(cf, 500, {}, false);
      assert.strictEqual(held[2].nw, 500);
      assert.strictEqual(held[0].nw, 500, 'invested holds flat, does not roll back through cash flow');
      // The history tile keeps zero in its net-worth domain: a NEGATIVE month must
      // plot below a dashed zero line, never read as positive (it once did, on the
      // v2 chart's floating right axis).
      const liqNeg = [{ month: '2026-Jul', nw: 100000, real: true }, { month: '2026-Aug', nw: -9106, real: true }];
      const stk0 = liqNeg.map(p => ({ month: p.month, nw: 0, real: true }));
      const hc = app.historyCharts(cf.slice(1), liqNeg, stk0, false, 600);
      const flat = (n, out = []) => { out.push(n); (n.kids || []).forEach(k => flat(k, out)); return out; };
      assert.ok(flat(hc.nw).some(n => n.tag === 'line' && n.attrs['stroke-dasharray']), 'no dashed zero line');
      assert.ok(hc.yTot[1] > hc.y0, 'a negative net worth must plot BELOW zero');
      assert.deepStrictEqual(hc.cx, [21, 579], 'the end months sit at the edges, inset by one bar pair (18 + 3)');
      // The FI countdown rounds to whole months BEFORE it splits years off.
      assert.strictEqual(app.yearsMonths(3683), '10y 1m');
      assert.strictEqual(app.yearsMonths(353), '1y 0m', '11.6 months rounds up to a year');
      assert.strictEqual(app.yearsMonths(330), '11m');
      assert.strictEqual(app.yearsMonths(10), 'Under a month');
      // The editor's card is held by reference. toastRoot() parks #toastRoot inside the
      // editor dialog, so a card found by POSITION (lastChild) became the toast strip after
      // any save: the next form mounted there, untappable, over the last one's stale copy.
      const appSrc = fs.readFileSync(path.join(__dirname, 'worker', 'public', 'app.js'), 'utf8');
      assert.ok(!/\b(r|ED\.root)\.(lastChild|lastElementChild)\b/.test(appSrc), 'find the editor card through ED.card, not by position');
      // A dialog host's own display beats the UA's display:none for a closed dialog, so
      // without this rule a closed #modalRoot covers the app and eats every tap (v3.2.3).
      const cssSrc = fs.readFileSync(path.join(__dirname, 'worker', 'public', 'app.css'), 'utf8');
      assert.ok(cssSrc.includes('.modal-root:not([open]),.ed-root:not([open]){display:none}'), 'a closed dialog must not cover the app');
      // Left to spend counts TODAY: the last day of the month is 1 day left, never 0.
      assert.strictEqual(app.daysLeftIn(new Date(2026, 8, 30)), 1, 'the last day still counts');
      assert.strictEqual(app.daysLeftIn(new Date(2026, 8, 23)), 8);
      assert.strictEqual(app.daysLeftIn(new Date(2028, 1, 1)), 29, 'a leap February');
      // The forms' pre-save check. Offline, anything the server would refuse was queued,
      // toasted "Saved offline", then DROPPED at sync — a transfer with no To account or a
      // zero amount lost the entry that way.
      const okTx = { Category: 'Food', Account: 'GCash', Amount: 180 };
      assert.strictEqual(app.draftError(okTx, false), '');
      assert.strictEqual(app.draftError(Object.assign({}, okTx, { Amount: -95 }), false), '', 'a refund is allowed');
      assert.ok(app.draftError(Object.assign({}, okTx, { Amount: 0 }), false), 'a zero amount must be refused');
      assert.ok(app.draftError(Object.assign({}, okTx, { Amount: NaN }), false));
      assert.ok(app.draftError(Object.assign({}, okTx, { Category: '' }), false));
      const okX = { Category: 'Transfer: Internal', Account: 'Wise', ToAccount: 'GCash', Amount: 100 };
      assert.strictEqual(app.draftError(okX, true), '');
      assert.ok(app.draftError(Object.assign({}, okX, { ToAccount: '' }), true), 'a transfer needs its To account');
      assert.ok(app.draftError(Object.assign({}, okX, { ToAccount: 'Wise' }), true), 'From and To must differ');
      assert.ok(app.draftError(Object.assign({}, okX, { Amount: 0 }), true));

      // A refund is a NEGATIVE Expense row. The list used to read Amount as a magnitude
      // and take its sign from the category type, which printed "- -₱95" and — far
      // worse — sent 95 back on save, turning the refund into a charge.
      const refund = { ID: 'r1', Date: '2026-08-25', Type: 'Expense', Amount: -95,
                       'Amount (PHP)': -95, Currency: 'PHP', Account: 'MariBank' };
      assert.strictEqual(app.amtField(-95), -95, 'the edit field must not absolute the amount');
      assert.strictEqual(app.groupByDay([refund])[0].net, 95, 'a refund ADDS to the day net');
      assert.strictEqual(app.groupByDay([{ Date: '2026-08-25', Type: 'Expense', Amount: 95,
                                           'Amount (PHP)': 95 }])[0].net, -95);
      // Activity's token grammar: quotes, comparisons and ISO dates are exact; a word
      // offers every reading, best first, and Text always comes last.
      const ctx = { categories: ['Food: Groceries', 'Transport: Fuel'], accounts: ['GCash', 'Wise'],
                    segments: ['Essentials', 'Growth'], now: new Date(2026, 8, 19) };
      const P = (q) => JSON.parse(JSON.stringify(app.parseTokens(q, ctx)));   // vm-realm arrays
      assert.deepStrictEqual(P('"grab car"'), [{ k: 'search', v: 'grab car' }]);
      assert.deepStrictEqual(P('>500'), [{ k: 'minAmount', v: '500' }]);
      assert.deepStrictEqual(P('≤ 1.5k'), [{ k: 'maxAmount', v: '1500' }]);
      assert.deepStrictEqual(P('2026-09-18'), [{ k: 'date', v: '2026-09-18' }]);
      assert.deepStrictEqual(P('aug')[0], { k: 'month', v: '2026-Aug' });
      assert.deepStrictEqual(P('sep 17')[0], { k: 'date', v: '2026-09-17' });
      assert.deepStrictEqual(P('17 september')[0], { k: 'date', v: '2026-09-17' });
      assert.deepStrictEqual(P('9/17/2025')[0], { k: 'date', v: '2025-09-17' });
      assert.deepStrictEqual(P('oct 3')[0], { k: 'date', v: '2025-10-03' }, 'a date without a year is never in the future');
      assert.ok(!P('feb 30').some((t) => t.k === 'date'), 'no such day');
      assert.deepStrictEqual(P('sep 17').pop(), { k: 'search', v: 'sep 17' });
      assert.deepStrictEqual(P('oct')[0], { k: 'month', v: '2025-Oct' }, 'a bare month is never in the future');
      assert.deepStrictEqual(P('march 2024')[0], { k: 'month', v: '2024-Mar' });
      assert.deepStrictEqual(P('this month')[0], { k: 'month', v: '2026-Sep' });
      assert.ok(P('transfer').some((t) => t.k === 'type' && t.v === 'Transfer'));
      assert.ok(P('gmail').some((t) => t.k === 'source' && t.v === 'gm'));
      assert.ok(P('gro').some((t) => t.k === 'category' && t.v === 'Food: Groceries'));
      assert.ok(P('gro').some((t) => t.k === 'segment' && t.v === 'Growth'));
      assert.ok(P('300').some((t) => t.k === 'minAmount' && t.v === '300'), 'a bare number is "at least"');
      assert.deepStrictEqual(P('gcash').pop(), { k: 'search', v: 'gcash' });
      assert.deepStrictEqual(P('  '), []);
      // parseAdd: the add field's instant, local pass.
      const qctx = { accounts: ['GCash', 'GrabPay', 'Wise USD', 'Maya'], descCategory: { vitamins: 'Health: Medical' } };
      const A = (t) => JSON.parse(JSON.stringify(app.parseAdd(t, qctx)));
      assert.deepStrictEqual(A('vitamins 620 gcash'),
        { Amount: 620, Account: 'GCash', ToAccount: '', Category: 'Health: Medical', Description: 'Vitamins' });
      assert.strictEqual(A('grab 312 gcash').Account, 'GCash', 'the last account named wins');
      assert.strictEqual(A('grab 312 gcash').Description, 'Grab', 'an earlier prefix match stays text');
      assert.strictEqual(A('lunch 1.5k').Amount, 1500);
      assert.strictEqual(A('refund -₱1,200.50 maya').Amount, -1200.5);
      assert.deepStrictEqual([A('gcash to maya 500').Account, A('gcash to maya 500').ToAccount, A('gcash to maya 500').Description], ['GCash', 'Maya', '']);
      assert.strictEqual(A('500 wise usd').Account, 'Wise USD', 'a two-word name');
      assert.strictEqual(A('go to the gym 300').ToAccount, '', '"to" without accounts on both sides is text');
      assert.deepStrictEqual(A('coffee'), { Amount: null, Account: '', ToAccount: '', Category: '', Description: 'Coffee' });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(app.activeTokens({ month: '', type: 'Expense', minAmount: '300' }))),
                             [{ k: 'type', v: 'Expense' }, { k: 'minAmount', v: '300' }], 'month "" means all months: no token');
      assert.strictEqual(app.tokenText('month', '2026-Sep'), 'September 2026');
      assert.strictEqual(app.tokenText('type', 'Transfer'), 'Moved');
      // A smart list without a month is every month, never the Summary's month.
      assert.strictEqual(app.filterSig(app.listFilters({ filters: { source: 'gm' } })), app.filterSig({ month: '', source: 'gm' }));
      assert.strictEqual(app.fmtNet(-3758.4), '−₱3,758');

      app.S.tx = { pendingEdits: { r1: { ID: 'r1', Amount: -50 } } };
      assert.strictEqual(app.withPendingEdit(refund).Amount, -50, 'an in-flight edit keeps the sign');
      assert.strictEqual(app.withPendingEdit(refund)['Amount (PHP)'], -50);

      // A queued write must never be lost silently. localStorage is the only place the
      // queue lives, so a full quota has to evict the disposable cache and retry — and
      // if that still fails, THROW, because enqueue otherwise toasts "Saved offline"
      // over a transaction that was never stored.
      let full = true, evictHelps = true; const wrote = {};
      app.localStorage = {
        getItem: (k) => (k === 'mm.queue' ? '[]' : null),
        removeItem: (k) => { if (k === 'mm.cache' && evictHelps) full = false; },
        setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); wrote[k] = v; }
      };
      app.queueSet([{ fn: 'api_createTransaction', arg: { ID: 'ui-1' } }]);
      assert.ok(/ui-1/.test(wrote['mm.queue'] || ''), 'queueSet must evict mm.cache and retry');
      full = true; evictHelps = false;   // the retry fails too: nothing left to free
      assert.throws(() => app.queueSet([{ fn: 'api_createTransaction', arg: { ID: 'ui-2' } }]),
        /NOT saved/, 'a queue write that cannot land must throw, not be swallowed');

      // A transfer between two currencies is not complete without the amount that arrived:
      // quick add saved "100 wise to bpi" as $100 out, ₱100 in (bug audit, 2026-09-23).
      app.S.boot = { accounts: [{ name: 'Wise', currency: 'USD' }, { name: 'BPI', currency: 'PHP' },
                                { name: 'Maya', currency: 'PHP' }] };
      const xfer = { kind: 'xfer', Amount: 100, Account: 'Wise', ToAccount: 'BPI', Category: 'Transfer: Internal' };
      assert.strictEqual(app.qaComplete(xfer), false, 'USD -> PHP with no ToAmount must not save');
      assert.strictEqual(app.qaComplete(Object.assign({}, xfer, { ToAmount: 5600 })), true);
      assert.strictEqual(app.qaComplete(Object.assign({}, xfer, { Account: 'Maya' })), true, 'same currency needs none');

      const reply = (ok, status) => () => Promise.resolve({ ok, status, headers: { get: () => null },
        json: () => Promise.resolve({ status: 'error', message: 'x' }) });
      return app.gs('api_getDashboard', {}).then(() => {
        assert.ok(/action=getDashboard/.test(seen), seen);
        // Without a timeout a dying connection hangs fetch forever: the spinner never
        // resolves and the offline queue never engages, because it runs off the reject.
        assert.ok(seenInit && seenInit.signal, 'gs() must arm an abort timeout');
        // Only a 200 refusal is final. A 5xx error body (a D1 hiccup, a bug) must leave the
        // queued write in place — flushQueue drops an entry on `_server` alone.
        app.fetch = reply(false, 500);
        return app.gs('api_createTransaction', { ID: 'ui-q' }).then(() => assert.fail('must reject'),
          (e) => assert.strictEqual(e._server, false, 'a 500 is not a refusal'));
      }).then(() => {
        app.fetch = reply(true, 200);
        return app.gs('api_createTransaction', { ID: 'ui-q' }).then(() => assert.fail('must reject'),
          (e) => assert.strictEqual(e._server, true, 'a 200 error is the server refusing the payload'));
      });
    });
  });

})();
