#!/usr/bin/env node
/**
 * test-api.js — the handlers against a REAL SQLite database, in memory.
 *
 * `test.js` covers pure functions and contract guards. This covers the half that only
 * a database can answer: does the schema actually create, do the generated columns
 * compute what the JS thinks they compute, does the ledger view join, does a duplicate
 * insert report `duplicate`, do the balances come out right end to end. Every one of
 * those would otherwise be discovered during the owner's cutover.
 *
 * node:sqlite is the same engine D1 runs, so the SQL is genuinely exercised — which is
 * how the two schema traps were caught (a non-deterministic function in a generated
 * column, and CAST truncating before ROUND). A tiny shim maps D1's prepare/bind/
 * all/first/run/batch onto it. batch() is NOT made transactional here; the tests do not
 * exercise rollback, and faking it would be pretending.
 *
 * Requires Node 22+ for node:sqlite. Older Node skips the file rather than failing —
 * `npm test`'s first half still runs everywhere.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) {
  console.log('\nskipping test-api.js: node:sqlite is unavailable (needs Node 22+)');
  process.exit(0);
}
// After the skip guard on purpose: the skip must still work on a Node too old for either
// built-in module.
const { test, describe } = require('node:test');
// worker.js imports cloudflare:workers (the Glance RPC entrypoint), which only workerd
// provides. Node gets a stand-in that keeps ctx/env the way the real base class does.
require('node:module').registerHooks({ resolve: (s, c, next) => s !== 'cloudflare:workers' ? next(s, c)
  : { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }') } });

// ── the D1 shim ──────────────────────────────────────────────────────────────
function d1(db) {
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec: () => {
      const st = db.prepare(sql);
      if (/^\s*(select|with)/i.test(sql)) return { results: st.all(...args), meta: { changes: 0 } };
      const r = st.run(...args);
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => s._exec()) };
}

(async function () {
  const load = (p) => import(pathToFileURL(path.join(__dirname, 'worker', p)).href);
  const api = await load('src/api.js');
  const dbm = await load('src/db.js');
  const jobsMod = await load('src/jobs.js');
  const tgMod = await load('src/telegram.js');
  const gem = await load('src/gemini.js');

  const sqlite = new DatabaseSync(':memory:');
  const env = {
    DB: d1(sqlite),
    // A fixed rate, so no test ever reaches the network. This is also the read path's
    // real shape: fxRate() only fetches when the KV entry is cold.
    FX_CACHE: { get: async () => '50', put: async () => {} },
    TELEGRAM_USER_ID: '1'
  };

  let schemaOk = false;
  await test('every migration applies cleanly, in order (generated columns, view, snapshots)', () => {
    const dir = path.join(__dirname, 'worker', 'migrations');
    fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .forEach((f) => sqlite.exec(fs.readFileSync(path.join(dir, f), 'utf8')));
    schemaOk = true;
  });
  // Awaited on purpose: every fixture and test below reads these tables, so a broken
  // migration must stop the file rather than produce 30 identical "no such table" lines.
  if (!schemaOk) { console.error('\nschema failed — nothing else can run'); return; }

  // ── fixtures ───────────────────────────────────────────────────────────────
  sqlite.exec(`
    INSERT INTO account_types (subtype, type) VALUES ('Savings','Asset'),('Credit','Liability'),('Shares','Asset');
    INSERT INTO accounts (id,name,currency,subtype,symbol,starting_balance_u,interest_frequency,interest_rate,credit_limit_u) VALUES
      (1,'Maya','PHP','Savings',NULL,1000000000,'Daily',0.04,NULL),
      (2,'Wise','USD','Savings',NULL,100000000,NULL,NULL,NULL),
      (3,'Card','PHP','Credit',NULL,0,NULL,NULL,50000000000),
      (4,'IBKR','SHARES','Shares','VOO',0,NULL,NULL,NULL);
    INSERT INTO categories (id,name,type,segment,description) VALUES
      (1,'Income: Salary','Income','Income','monthly pay'),
      (2,'Expense: Food','Expense','Essentials','groceries'),
      (3,'Investment: Growth','Transfer','Growth','into the broker'),
      (4,'Income: Interest','Income','Income','bank interest');
    INSERT INTO budgets (id,segment,period,target_type,target,currency) VALUES
      (1,'Essentials','Monthly','Percent',50,NULL),
      (2,'Growth','Quarterly','Amount',100,'USD');
    INSERT INTO recurring (id,description,currency,amount_u,fee_u,months_left,grp) VALUES
      (1,'Internet','PHP',1699000000,0,NULL,'Bills');
    INSERT INTO prices (symbol,priced_at,price,currency) VALUES ('VOO','2026-08-22',500,'USD');
  `);

  // The local-dev fixture. It is not test data — an agent opens the SPA on it — but it
  // has to keep matching the schema, and only a real database can say whether it does.
  await test('seed.sql applies to the real schema, is re-runnable, and dates itself to today', () => {
    const fresh = new DatabaseSync(':memory:');
    const dir = path.join(__dirname, 'worker', 'migrations');
    fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .forEach((f) => fresh.exec(fs.readFileSync(path.join(dir, f), 'utf8')));
    const seed = fs.readFileSync(path.join(__dirname, 'worker', 'seed.sql'), 'utf8');
    fresh.exec(seed);
    fresh.exec(seed);   // DELETE-first, so `npm run dev:seed` twice is not a PK collision
    const one = (sql) => fresh.prepare(sql).get();
    assert.ok(one('SELECT COUNT(*) n FROM transactions').n > 40, 'seed has too few transactions to fill a screen');
    assert.strictEqual(one('SELECT COUNT(DISTINCT month) n FROM transactions').n, 3, 'seed should span three months');
    // Relative dates: the app must open on a populated month, and never show the future.
    assert.strictEqual(one("SELECT COUNT(*) n FROM transactions WHERE date > date('now')").n, 0);
    assert.ok(one("SELECT MAX(date) d FROM transactions").d >= one("SELECT date('now','start of month') d").d,
      'no seeded row lands in the current month — the relative-date expression stopped working');
    assert.strictEqual(one('SELECT COUNT(*) n FROM ledger_view WHERE tx_deleted').n, 1, 'seed must keep one orphan ledger row');
  });

  await describe('Writes', () => {
    test('createTransaction: stores, derives, and shapes the reply', async () => {
      const r = await api.createTransaction(
        { ID: 't1', Date: '2026-08-05', Category: 'Expense: Food', Account: 'Maya',
          Amount: 250.5, Description: 'Groceries' }, env);
      assert.strictEqual(r.status, 'success');
      assert.strictEqual(r.transaction.Amount, 250.5);
      assert.strictEqual(r.transaction['Amount (PHP)'], 250.5);
      assert.strictEqual(r.transaction.Month, '2026-Aug');   // the generated column, from SQLite
      assert.strictEqual(r.transaction.Type, 'Expense');
      assert.strictEqual(r.transaction.Segment, 'Essentials');
      assert.strictEqual(r.transaction.Currency, 'PHP');
    });

    test('createTransaction: a replayed ID is a duplicate, never a second row', async () => {
      const r = await api.createTransaction(
        { ID: 't1', Date: '2026-08-05', Category: 'Expense: Food', Account: 'Maya', Amount: 250.5 }, env);
      assert.strictEqual(r.status, 'duplicate');
      assert.strictEqual(r.transaction.ID, 't1');
      const n = sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id='t1'").get().n;
      assert.strictEqual(n, 1, 'the offline queue would have double-posted');
    });

    // ── name resolution ──────────────────────────────────────────────────────
    // "Foodpanda for Berry / 413.52 Maribank" was refused with "Unknown Account:
    // Maribank" while MariBank sat in the table (2026-08-30). Every write path now
    // resolves a name exactly first and case-insensitively behind it. Each test cleans
    // up after itself: the Reads describe shares this database.
    test('a case-slipped account and category still resolve to the real rows', async () => {
      const r = await api.createTransaction(
        { ID: 'ci-1', Date: '2026-08-06', Category: 'expense: food', Account: 'maya',
          Amount: 413.52, Description: 'Foodpanda' }, env);
      assert.strictEqual(r.status, 'success');
      assert.strictEqual(r.transaction.Account, 'Maya', 'the row must carry the canonical name');
      assert.strictEqual(r.transaction.Category, 'Expense: Food');
      await api.deleteTransaction({ ID: 'ci-1' }, env);
    });

    test('both transfer legs resolve, and one account under two spellings is not a transfer', async () => {
      const r = await api.createTransfer(
        { ID: 'ci-2', Date: '2026-08-10', Category: 'INVESTMENT: GROWTH', Account: '  MAYA ',
          ToAccount: 'ibkr', Amount: 5000, ToAmount: 0.2 }, env);
      assert.strictEqual(r.transaction.Account, 'Maya');
      assert.strictEqual(r.transaction.ToAccount, 'IBKR');
      await api.deleteTransaction({ ID: 'ci-2' }, env);
      await assert.rejects(() => api.createTransfer(
        { Date: '2026-08-10', Category: 'Investment: Growth', Account: 'Maya',
          ToAccount: 'maya', Amount: 10 }, env), /must differ/,
        'a self-transfer slipped through under a different spelling');
    });

    test('an account that does not exist is still Unknown, whatever its case', async () => {
      await assert.rejects(() => api.createTransaction(
        { Date: '2026-08-06', Category: 'Expense: Food', Account: 'maribank', Amount: 10 }, env),
        /Unknown Account/);
      await assert.rejects(() => api.createTransaction(
        { Date: '2026-08-06', Category: 'expense: groceries', Account: 'Maya', Amount: 10 }, env),
        /Unknown Category/);
    });

    test('updateTransaction and updateAccount resolve a case-slipped name too', async () => {
      await api.createTransaction({ ID: 'ci-3', Date: '2026-08-06', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: 10 }, env);
      const u = await api.updateTransaction({ ID: 'ci-3', Account: 'card' }, env);
      assert.strictEqual(u.transaction.Account, 'Card');
      await api.deleteTransaction({ ID: 'ci-3' }, env);
      const a = await api.updateAccount({ Name: 'mAyA', Notes: 'resolved by name' }, env);
      assert.strictEqual(a.name, 'Maya', 'the reply must echo the canonical name');
      assert.strictEqual(sqlite.prepare('SELECT notes FROM accounts WHERE id=1').get().notes,
                         'resolved by name', 'updateAccount matched no row');
    });

    test('Period overrides the month the row reports under', async () => {
      await api.createTransaction(
        { ID: 't2', Date: '2026-07-31', Period: '2026-08', Category: 'Income: Salary',
          Account: 'Wise', Amount: 800 }, env);
      const row = sqlite.prepare("SELECT month, date, fx_rate, amount_php_u FROM transactions WHERE id='t2'").get();
      assert.strictEqual(row.month, '2026-Aug');            // reports forward
      assert.strictEqual(row.date, '2026-07-31');           // the cash date stays honest
      assert.strictEqual(row.fx_rate, 50);                  // stamped once, from the FX cache
      assert.strictEqual(row.amount_php_u, 40000000000);    // 800 x 50, ROUNDed then CAST
    });

    test('a non-Transfer category with a destination is refused, and the reverse too', async () => {
      await assert.rejects(() => api.createTransaction(
        { Category: 'Investment: Growth', Account: 'Maya', Amount: 10 }, env), /Transfer category requires/);
      await assert.rejects(() => api.createTransfer(
        { Category: 'Expense: Food', Account: 'Maya', ToAccount: 'IBKR', Amount: 10 }, env), /Only a Transfer category/);
    });

    test('createTransfer moves both sides in one row', async () => {
      const r = await api.createTransfer(
        { ID: 'x1', Date: '2026-08-10', Category: 'Investment: Growth', Account: 'Maya',
          ToAccount: 'IBKR', Amount: 5000, ToAmount: 0.2 }, env);
      assert.strictEqual(r.status, 'success');
      assert.strictEqual(r.transaction.ToAccount, 'IBKR');
      assert.strictEqual(r.transaction.ToAmount, 0.2);      // a fractional share quantity
      assert.strictEqual(r.transaction.ToCurrency, 'SHARES');
    });

    test('updateTransaction mirrors ToAmount on a same-currency transfer', async () => {
      await api.createTransfer({ ID: 'x2', Date: '2026-08-11', Category: 'Investment: Growth',
                                 Account: 'Maya', ToAccount: 'Card', Amount: 100 }, env);
      const r = await api.updateTransaction({ ID: 'x2', Amount: 150 }, env);
      assert.strictEqual(r.transaction.ToAmount, 150, 'the destination kept crediting the old figure');
    });

    test('updateAccount writes only whitelisted fields, in micros', async () => {
      const r = await api.updateAccount({ Name: 'Card', 'Credit Limit': 60000, Notes: 'main card',
                                          Nonsense: 'ignored' }, env);
      assert.strictEqual(r.fieldsWritten, 2);
      const a = sqlite.prepare("SELECT credit_limit_u, notes FROM accounts WHERE name='Card'").get();
      assert.strictEqual(a.credit_limit_u, 60000000000);
      await assert.rejects(() => api.updateAccount({ Name: 'Nope', Notes: 'x' }, env), /Unknown Account/);
    });

    test('a write leaves the row it wrote and nothing else to remember', async () => {
      // Was 'a write bumps the data version'. There is no counter any more (v2.9.0) —
      // the ETag over each read's own bytes is the invalidation, so a write's whole
      // job is the write. The cache consequences are tested at the HTTP layer below.
      await api.createTransaction({ ID: 't3', Date: '2026-08-12', Category: 'Expense: Food',
                                    Account: 'Card', Amount: 1200 }, env);
      assert.strictEqual((await api.listTransactions({ id: 't3' }, env)).total, 1);
    });
  });

  await describe('Reads', () => {
    test('getAccounts: liability sign, available credit, share pricing', async () => {
      const by = Object.fromEntries((await api.getAccounts({}, env)).accounts.map((a) => [a.name, a]));
      // Maya: 1000 start, -250.50 food, -5000 growth, -150 to Card
      assert.strictEqual(by.Maya.balanceNative, 1000 - 250.5 - 5000 - 150);
      assert.strictEqual(by.Maya.balancePhp, by.Maya.balanceNative);
      // Wise: 100 start + 800 salary, in USD, shown at 50
      assert.strictEqual(by.Wise.balanceNative, 900);
      assert.strictEqual(by.Wise.balancePhp, 45000);
      // Card is a liability: 1200 charged, 150 paid in -> 1050 owed, positive as shown
      assert.strictEqual(by.Card.balancePhp, 1050);
      assert.strictEqual(by.Card.netWorthPhp, -1050);
      assert.strictEqual(by.Card.availableCredit, 60000 - 1050);
      // IBKR holds 0.2 shares at $500, at 50 PHP/USD
      assert.strictEqual(by.IBKR.balanceNative, 0.2);
      assert.strictEqual(by.IBKR.balancePhp, 5000);
      assert.ok(by.IBKR.isShares && by.IBKR.isInvestment);
    });

    test('listTransactions: filters, ordering and the total', async () => {
      const all = await api.listTransactions({ limit: 100 }, env);
      assert.strictEqual(all.total, all.transactions.length);
      assert.ok(all.transactions[0].Date >= all.transactions[all.transactions.length - 1].Date, 'not newest-first');
      assert.strictEqual((await api.listTransactions({ month: '2026-Aug', type: 'Expense' }, env)).total, 2);
      assert.strictEqual((await api.listTransactions({ account: 'IBKR' }, env)).total, 1, 'ToAccount must match too');
      assert.strictEqual((await api.listTransactions({ search: 'grocer' }, env)).total, 1);
      assert.strictEqual((await api.listTransactions({ id: 't1' }, env)).total, 1);
      const day = await api.listTransactions({ date: '2026-08-12' }, env);
      assert.ok(day.total > 0 && day.transactions.every((t) => t.Date === '2026-08-12'),
                'the date filter is not one exact day');
    });

    test('listTransactions: amount bounds, source, and the net of the whole set', async () => {
      const aug = await api.listTransactions({ month: '2026-Aug', type: 'Expense', limit: 1 }, env);
      assert.strictEqual(aug.net, -(250.5 + 1200), 'net must cover every row, not the page');
      assert.strictEqual((await api.listTransactions({ month: '2026-Aug', type: 'Expense', minAmount: 1000 }, env)).total, 1);
      assert.strictEqual((await api.listTransactions({ month: '2026-Aug', type: 'Expense', maxAmount: '300' }, env)).total, 1);
      const ids = ['tg-77-0', 'gm-abc-0'];
      await api.createTransaction({ ID: ids[0], Date: '2026-08-13', Category: 'Expense: Food', Account: 'Maya', Amount: 5 }, env);
      await api.createTransaction({ ID: ids[1], Date: '2026-08-13', Category: 'Expense: Food', Account: 'Maya', Amount: -5 }, env);
      try {
        assert.deepStrictEqual((await api.listTransactions({ source: 'tg' }, env)).transactions.map((t) => t.ID), [ids[0]]);
        assert.deepStrictEqual((await api.listTransactions({ source: 'gm' }, env)).transactions.map((t) => t.ID), [ids[1]]);
        const all = (await api.listTransactions({}, env)).total;
        assert.strictEqual((await api.listTransactions({ source: 'legacy' }, env)).total, all - 2);
        // A refund is a negative amount: the bound compares the magnitude.
        assert.ok((await api.listTransactions({ minAmount: 5, maxAmount: 5 }, env)).transactions.some((t) => t.ID === ids[1]));
        await assert.rejects(api.listTransactions({ source: 'fax' }, env), /Unknown source/);
      } finally { for (const ID of ids) await api.deleteTransaction({ ID }, env); }
    });

    test('setSmartLists: validated, capped, echoed in getBootstrap', async () => {
      await assert.rejects(api.setSmartLists({ lists: [{ name: ' ', filters: {} }] }, env), /needs a name/);
      await assert.rejects(api.setSmartLists({ lists: Array(21).fill({ name: 'x' }) }, env), /at most 20/);
      const r = await api.setSmartLists({ lists: [{ name: 'Big food', filters: { category: 'Expense: Food', minAmount: 500, bogus: 'x', search: '' } }] }, env);
      assert.deepStrictEqual(r.smartLists, [{ name: 'Big food', filters: { category: 'Expense: Food', minAmount: '500' } }]);
      assert.deepStrictEqual((await api.getBootstrap({}, env)).smartLists, r.smartLists);
      await api.setSmartLists({ lists: [] }, env);
    });

    test('getBootstrap: quickPicks and descCategory from the last 90 days', async () => {
      const b = await api.getBootstrap({}, env);
      assert.ok(Array.isArray(b.quickPicks) && b.quickPicks.length <= 8);
      b.quickPicks.forEach((p) => assert.ok(p.Description && p.Category && p.Account && p.Amount));
      const ID = 'ui-qp-1';
      await api.createTransaction({ ID, Date: new Date().toISOString().slice(0, 10), Category: 'Expense: Food', Description: 'Zz Vitamins', Account: 'Maya', Amount: 620 }, env);
      try { assert.strictEqual((await api.getBootstrap({}, env)).descCategory['zz vitamins'], 'Expense: Food'); }
      finally { await api.deleteTransaction({ ID }, env); }
    });

    test('getParse: the bot parser, no text never calls Gemini', async () => {
      const real = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        intent: 'log', error: null, query: null,
        items: [{ Date: '2026-08-20', Category: 'Expense: Food', Description: 'Vitamins', Account: 'Maya', Amount: 620 }] }) }] } }] }), { status: 200 }); };
      try {
        assert.deepStrictEqual((await api.getParse({ text: ' ' }, env)).items, []);
        assert.strictEqual(calls, 0);
        const r = await api.getParse({ text: 'vitamins 620 maya' }, Object.assign({}, env, { GEMINI_API_KEY: 'x' }));
        assert.strictEqual(r.items[0].Amount, 620);
        assert.strictEqual(r.error, null);
      } finally { globalThis.fetch = real; }
    });

    test('getBudgets: percent of income, a USD cap at live FX, transfers counted', async () => {
      const b = await api.getBudgets({ month: '2026-Aug' }, env);
      const by = Object.fromEntries(b.budgets.map((x) => [x.segment, x]));
      assert.strictEqual(b.incomePhp, 47200);
      assert.strictEqual(by.Essentials.targetPhp, 23600);        // 50% of 47200
      assert.strictEqual(by.Essentials.actualPhp, 250.5 + 1200);  // both Expense rows
      assert.strictEqual(by.Growth.targetPhp, 5000);             // $100 x 50
      assert.deepStrictEqual(by.Growth.window, ['2026-Jul', '2026-Aug', '2026-Sep']);
      assert.strictEqual(by.Growth.actualPhp, 5000 + 150, 'a Transfer must draw down its segment');
      assert.ok(b.essentialsRewards, 'the roll-up is missing');
    });

    test('getBudgets: a USD budget is measured in dollars, not round-tripped through PHP', async () => {
      const by = Object.fromEntries((await api.getBudgets({ month: '2026-Aug' }, env))
        .budgets.map((x) => [x.segment, x]));
      // The dollar row counts its own $100; the peso row in the same segment is the
      // only part the live rate touches (PHP 150 / 50).
      assert.strictEqual(by.Growth.currency, 'USD');
      assert.strictEqual(by.Growth.targetNative, 100);
      assert.strictEqual(by.Growth.actualNative, 103);
      assert.strictEqual(by.Growth.remainingNative, -3);
      assert.strictEqual(by.Growth.isOver, true);
      assert.strictEqual(by.Growth.pctUsed, 103);
      // A Percent target is a share of PHP income, so it stays in pesos.
      assert.strictEqual(by.Essentials.currency, 'PHP');
      assert.strictEqual(by.Essentials.targetNative, by.Essentials.targetPhp);
      assert.strictEqual(by.Essentials.actualNative, by.Essentials.actualPhp);
    });

    test('a dollar-funded row holds still in a USD budget when the peso moves', async () => {
      // The fixture's Growth rows are all peso-sourced, so add the case this is
      // about: the real Growth budget is funded by a USD->USD transfer.
      await api.createTransfer({ ID: 'usd-growth', Date: '2026-08-12', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'IBKR', Amount: 100, ToAmount: 0.2 }, env);
      try {
        const at = async (rate) => {
          const e = Object.assign({}, env, { FX_CACHE: { get: async () => String(rate), put: async () => {} } });
          return Object.fromEntries((await api.getBudgets({ month: '2026-Aug' }, e))
            .budgets.map((x) => [x.segment, x])).Growth;
        };
        const [a, b2] = [await at(50), await at(70)];
        assert.strictEqual(a.targetNative, 100);
        assert.strictEqual(b2.targetNative, 100, 'the plan is $100 at any rate');
        // The $100 leg counts as $100 at both rates. Only the peso rows reprice:
        // 5150/50 = 103 vs 5150/70 = 73.57.
        assert.strictEqual(a.actualNative, 203);
        assert.ok(Math.abs(b2.actualNative - 173.57) < 0.01, 'got ' + b2.actualNative);
        // The PHP view is unchanged: fx_rate is stamped at write time, so the dollar
        // leg stays at the 50 it was written with whatever the read rate is.
        assert.strictEqual(a.actualPhp, b2.actualPhp);
        assert.strictEqual(a.actualPhp, 5150 + 100 * 50);
        assert.ok(a.targetPhp !== b2.targetPhp, 'the PHP view of the target still follows the rate');
      } finally {
        await api.deleteTransaction({ ID: 'usd-growth' }, env);
      }
    });

    test('getDashboard: aggregates, cash flow window, recent rows', async () => {
      const d = await api.getDashboard({ month: '2026-Aug' }, env);
      assert.strictEqual(d.month, '2026-Aug');
      assert.strictEqual(d.cashflow.length, 6);
      assert.strictEqual(d.cashflow[5].month, '2026-Aug');
      assert.strictEqual(d.cashflow[0].month, '2026-Mar');
      assert.strictEqual(d.cashflow[5].income, 40000);           // the salary, in PHP
      assert.strictEqual(d.cashflow[5].expense, 250.5 + 1200);
      assert.strictEqual(d.spendBySegment.Essentials, 250.5 + 1200);
      assert.ok(d.recentTransactions.length > 0);
      assert.ok(Math.abs(d.netWorth - (d.assets + d.liabilities)) < 0.01, 'liabilities are already negative');
      // The Budgets screen lives here now (v2.14.0), so the Dashboard must carry the
      // whole budgets payload. Drop one of these and the card just stops painting.
      const b = await api.getBudgets({ month: '2026-Aug' }, env);
      assert.deepStrictEqual(d.budgets, b.budgets);
      assert.deepStrictEqual(d.essentialsRewards, b.essentialsRewards);
      assert.strictEqual(d.incomePhp, b.incomePhp);
    });

    test('getDashboard: the FI countdown reads closed months, whatever month is browsed', async () => {
      // Built relative to the wall clock, because the handler is: it always looks at the
      // three months before the LIVE one, so a fixture pinned to 2026-Aug would drop out
      // of the window in December and quietly stop testing anything.
      const ref = dbm.parseMonthKey(dbm.manilaMonth());
      const closed = [1, 2, 3].map((i) => dbm.shiftMonth(ref.y, ref.m, -i));
      const on = (s) => s.y + '-' + String(s.m + 1).padStart(2, '0') + '-05';
      const ids = [];
      sqlite.exec("INSERT INTO nw_snapshots (month,net_worth_u,assets_u,liabilities_u,shares_u,taken_at) " +
        "VALUES ('" + dbm.monthKey(closed[0].y, closed[0].m) + "',500000000000,500000000000,0,0,'x')");
      try {
        for (const m of closed) {
          for (const [id, cat, amt] of [['fi-e-', 'Expense: Food', 20000], ['fi-i-', 'Income: Salary', 45000]]) {
            const ID = id + on(m);
            ids.push(ID);
            await api.createTransaction({ ID, Date: on(m), Category: cat, Account: 'Maya', Amount: amt }, env);
          }
        }
        const f = (await api.getDashboard({}, env)).fire;
        assert.ok(f, 'the FI countdown is missing from getDashboard');
        assert.ok(Math.abs(f.targetPhp - f.monthlyExpensePhp * 12 * 25) < 0.01, '25x annual spend is the target');
        assert.strictEqual(f.withdrawalRatePct, 4);
        assert.ok(f.monthlyExpensePhp >= 20000, 'the three closed months are what it averages');
        assert.ok(f.progressPct >= 0 && f.progressPct <= 100);
        assert.ok(f.days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(f.date), 'a reachable target names a date');

        // The countdown is about NOW. Browsing back a month, or asking for a wider chart,
        // must not re-date the owner's retirement — both would if it read `month`/`months`.
        assert.deepStrictEqual((await api.getDashboard({ month: '2026-Mar', months: 24 }, env)).fire, f);
      } finally {
        sqlite.exec("DELETE FROM nw_snapshots WHERE taken_at = 'x'");
        for (const ID of ids) await api.deleteTransaction({ ID }, env);
      }
    });

    test('getWidget: pinned accounts, a 6-month net worth ending live, 3 recent rows', async () => {
      await assert.rejects(api.setWidgetAccounts({ names: ['a', 'b', 'c', 'd'] }, env), /at most 3/);
      await assert.rejects(api.setWidgetAccounts({ names: ['Nope'] }, env), /Unknown Account/);
      assert.deepStrictEqual((await api.setWidgetAccounts({ names: ['wise'] }, env)).widgetAccounts, ['Wise']);
      const w = await api.getWidget({}, env);
      assert.deepStrictEqual(w.accounts.map((a) => a.name), ['Wise']);
      assert.strictEqual(w.netWorth.length, 6);
      assert.strictEqual(w.netWorth[5].value, (await api.getDashboard({}, env)).netWorth);
      assert.ok(w.recent.length <= 3);
      assert.ok(w.segments.every((b) => ['Essentials', 'Rewards'].includes(b.segment)));
      assert.ok(w.segments.every((b) => typeof b.actualPhp === 'number'));   // the widget's stacked bar
      assert.ok(w.recent.every((t) => 'Segment' in t));                     // the widget's icon tint
      assert.deepStrictEqual((await api.getBootstrap({}, env)).widgetAccounts, ['Wise']);
      await api.setWidgetAccounts({ names: [] }, env);
    });

    test('Glance.summary (service-binding RPC): left, runway and holdings match their screens', async () => {
      const { Glance } = await load('worker.js');
      const g = await new Glance({}, env).summary();
      const inv = await api.getInvestments({}, env), bud = await api.getBudgets({}, env);
      assert.deepStrictEqual(Object.keys(g), ['left', 'runway', 'runwayTarget', 'holdings']);
      assert.strictEqual(g.left, bud.essentialsRewards.remainingPhp);
      assert.strictEqual(g.runway, inv.runway.months);
      assert.strictEqual(g.runwayTarget, 4);
      assert.deepStrictEqual(g.holdings, inv.positions.map((p) => ({ ticker: p.name, subtype: p.subtype, quantity: p.quantity })));
      assert.ok(g.holdings.length > 0);
    });

    test('getDashboard: the chart window is client-chosen and clamped', async () => {
      const wide = await api.getDashboard({ month: '2026-Aug', months: 12 }, env);
      assert.strictEqual(wide.cashflow.length, 12);
      assert.strictEqual(wide.cashflow[11].month, '2026-Aug');
      assert.strictEqual(wide.cashflow[0].month, '2025-Sep');
      // Junk falls back to 6; anything out of range is clamped, never trusted into the SQL.
      assert.strictEqual((await api.getDashboard({ month: '2026-Aug', months: 'x' }, env)).cashflow.length, 6);
      assert.strictEqual((await api.getDashboard({ month: '2026-Aug', months: 999 }, env)).cashflow.length, 24);
      // The bridge needs the previous month in the window, so 1 clamps up to 2.
      assert.strictEqual((await api.getDashboard({ month: '2026-Aug', months: 1 }, env)).cashflow.length, 2);
    });

    test('snapshotNetWorth records this month; getDashboard serves the history', async () => {
      const snap = await api.snapshotNetWorth(env);
      const now = dbm.manilaMonth();
      // Yesterday's month, not today's: a 06:00 run on the last day of a month would
      // otherwise close that month without its last day in it. Same month except on the 1st.
      assert.strictEqual(snap.month, dbm.monthOf(dbm.manilaYesterday()));
      const dash = await api.getDashboard({}, env);
      assert.ok(Math.abs(snap.netWorth - dash.netWorth) < 0.01, 'snapshot equals the live net worth');
      // The live month is deliberately absent — the chart uses live netWorth there.
      assert.ok(!(now in dash.netWorthHistory), 'live month is excluded from netWorthHistory');
      // A closed month's snapshot IS served (123 PHP = 123_000_000 micros).
      const past = now === '2026-Jul' ? '2026-Jun' : '2026-Jul';
      sqlite.exec("INSERT INTO nw_snapshots (month,net_worth_u,assets_u,liabilities_u,shares_u,taken_at) VALUES ('" +
        past + "',123000000,123000000,0,45000000,'2026-01-01T00:00:00Z')");
      const d2 = await api.getDashboard({ month: '2026-Aug' }, env);
      assert.strictEqual(d2.netWorthHistory[past], 123, 'past snapshot appears in history');
      assert.strictEqual(d2.sharesHistory[past], 45, 'the invested subset ships alongside for the liquid/stacked split');
    });

    test('getBootstrap hydrates everything the app needs', async () => {
      const b = await api.getBootstrap({}, env);
      ['owner', 'baseCurrency', 'categories', 'accounts', 'budgets', 'recurring', 'fxUsdPhp', 'minMonth']
        .forEach((k) => assert.ok(k in b, 'missing ' + k));
      assert.ok(!('version' in b), 'the data version is back in the bootstrap payload');
      assert.strictEqual(b.minMonth, '2026-Jul');
      assert.strictEqual(b.recurring[0].Description, 'Internet');
      assert.strictEqual(b.recurring[0].Amount, 1699);
      assert.strictEqual(b.categories['Expense: Food'].Segment, 'Essentials');
    });

    test('getInvestments: quarterly pulse groups buys, runway is the cash-like pool', async () => {
      // A USD buy in an older quarter, next to fixture x1 (2026-08-10 Maya->IBKR).
      await api.createTransfer({ ID: 'x3', Date: '2026-04-05', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'IBKR', Amount: 100, ToAmount: 0.05 }, env);
      // An expense in the last closed month, so the runway average is deterministic.
      const now = dbm.parseMonthKey(dbm.manilaMonth());
      const prev = dbm.shiftMonth(now.y, now.m, -1);
      await api.createTransaction({ ID: 't-rw', Date: prev.y + '-' + String(prev.m).padStart(2, '0') + '-15',
                                    Category: 'Expense: Food', Account: 'Maya', Amount: 300 }, env);

      const inv = await api.getInvestments({}, env);
      assert.match(inv.pulse.currentQuarter, /^\d{4}-Q[1-4]$/);
      const q = Object.fromEntries(inv.pulse.quarters.map((x) => [x.quarter, x]));
      assert.ok(q['2026-Q3'] && q['2026-Q3'].buys.some((b) => b.symbol === 'IBKR' && b.amount === 5000 && b.currency === 'PHP'));
      assert.strictEqual(q['2026-Q2'].totalUsd, 100, 'USD buys total per quarter');
      assert.strictEqual(q['2026-Q2'].buys[0].quantity, 0.05);
      assert.ok(inv.pulse.quarters[0].quarter > inv.pulse.quarters[inv.pulse.quarters.length - 1].quarter, 'newest first');

      // Runway: Maya + Wise count, IBKR (invested) is excluded, Card is subtracted.
      const by = Object.fromEntries((await api.getAccounts({}, env)).accounts.map((a) => [a.name, a]));
      const expected = Math.round((by.Maya.balancePhp + by.Wise.balancePhp - by.Card.balancePhp) * 100) / 100;
      assert.strictEqual(inv.runway.efPhp, expected);
      // The parts are what the Summary tooltip lists, so they must add up to the pool.
      const p = inv.runway.parts;
      assert.strictEqual(p.creditPhp, -by.Card.balancePhp);
      assert.strictEqual(dbm.q2(p.cashPhp + p.efSharesPhp + p.creditPhp + p.owedPhp), expected);
      // The average window is the last THREE CLOSED months and the fixture's dates are
      // absolute, so which fixture rows sit inside it moves with the real calendar. A
      // hard-coded 300/3 went red on its own on 2026-09-01, when July and August rolled
      // into the window. Sum the same window here instead: the figure has no shelf life
      // and the assertion still says what it always said.
      const win = [3, 2, 1].map((i) => {
        const w = dbm.shiftMonth(now.y, now.m, -i); return dbm.monthKey(w.y, w.m);
      });
      const spent = dbm.fromU(sqlite.prepare(
        "SELECT SUM(t.amount_php_u) AS s FROM transactions t JOIN categories c ON c.id = t.category_id " +
        "WHERE c.type = 'Expense' AND t.month IN (?,?,?)").get(...win).s || 0);
      const avg = dbm.q2(spent / win.length);
      assert.ok(spent >= 300, 't-rw fell outside the window the runway averages');
      assert.strictEqual(inv.runway.avgMonthlyExpensePhp, avg);
      assert.strictEqual(inv.runway.targetPhp, dbm.q2(avg * 4));
      assert.strictEqual(inv.runway.months, Math.round(expected / avg * 10) / 10);
      // Sums to 85, not 100: Stability came out in v2.3.0 and the missing 15 is the EF
      // residue the runway card measures instead. The assertion is the guard against it
      // being "fixed" back to 100 or the dead segment creeping in again.
      assert.deepStrictEqual(inv.segmentTargets, { Essentials: 50, Rewards: 10, Growth: 25 });
    });
  });

  await describe('Ledger (Tax screen)', () => {
    // The Tax screen writes through the ADMIN grid's three routes (v3.2.0) — `ledger`
    // was always a TABLES entry, so the three ledger-only write handlers it used to
    // have were a second copy of them. getLedger hands the client `table`/`pk`/`edit`,
    // the header -> column map, which is the one thing it cannot derive.
    const addLedger = (row) => api.insertTableRow({ table: 'ledger', row }, env);
    const setLedger = (pk, column, value) =>
      api.updateTableCell({ table: 'ledger', pk, column, value }, env);

    test('getLedger hands the client what it needs to write through the grid', async () => {
      const l = await api.getLedger({}, env);
      assert.strictEqual(l.table, 'ledger');
      assert.strictEqual(l.pk, 'id');
      assert.strictEqual(l.edit['BSP Reference Rate'], 'bsp_rate');
      l.derived.forEach((h) => assert.ok(!(h in l.edit), h + ' is derived but offered as editable'));
    });

    test('the ledger view derives from the linked transaction', async () => {
      const added = await addLedger({ tx_id: 't2' });
      await setLedger(added.pk, 'bsp_rate', '56.5');
      const l = await api.getLedger({}, env);
      const row = l.rows.find((r) => r.__row === added.pk);
      assert.strictEqual(row['Date Received'], '2026-07-31');
      assert.strictEqual(row['Reporting Period'], '2026-Aug');   // the derived month, not the raw Period
      assert.strictEqual(row['Wise Amount'], 800);
      assert.strictEqual(row['Total Income'], 45200);            // 800 x 56.5
      assert.strictEqual(row['8% Tax'], 3616);
      assert.deepStrictEqual(l.derived.includes('Total Income'), true);
      assert.strictEqual(l.unlinked.length, 0, 'the salary is linked now');
    });

    test('a derived ledger column cannot be edited', async () => {
      await assert.rejects(() => setLedger(1, 'total_income_u', 1), /not editable on ledger/);
    });

    /* A REAL column reached through the grid arrives as a typed STRING. SQLite's REAL
     * affinity converts "56.5" but NOT "1,056.5" — a thousands separator silently
     * lands TEXT in a numeric column, which then reads as 0 in every sum downstream.
     * TABLES.num is what strips it; only declared-numeric columns are touched. */
    test('a numeric grid column takes a typed thousands separator', async () => {
      const added = await addLedger({ tx_id: 't2' });
      await setLedger(added.pk, 'bsp_rate', '1,056.5');
      const back = await env.DB.prepare('SELECT bsp_rate FROM ledger WHERE id = ?').bind(added.pk).first();
      assert.strictEqual(back.bsp_rate, 1056.5);
      assert.strictEqual(typeof back.bsp_rate, 'number', 'a comma left the rate as TEXT');
      await assert.rejects(() => setLedger(added.pk, 'bsp_rate', 'fifty'), /must be a number/);
      await api.deleteTableRow({ table: 'ledger', pk: added.pk }, env);
    });

    test('deleting the transaction leaves a warning row, not a broken delete', async () => {
      await api.deleteTransaction({ ID: 't2' }, env);
      const row = (await api.getLedger({}, env)).rows[0];
      assert.strictEqual(row['Date Received'], '⚠ transaction deleted');
      await api.deleteTableRow({ table: 'ledger', pk: row.__row }, env);
      assert.strictEqual((await api.getLedger({}, env)).rows.length, 0);
    });

    // The payload is one tax year wide, because the ledger only ever grows and BIR
    // files per year. The date-less row is the case that must survive the filter: it
    // is a link to a deleted transaction, and a year must never be the reason a broken
    // row goes quiet.
    test('getLedger returns one year, and always the date-less rows', async () => {
      await api.createTransaction({ ID: 't-2024', Date: '2024-03-15', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: 100 }, env);
      const old24 = (await addLedger({ tx_id: 't-2024' })).pk;
      const orphan = (await addLedger({ tx_id: 'no-such-tx' })).pk;

      const y24 = await api.getLedger({ year: '2024' }, env);
      assert.deepStrictEqual(y24.rows.map((r) => r.__row).sort(), [old24, orphan].sort());
      assert.strictEqual(y24.year, '2024');

      const y25 = await api.getLedger({ year: '2025' }, env);
      assert.deepStrictEqual(y25.rows.map((r) => r.__row), [orphan], 'only the broken row crosses years');

      assert.ok(y24.years.includes('2024'), 'the picker is drawn from the years present');
      assert.strictEqual((await api.getLedger({}, env)).year, dbm.manilaToday().slice(0, 4),
        'no year argument means this year, in Manila');
    });
  });

  await describe('Admin grid and export', () => {
    test('listTable converts micros and reports what is editable', async () => {
      const t = await api.listTable({ table: 'accounts' }, env);
      assert.strictEqual(t.rows.find((r) => r.name === 'Card').credit_limit_u, 60000);
      assert.ok(t.editable.includes('color'));
      assert.ok(t.money.includes('starting_balance_u'));
    });

    // The Admin picker draws its buttons from this list, so it is the whole set or the
    // screen loses a table. Every name must survive a round trip back through listTable —
    // a typo here would ship a button that answers "Unknown table" when pressed.
    test('listTable ships the table list the Admin picker is drawn from', async () => {
      const t = await api.listTable({ table: 'accounts' }, env);
      assert.ok(Array.isArray(t.tables) && t.tables.length > 1);
      assert.strictEqual(t.tables[0], 'accounts', 'the landing table must be first');
      for (const name of t.tables) {
        assert.strictEqual((await api.listTable({ table: name }, env)).table, name);
      }
    });

    test('the whitelist is a real boundary', async () => {
      await assert.rejects(() => api.listTable({ table: 'sqlite_master' }, env), /Unknown table/);
      await assert.rejects(() => api.updateTableCell(
        { table: 'transactions', pk: 't1', column: 'amount_u', value: 1 }, env), /not editable/);
      await assert.rejects(() => api.insertTableRow({ table: 'transactions', row: { id: 'z' } }, env), /read-only/);
      // nw_snapshots is fully read-only: no insert, no delete, money cols reported as PHP.
      const nw = await api.listTable({ table: 'nw_snapshots' }, env);
      assert.strictEqual(nw.deletable, false);
      assert.deepStrictEqual(nw.editable, []);
      await assert.rejects(() => api.insertTableRow({ table: 'nw_snapshots', row: { month: 'x' } }, env), /read-only/);
      await assert.rejects(() => api.deleteTableRow({ table: 'nw_snapshots', pk: '2026-Aug' }, env), /read-only/);
    });

    test('updateTableCell and insertTableRow round-trip through micros', async () => {
      await api.updateTableCell({ table: 'accounts', pk: 1, column: 'starting_balance_u', value: '2000' }, env);
      assert.strictEqual(sqlite.prepare('SELECT starting_balance_u u FROM accounts WHERE id=1').get().u, 2000000000);
      const ins = await api.insertTableRow({ table: 'categories', row: { name: 'Expense: Fun', type: 'Expense', segment: 'Rewards' } }, env);
      assert.ok(ins.pk);
      await api.deleteTableRow({ table: 'categories', pk: ins.pk }, env);
    });

    test('getExportAll dumps every whitelisted table', async () => {
      const e = await api.getExportAll({}, env);
      ['accounts', 'categories', 'transactions', 'ledger', 'meta', 'prices'].forEach((t) =>
        assert.ok(Array.isArray(e.tables[t]), 'missing table ' + t));
      assert.ok(e.exportedAt);
    });
  });

  await describe('Bulk', () => {
    test('bulk update and delete report what they skipped', async () => {
      const u = await api.bulkUpdateTransactions(
        { ids: ['t1', 'nope'], patch: { Category: 'Expense: Food', Description: 'bulk' } }, env);
      assert.strictEqual(u.updated, 1);
      assert.deepStrictEqual(u.skipped, ['nope']);
      const d = await api.bulkDeleteTransactions({ ids: ['t3', 'nope'] }, env);
      assert.strictEqual(d.deleted, 1);
      assert.deepStrictEqual(d.skipped, ['nope']);
    });

    test('a bulk patch resolves a case-slipped name before it writes', async () => {
      await api.createTransaction({ ID: 'ci-4', Date: '2026-08-06', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: 12 }, env);
      const u = await api.bulkUpdateTransactions({ ids: ['ci-4'], patch: { Account: 'CARD' } }, env);
      assert.strictEqual(u.updated, 1);
      assert.strictEqual((await api.listTransactions({ id: 'ci-4' }, env)).transactions[0].Account, 'Card');
      await api.deleteTransaction({ ID: 'ci-4' }, env);
    });

    test('the other whitelist shapes work too (composite and text primary keys)', async () => {
      const p = await api.listTable({ table: 'prices' }, env);
      assert.ok(p.rows[0].rowid, 'prices needs a rowid handle — its key is composite');
      const m = await api.listTable({ table: 'meta' }, env);
      assert.ok(m.rows.some((r) => r.key === 'monthly_income_php'));
      await api.updateTableCell({ table: 'meta', pk: 'monthly_income_php', column: 'value', value: '50000' }, env);
      assert.strictEqual((await api.getBudgets({ month: '2026-Aug' }, env)).incomePhp, 50000);
      // transactions is read + delete: the escape hatch for a row the UI cannot reach.
      await api.deleteTableRow({ table: 'transactions', pk: 'x2' }, env);
      assert.strictEqual((await api.listTransactions({ id: 'x2' }, env)).total, 0);
    });
  });

  // The Worker's own fetch(): auth, the GET/POST split, and the error shape. Driven with
  // real Request objects, because the dispatch is the one place a route can go missing.
  const worker = (await load('worker.js')).default;
  const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const wenv = Object.assign({}, env, { APP_PASS: 'pw', INGEST_TOKEN: 'tok', AI_READ_TOKEN: 'ai' });
  const ctx = { waitUntil: () => {} };
  const call = async (url, init = {}) => {
    const res = await worker.fetch(new Request('https://x' + url, init), wenv, ctx);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // ── the accounting-soundness release (v2.5.0) ──────────────────────────────
  // Appended last on purpose: these tests add accounts and rows, and every figure
  // asserted above is exact.
  await describe('Accounting conventions', () => {
    test('a refund is a negative expense and NETS its category down', async () => {
      // Was the worst of the reporting bugs: ABS() made a refund ADD to spending, so
      // the one real refund had to be mis-logged as income, overstating both sides.
      await api.createTransaction({ ID: 'rf-1', Date: '2026-02-10', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: 500 }, env);
      await api.createTransaction({ ID: 'rf-2', Date: '2026-02-12', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: -200, Description: 'refund' }, env);
      const d = await api.getDashboard({ month: '2026-Feb' }, env);
      assert.strictEqual(d.spendByCategory['Expense: Food'], 300);
      assert.strictEqual(d.spendBySegment.Essentials, 300);
      assert.strictEqual(d.cashflow[5].expense, 300);
      const b = await api.getBudgets({ month: '2026-Feb' }, env);
      assert.strictEqual(b.budgets.find((x) => x.segment === 'Essentials').actualPhp, 300);
    });

    test('a zero amount is refused on every write path', async () => {
      const base = { Date: '2026-02-14', Category: 'Expense: Food', Account: 'Maya' };
      await assert.rejects(api.createTransaction(Object.assign({ ID: 'z1', Amount: 0 }, base), env), /must not be zero/);
      // Rounds to zero in micros — the same test the DB CHECK will make in Release 2.
      await assert.rejects(api.createTransaction(Object.assign({ ID: 'z2', Amount: 0.0000001 }, base), env), /must not be zero/);
      await assert.rejects(api.createTransfer({ ID: 'z3', Date: '2026-02-14', Category: 'Investment: Growth',
                                                Account: 'Maya', ToAccount: 'IBKR', Amount: 100, ToAmount: 0 }, env),
                           /ToAmount must not be zero/);
      await assert.rejects(api.updateTransaction({ ID: 'rf-1', Amount: 0 }, env), /must not be zero/);
      await assert.rejects(api.bulkUpdateTransactions({ ids: ['rf-1'], patch: { Amount: 0 } }, env), /must not be zero/);
    });

    test('a transfer that lands in pesos stamps the rate it actually realised', async () => {
      // 100 USD out, 5600 PHP in = 56.00, whatever the live rate says (the shim's is 50).
      // Stamping the live rate is what made the conversion spread disappear.
      const r = await api.createTransfer({ ID: 'fx-1', Date: '2026-02-20', Category: 'Investment: Growth',
                                           Account: 'Wise', ToAccount: 'Maya', Amount: 100, ToAmount: 5600 }, env);
      assert.strictEqual(r.transaction.ExchangeRate, 56);
      assert.strictEqual(r.transaction['Amount (PHP)'], 5600, 'the source leg is valued at what arrived');
      // An explicit override still wins.
      const r2 = await api.createTransfer({ ID: 'fx-2', Date: '2026-02-21', Category: 'Investment: Growth',
                                            Account: 'Wise', ToAccount: 'Maya', Amount: 100, ToAmount: 5600,
                                            ExchangeRate: 57 }, env);
      assert.strictEqual(r2.transaction.ExchangeRate, 57);
      // A Shares destination is a QUANTITY, not money: it must keep the live rate.
      const r3 = await api.createTransfer({ ID: 'fx-3', Date: '2026-02-22', Category: 'Investment: Growth',
                                            Account: 'Wise', ToAccount: 'IBKR', Amount: 100, ToAmount: 0.05 }, env);
      assert.strictEqual(r3.transaction['Amount (PHP)'], 5000, 'live rate, not quantity/amount');
      // A PHP SOURCE needs no rate whatever the destination is: fx_rate converts the
      // source leg, and pesos are already pesos. Implied would be nonsense here.
      const r4 = await api.createTransfer({ ID: 'fx-4', Date: '2026-02-23', Category: 'Investment: Growth',
                                            Account: 'Maya', ToAccount: 'Wise', Amount: 100, ToAmount: 1.8 }, env);
      assert.strictEqual(r4.transaction['Amount (PHP)'], 100);
      assert.strictEqual(r4.transaction.ExchangeRate, '');
    });

    test('a same-day, same-amount twin warns instead of blocking', async () => {
      await api.createTransaction({ ID: 'dup-1', Date: '2026-02-25', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: 214.29 }, env);
      const second = await api.createTransaction({ ID: 'dup-2', Date: '2026-02-25', Category: 'Expense: Food',
                                                   Account: 'Maya', Amount: 214.29 }, env);
      assert.strictEqual(second.status, 'success', 'advisory only — a real repeat must still land');
      assert.match(second.warning, /Similar transaction exists \(dup-1\)/);
    });

    test('a negative receivable is a liability, not a smaller asset', async () => {
      // Money the owner OWES sitting in an Asset subtype: it deflated the asset total
      // instead of showing as debt, and the runway skipped it entirely.
      sqlite.exec("INSERT INTO account_types (subtype, type) VALUES ('Receivable','Asset');" +
        "INSERT INTO accounts (id,name,currency,subtype,starting_balance_u) VALUES " +
        "(5,'Mommy','PHP','Receivable',-1000000000),(6,'Lent','PHP','Receivable',2000000000);");
      // A real card charge too, so the sign of a genuine liability is pinned here.
      await api.createTransaction({ ID: 'lb-1', Date: '2026-02-27', Category: 'Expense: Food',
                                    Account: 'Card', Amount: 500 }, env);
      const { accounts } = await api.getAccounts({}, env);
      const by = Object.fromEntries(accounts.map((a) => [a.name, a]));
      const t = api.netWorthTotals(accounts);
      assert.strictEqual(by.Mommy.isLiability, false, 'still an Asset account — the SIGN reclassifies it');
      assert.strictEqual(by.Card.netWorthPhp, -500);
      assert.strictEqual(t.liabilities, by.Card.netWorthPhp + by.Mommy.netWorthPhp,
        'the negative receivable joins the card in liabilities');
      assert.strictEqual(t.assets, by.Maya.netWorthPhp + by.Wise.netWorthPhp + by.IBKR.netWorthPhp + by.Lent.netWorthPhp,
        'and is out of assets, while the POSITIVE receivable stays in');
      const d = await api.getDashboard({}, env);
      assert.ok(d.liabilities < 0, 'liabilities are stored and reported NEGATIVE, never absoluted');
      assert.ok(Math.abs(d.netWorth - (d.assets + d.liabilities)) < 0.01);

      // Runway: the debt shortens it; the 2000 lent out does not lengthen it.
      const inv = await api.getInvestments({}, env);
      const expected = Math.round((by.Maya.balancePhp + by.Wise.balancePhp - by.Card.balancePhp - 1000) * 100) / 100;
      assert.strictEqual(inv.runway.efPhp, expected);
    });

    test('the admin grid refuses to rewrite the meaning of existing rows', async () => {
      // Each of these silently reprices or re-signs history: an Asset/Liability flip
      // inverts every past delta, a currency change reprices fx-NULL rows, a category
      // type flip breaks the Transfer<->ToAccount invariant.
      await assert.rejects(api.updateTableCell({ table: 'categories', pk: 2, column: 'type', value: 'Income' }, env),
                           /frozen/);
      await assert.rejects(api.updateTableCell({ table: 'accounts', pk: 1, column: 'currency', value: 'USD' }, env),
                           /frozen/);
      await assert.rejects(api.updateTableCell({ table: 'accounts', pk: 1, column: 'subtype', value: 'Credit' }, env),
                           /frozen/);
      await assert.rejects(api.updateTableCell({ table: 'account_types', pk: 'Savings', column: 'type', value: 'Liability' }, env),
                           /frozen/);
      // An account nothing references yet is still editable — the guard is about
      // history, not about the column.
      const ok = await api.updateTableCell({ table: 'accounts', pk: 6, column: 'subtype', value: 'Savings' }, env);
      assert.strictEqual(ok.status, 'success');
      // And a plain rename is never frozen.
      assert.strictEqual((await api.updateTableCell({ table: 'accounts', pk: 1, column: 'name', value: 'Maya' }, env)).status, 'success');
    });
  });

  await describe('Schema invariants (migration 0003)', () => {
    // The handlers already refuse these shapes; these tests prove the DATABASE does
    // too, so a wrangler d1 execute or a future write path cannot corrupt silently.
    const raw = (sql) => () => sqlite.exec(sql);
    const cols = '(id,date,category_id,account_id,amount_u,fx_rate,to_account_id,to_amount_u)';
    const ins = (id, vals) => `INSERT INTO transactions ${cols} VALUES ('${id}',${vals});`;

    test('a zero amount cannot be written at all', () => {
      assert.throws(raw(ins('ck-zero', "'2026-03-01',2,1,0,NULL,NULL,NULL")), /CHECK constraint failed/);
    });

    test('half a transfer cannot be written', () => {
      assert.throws(raw(ins('ck-half-a', "'2026-03-01',3,1,1000000,NULL,2,NULL")), /CHECK constraint failed/);
      assert.throws(raw(ins('ck-half-b', "'2026-03-01',3,1,1000000,NULL,NULL,1000000")), /CHECK constraint failed/);
    });

    test('a non-positive fx_rate cannot be written', () => {
      assert.throws(raw(ins('ck-fx0',  "'2026-03-01',2,2,1000000,0,NULL,NULL")),  /CHECK constraint failed/);
      assert.throws(raw(ins('ck-fxneg', "'2026-03-01',2,2,1000000,-50,NULL,NULL")), /CHECK constraint failed/);
    });

    test('an impossible month or day cannot be written', () => {
      // 2026-13-45 passed the GLOB alone — the shape was right, the date was not.
      assert.throws(raw(ins('ck-m13', "'2026-13-01',2,1,1000000,NULL,NULL,NULL")), /CHECK constraint failed/);
      assert.throws(raw(ins('ck-d45', "'2026-03-45',2,1,1000000,NULL,NULL,NULL")), /CHECK constraint failed/);
    });

    test('the legitimate shapes still pass — negative amounts, PHP rows, transfers', () => {
      sqlite.exec(ins('ck-ok-refund', "'2026-03-02',2,1,-9500000,NULL,NULL,NULL"));
      sqlite.exec(ins('ck-ok-transfer', "'2026-03-03',3,2,1000000,50,1,50000000"));
      const rows = sqlite.prepare("SELECT id,month,amount_php_u FROM transactions WHERE id LIKE 'ck-ok-%' ORDER BY id").all();
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].month, '2026-Mar');            // generated columns survived the recreate
      assert.strictEqual(rows[0].amount_php_u, -9500000);       // ROUND-before-CAST, still signed
      assert.strictEqual(rows[1].amount_php_u, 50000000);
      sqlite.exec("DELETE FROM transactions WHERE id LIKE 'ck-ok-%';");
    });
  });

  await describe('The IBKR prices job', () => {
    // A real fetch is the only thing stubbed. The statement is parsed for real and the
    // rows land in the real prices table, so this covers the SQL as well as the
    // orchestration. Pace is zeroed — the point is the sequence, not the 50s of sleeps.
    const jobs = jobsMod;
    const PACE = { first: 0, wait: 0, tries: 6, retryTries: 2 };
    const jobEnv = { DB: env.DB, IBKR_FLEX_TOKEN: '253000000000000000000640', IBKR_FLEX_QUERY_ID: '987654321' };
    const GET = 'https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
    const sendOk = (ref) => '<FlexStatementResponse><Status>Success</Status>' +
      '<ReferenceCode>' + ref + '</ReferenceCode><Url>' + GET + '</Url></FlexStatementResponse>';
    const err = (code, msg) => '<FlexStatementResponse><Status>Fail</Status><ErrorCode>' + code +
      '</ErrorCode><ErrorMessage>' + msg + '</ErrorMessage></FlexStatementResponse>';
    const statement = '<FlexQueryResponse><FlexStatement fromDate="20260828" toDate="20260828">' +
      '<OpenPositions><OpenPosition symbol="VWRA" position="12.5" markPrice="122.4" currency="USD" />' +
      '</OpenPositions></FlexStatement></FlexQueryResponse>';

    // Each case is a script: a function of the request URL returning the body to answer,
    // or {status, body} when the case is about the HTTP status rather than the XML.
    const withFetch = async (reply, fn) => {
      const real = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (u) => {
        calls.push(String(u));
        const r = reply(String(u), calls.length);
        const { status = 200, body = r } = typeof r === 'string' ? {} : r;
        return { status, text: async () => body };
      };
      try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
    };
    const isSend = (u) => u.includes('/SendRequest');
    const refOf = (u) => (/[?&]q=(\d+)/.exec(u) || [])[1];

    test('the happy path sends once and writes the statement it gets', async () => {
      const { out, calls } = await withFetch(
        (u) => isSend(u) ? sendOk('5761631802') : statement,
        () => jobs.pricesJob(jobEnv, PACE));
      assert.strictEqual(out.written, 1);
      assert.strictEqual(out.pricedAt, '2026-08-28');
      assert.strictEqual(calls.filter(isSend).length, 1, 'one SendRequest is enough when the statement is ready');
      const row = sqlite.prepare("SELECT * FROM prices WHERE symbol='VWRA' AND priced_at='2026-08-28'").get();
      assert.strictEqual(row.price, 122.4);
      assert.strictEqual(row.currency, 'USD');
    });

    test('the statement is reconciled against the ledger share count', async () => {
      // The fixture's IBKR account holds shares and the statement names only VWRA, so
      // the happy path above already produced a drift row. It is the ledger-only shape:
      // a holding IBKR does not report is either a corporate action or an unlogged trade.
      const { out } = await withFetch((u) => isSend(u) ? sendOk('7777777777') : statement,
        () => jobs.pricesJob(jobEnv, PACE));
      const ibkr = out.drift.find((d) => d.symbol === 'IBKR');
      assert.ok(ibkr, 'a share account absent from the statement was not reported');
      assert.strictEqual(ibkr.ibkr, 0, 'no open position means zero shares, not "unknown"');
      assert.ok(ibkr.ledger > 0);
    });

    test('quantityDrift: a split shows, a closed holding and an exact match do not', async () => {
      // Its own database: these accounts must not leak into the Holdings and net-worth
      // assertions further down the file.
      const fresh = new DatabaseSync(':memory:');
      const dir = path.join(__dirname, 'worker', 'migrations');
      fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
        .forEach((f) => fresh.exec(fs.readFileSync(path.join(dir, f), 'utf8')));
      // SPLIT is the APH case reduced: 5 in the ledger, 10 at IBKR after a 2:1.
      // CLOSED is zero on both sides and must stay quiet — every sold-out ticker is
      // absent from the statement, and alerting on those is an alert nobody reads.
      // MATCH is the fractional-share case the epsilon exists for.
      // CASH is not share-priced and is never walked at all.
      fresh.exec("INSERT INTO account_types (subtype,type) VALUES ('Shares','Asset'),('Savings','Asset');" +
        "INSERT INTO accounts (id,name,currency,subtype,symbol,starting_balance_u) VALUES " +
        "(30,'SPLIT','Shares','Shares','SPLIT',5000000),(31,'CLOSED','Shares','Shares','CLOSED',0)," +
        "(32,'MATCH','Shares','Shares','MATCH',4276000),(33,'Maya','PHP','Savings',NULL,1000000000);");
      const drift = await jobs.quantityDrift({ DB: d1(fresh) }, [
        { symbol: 'SPLIT', position: 10 }, { symbol: 'MATCH', position: 4.276 },
        { symbol: 'VWRA', position: 12.5 }
      ]);
      assert.deepStrictEqual(drift, [{ symbol: 'SPLIT', ledger: 5, ibkr: 10 }]);
    });

    test('a reference code that keeps drawing 1020 is REPLACED, not replayed', async () => {
      // The 2026-08-31 failure. v2.8.2 polled the same code six times and gave up; the
      // one thing that could not have helped. The second code must be a NEW one.
      let sends = 0;
      const { out, calls } = await withFetch((u) => {
        if (isSend(u)) return sendOk(++sends === 1 ? '1111111111' : '2222222222');
        return refOf(u) === '1111111111' ? err('1020', 'Invalid request or unable to validate request.') : statement;
      }, () => jobs.pricesJob(jobEnv, PACE));
      assert.strictEqual(out.written, 1);
      assert.strictEqual(calls.filter(isSend).length, 2, 'the job never asked for a fresh reference code');
      assert.ok(calls.some((u) => refOf(u) === '2222222222'), 'the retry reused the stale code');
      // Bounded: one send + 6 polls, then one send + at most 2 polls. IBKR allows ten
      // requests per minute per token and a breach is its own failure (1018).
      assert.ok(calls.length <= 10, 'the recovery path makes ' + calls.length + ' calls, over IBKR\'s 10/min');
    });

    test('1017 gets a fresh code immediately, without polling a code IBKR already refused', async () => {
      let sends = 0;
      const { out, calls } = await withFetch((u) => {
        if (isSend(u)) return sendOk(++sends === 1 ? '3333333333' : '4444444444');
        return refOf(u) === '3333333333' ? err('1017', 'Reference code is invalid.') : statement;
      }, () => jobs.pricesJob(jobEnv, PACE));
      assert.strictEqual(out.written, 1);
      assert.strictEqual(calls.filter((u) => !isSend(u) && refOf(u) === '3333333333').length, 1,
        '1017 says the code is dead — polling it again is wasted budget');
    });

    test('a code that needs a person fails fast, with the repair, and never re-sends', async () => {
      const { calls } = await withFetch((u) => isSend(u) ? sendOk('5555555555') : err('1012', 'Token has expired.'),
        async () => { await assert.rejects(() => jobs.pricesJob(jobEnv, PACE),
          /1012.*Token has expired.*Make a new Flex token/s); });
      assert.strictEqual(calls.filter(isSend).length, 1, 'an expired token is not fixed by a second reference code');
      assert.strictEqual(calls.length, 2, 'a fatal code must not be polled');
    });

    test('a 403 with no error code is a shut door: one fresh request, not five more polls', async () => {
      // The 2026-09-13 failure. Six polls all answered 403 with the plain-text body
      // "error code: 1000" — an edge error page, not IBKR, which answers 200 with XML
      // even to refuse. The job spent its whole budget on a request that never landed
      // and never pulled the one lever it has.
      let sends = 0;
      const { out, calls } = await withFetch((u) => {
        if (isSend(u)) return sendOk(++sends === 1 ? '8888888888' : '9999999999');
        return refOf(u) === '8888888888' ? { status: 403, body: 'error code: 1000' } : statement;
      }, () => jobs.pricesJob(jobEnv, PACE));
      assert.strictEqual(out.written, 1, 'the fresh request never happened');
      assert.strictEqual(calls.filter((u) => !isSend(u) && refOf(u) === '8888888888').length, 1,
        'a blocked poll must stop at once, not spend the patience budget');
    });

    test('a block that does not clear says so, instead of blaming a slow statement', async () => {
      await withFetch((u) => isSend(u) ? sendOk('1010101010') : { status: 403, body: 'error code: 1000' },
        async () => { await assert.rejects(() => jobs.pricesJob(jobEnv, PACE),
          /blocked before IBKR answered.*403 error code: 1000/s); });
    });

    test('two dead reference codes report the last reply, not a bare "not ready"', async () => {
      await withFetch((u) => isSend(u) ? sendOk('6666666666') : err('1020', 'Invalid request or unable to validate request.'),
        async () => { await assert.rejects(() => jobs.pricesJob(jobEnv, PACE),
          /two reference codes.*1020 Invalid request/s); });
    });
  });

  await describe('The Telegram update path (silence is the bug)', () => {
    // The 2026-09-02 report: a message was sent, nothing was logged, and NO reply came
    // back — so the owner could not tell a bot that refused the message from a webhook
    // that never delivered it. route() answers its own errors; everything AROUND it
    // (the seen_updates claim, refs(), the send itself) only reached console.error, and
    // the claim was taken BEFORE the work, so Telegram's redelivery was dropped too.
    // One bad minute lost the message for good. These four pin the contract that
    // replaced it: every turn ends in a message, or in a claim released for the retry.
    const tg = tgMod;
    const CHAT = 424242;
    const update = (id) => ({ update_id: id, message: { message_id: 7, date: 1788000000,
      chat: { id: CHAT }, from: { id: CHAT }, text: '749 maribank Mobile data 60gb' } });

    // A whole turn with only the network stubbed: Gemini answers, Telegram records.
    // `db` lets a case break one D1 statement, which is how the real failures arrived.
    const turn = async (id, { db, telegram = 'ok' } = {}) => {
      const real = globalThis.fetch;
      const sent = [];
      globalThis.fetch = async (u, init) => {
        if (String(u).includes('generativelanguage')) {
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
            intent: 'log', error: null, query: null,
            items: [{ Date: '2026-08-20', Category: 'Expense: Food', Description: 'Mobile data 60GB',
                      Account: 'Maya', Amount: 749 }] }) }] } }] }), { status: 200 });
        }
        if (telegram === 'down') throw new Error('network unreachable');
        sent.push(JSON.parse(init.body));
        return new Response('{"ok":true}', { status: 200 });
      };
      const tgEnv = Object.assign({}, env, { TELEGRAM_USER_ID: String(CHAT), TELEGRAM_BOT_TOKEN: 'x',
                                             GEMINI_API_KEY: 'x', APP_URL: 'https://example.dev' });
      if (db) tgEnv.DB = breakOn(db);
      try { await tg.handleUpdate(tgEnv, update(id)); return sent; }
      finally { globalThis.fetch = real; }
    };
    // The real shim, with one statement made to throw the way D1 reports a storage error.
    const breakOn = (re) => ({
      prepare: (sql) => { if (re.test(sql)) throw new Error('D1_ERROR: storage'); return env.DB.prepare(sql); },
      batch: async (stmts) => env.DB.batch(stmts)
    });
    const claimed = (id) => !!sqlite.prepare('SELECT 1 FROM seen_updates WHERE update_id = ?').get(id);

    test('a healthy message is logged once, and a redelivery stays quiet', async () => {
      const first = await turn(9001);
      assert.strictEqual(first.length, 1, 'the receipt did not go out');
      assert.match(first[0].text, /Logged/);
      assert.ok(claimed(9001), 'the update_id was not claimed');
      // The claim is the whole point: Telegram redelivers anything slow, and a second
      // parse would cost a second Gemini call and a second receipt.
      assert.strictEqual((await turn(9001)).length, 0, 'a redelivery was answered twice');
      assert.strictEqual(sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'tg-9001-%'").get().n, 1);
    });

    test('a failure OUTSIDE route() still reaches the owner', async () => {
      // refs() is the one read route() makes before its own try block. It used to take
      // the turn down in silence.
      const sent = await turn(9002, { db: /FROM accounts a JOIN/ });
      assert.strictEqual(sent.length, 1, 'a broken D1 read said nothing at all');
      assert.match(sent[0].text, /Something went wrong/);
      assert.match(sent[0].text, /Nothing was logged/);
      // Reported, so the claim STAYS: a redelivery must not repeat the same complaint.
      assert.ok(claimed(9002), 'a reported failure released its claim and will now say it twice');
    });

    test('a Gemini that times out reports it instead of vanishing', async () => {
      // THE 2026-09-02 ROOT CAUSE. /tg answers Telegram 200, then works in waitUntil.
      // Cloudflare cancels waitUntil work that outlives its allowance, and a cancelled
      // task is TORN DOWN — it does not throw, so handleUpdate's catch never runs and
      // nothing is sent. The seen_updates row was written (seen() had already
      // finished), the transaction never was, and the log held one runtime warning and
      // no stack. The parse now bounds ITSELF, and this is the reply that proves it.
      //
      // The abort is raised directly rather than by waiting out a real 7s timer: what
      // matters here is that a TimeoutError becomes a sentence the owner can read. That
      // the CHAIN is bounded is a timing property, and test.js pins it with an
      // injected clock instead of 12 real seconds.
      const real = globalThis.fetch;
      const sent = [];
      let attempts = 0;
      globalThis.fetch = async (u, init) => {
        if (String(u).includes('generativelanguage')) {
          attempts++;
          assert.ok(init.signal, 'the Gemini call carries no AbortSignal — nothing can bound it');
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        }
        sent.push(JSON.parse(init.body));
        return new Response('{"ok":true}', { status: 200 });
      };
      const tgEnv = Object.assign({}, env, { TELEGRAM_USER_ID: String(CHAT), TELEGRAM_BOT_TOKEN: 'x',
                                             GEMINI_API_KEY: 'x', APP_URL: 'https://example.dev' });
      try { await tg.handleUpdate(tgEnv, update(9004)); }
      finally { globalThis.fetch = real; }

      assert.strictEqual(sent.length, 1, 'a timed-out model produced silence, which is the bug');
      assert.match(sent[0].text, /did not answer within \d+s/,
        'the reply must name the timeout in words, not leak a DOMException');
      assert.strictEqual(attempts, gem.MODELS.length, 'an instant failure should still walk the whole chain');
      assert.strictEqual(sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'tg-9004-%'").get().n, 0,
        'a timed-out parse must write nothing');
    });

    test('a failure that could not be reported releases the claim for the retry', async () => {
      const sent = await turn(9003, { telegram: 'down' });
      assert.strictEqual(sent.length, 0, 'nothing can be sent when Telegram is unreachable');
      assert.strictEqual(claimed(9003), false,
        'the claim outlived the execution — Telegram will redeliver and the bot will drop it');
    });

    test('the released message really does land on the redelivery', async () => {
      // The end of the 2026-09-02 story. Same update_id, Telegram healthy again.
      const sent = await turn(9003);
      assert.strictEqual(sent.length, 1, 'the retry of a released update was dropped');
      // "Already logged", not "Logged": the row went in BEFORE the send failed, so the
      // retry hits ON CONFLICT DO NOTHING and reports the duplicate. That is the whole
      // reason releasing a claim is safe — the row id carries the idempotency, so the
      // retry can only ever add the receipt the owner never got.
      assert.match(sent[0].text, /Already logged/);
      assert.strictEqual(sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'tg-9003-%'").get().n, 1,
        'the row id is not idempotent — a released claim can now double-write');
    });

    // ── the rescue drain ──────────────────────────────────────────────────────
    // What v2.11.0 could NOT fix. Awaiting the turn removed Cloudflare's waitUntil
    // cancellation, but it put the ceiling on Telegram's webhook patience instead, and
    // Telegram does not document that number. A turn cut off there dies the same way:
    // nothing throws, so nothing above reports it, and the claim taken up front makes
    // the redelivery a no-op. The claim now carries the update, so an unfinished row is
    // work — and this is the cron that finishes it.
    const queued = (id) => sqlite.prepare('SELECT payload, done, attempts FROM seen_updates WHERE update_id = ?').get(id);
    const GEMINI_OK = { candidates: [{ content: { parts: [{ text: JSON.stringify({
      intent: 'log', error: null, query: null,
      items: [{ Date: '2026-08-20', Category: 'Expense: Food', Description: 'Mobile data 60GB',
                Account: 'Maya', Amount: 749 }] }) }] } }] };
    const tick = async (until) => {
      for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 1));
    };

    test('a finished turn closes its row and forgets the message', async () => {
      await turn(9101);
      const row = queued(9101);
      assert.strictEqual(row.done, 1, 'a finished turn left its row pending — the drain will replay it');
      assert.strictEqual(row.payload, null,
        'the message text outlived the turn that needed it');
      const tgEnv = Object.assign({}, env, { TELEGRAM_USER_ID: String(CHAT), TELEGRAM_BOT_TOKEN: 'x' });
      assert.strictEqual(await tgMod.drainUpdates(tgEnv, Date.now() + tgMod.STALE_MS + 1), 0,
        'the drain found work in a turn that finished');
    });

    test('a turn that dies mid-flight leaves recoverable work, and the drain finishes it', async () => {
      // A torn-down invocation cannot be raised from a test — throwing nothing is the
      // whole problem. Abandoning the promise has the same shape: the turn stops where
      // it stands, no catch runs, and the row stays exactly as seen() left it.
      const real = globalThis.fetch;
      const sent = [];
      let release = null, held = false;
      const gate = new Promise((r) => { release = r; });
      globalThis.fetch = async (u, init) => {
        if (String(u).includes('generativelanguage')) {
          if (!held) { held = true; await gate; }              // the first parse never returns
          return new Response(JSON.stringify(GEMINI_OK), { status: 200 });
        }
        sent.push(JSON.parse(init.body));
        return new Response('{"ok":true}', { status: 200 });
      };
      const tgEnv = Object.assign({}, env, { TELEGRAM_USER_ID: String(CHAT), TELEGRAM_BOT_TOKEN: 'x',
                                             GEMINI_API_KEY: 'x', APP_URL: 'https://example.dev' });
      try {
        const abandoned = tgMod.handleUpdate(tgEnv, update(9102));
        abandoned.catch(() => {});
        await tick(() => held);
        const pending = queued(9102);
        assert.strictEqual(pending.done, 0, 'the dead turn closed its own row');
        assert.ok(pending.payload && JSON.parse(pending.payload).message.text,
          'the claim carries no payload, so there is nothing to rescue — the message is lost');

        // A cron has no request and therefore no origin, which is the shape the drain
        // really runs in. seen() stored it, so the rescued receipt must still carry the
        // ✎ Edit button — a rescue the owner can tell apart is only half a rescue.
        const cronEnv = Object.assign({}, tgEnv);
        delete cronEnv.APP_URL;

        // A live turn is not dead work. The drain must not race one it is merely slow.
        assert.strictEqual(await tgMod.drainUpdates(cronEnv, Date.now()), 0,
          'the drain started a second turn while the first was still inside its ceiling');

        assert.strictEqual(await tgMod.drainUpdates(cronEnv, Date.now() + tgMod.STALE_MS + 1), 1,
          'the drain left a dead turn unfinished — this is the lost message, again');
        // The ONLY place the "still working" notice speaks (v2.12.0). A live turn that
        // is merely slow now says nothing — the notice fired on a 6s timer inside every
        // turn and the owner saw it constantly. A rescue has earned it: the message is
        // minutes old and the silence so far is the thing being explained.
        assert.strictEqual(sent.length, 2, 'the rescue did not send a notice and a receipt');
        assert.match(sent[0].text, /Still working/);
        assert.strictEqual(sent[0].reply_to_message_id, 7,
          'the notice must thread onto the message it is about');
        assert.match(sent[1].text, /Logged/);
        assert.match(JSON.stringify(sent[1].reply_markup), /example\.dev.*screen=transactions/,
          'the rescued receipt lost its ✎ Edit button — the drain never recovered the app origin');
        assert.strictEqual(sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'tg-9102-%'").get().n, 1);
        const closed = queued(9102);
        assert.strictEqual(closed.done, 1, 'the rescued row stayed pending and will be replayed forever');
        assert.strictEqual(closed.attempts, 1);

        // And if the turn was only slow, its late resumption cannot double-write: the
        // row ids are idempotent, so the worst a race costs is a second receipt.
        release();
        await abandoned;
        assert.strictEqual(sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'tg-9102-%'").get().n, 1,
          'a rescue that raced a live turn wrote the transaction twice');
        assert.match(sent[2].text, /Already logged/);
      } finally { globalThis.fetch = real; }
    });

    test('an update that fails every rescue ends in one message, not a loop', async () => {
      // The drain runs every two minutes. A payload that can never succeed would
      // otherwise fail 720 times a day and say nothing, which is the old bug with a
      // clock attached.
      const real = globalThis.fetch;
      const sent = [];
      globalThis.fetch = async (u, init) => {
        if (String(u).includes('generativelanguage')) throw new Error('Gemini is down');
        sent.push(JSON.parse(init.body));
        return new Response('{"ok":true}', { status: 200 });
      };
      const tgEnv = Object.assign({}, env, { TELEGRAM_USER_ID: String(CHAT), TELEGRAM_BOT_TOKEN: 'x',
                                             GEMINI_API_KEY: 'x', APP_URL: 'https://example.dev' });
      // route() answers a failed parse itself, so break the read BEFORE its try block.
      tgEnv.DB = breakOn(/FROM accounts a JOIN/);
      try {
        sqlite.prepare('INSERT INTO seen_updates (update_id, at, payload, done) VALUES (?, ?, ?, 0)')
          .run(9103, Date.now(), JSON.stringify(update(9103)));
        // Each rescue re-stamps `at`, so the clock has to walk past STALE_MS again for
        // the next one to be eligible — that back-off is the point of the re-stamp.
        let clock = Date.now();
        const at = () => (clock += tgMod.STALE_MS + 1);
        for (let i = 1; i < tgMod.MAX_ATTEMPTS; i++) {
          assert.strictEqual(await tgMod.drainUpdates(tgEnv, at()), 0);
          assert.strictEqual(queued(9103).done, 0, 'attempt ' + i + ' of ' + tgMod.MAX_ATTEMPTS + ' gave up early');
          // One "still working", on the first rescue only — a doomed update must not
          // send the same notice every two minutes until its attempts run out.
          assert.strictEqual(sent.length, 1, 'the drain complained before it ran out of attempts');
          assert.match(sent[0].text, /Still working/);
        }
        assert.strictEqual(await tgMod.drainUpdates(tgEnv, at()), 0);
        assert.strictEqual(sent.length, 2, 'the last attempt gave up in silence');
        assert.match(sent[1].text, /Something went wrong/);
        assert.strictEqual(queued(9103).done, 1, 'a hopeless update stayed in the queue');
        assert.strictEqual(queued(9103).attempts, tgMod.MAX_ATTEMPTS);
        assert.strictEqual(await tgMod.drainUpdates(tgEnv, at()), 0, 'the closed row came back');
      } finally { globalThis.fetch = real; }
    });

    test('the drain reports a broken queue instead of throwing into the cron', async () => {
      // runScheduled has no catch of its own for the drain: the daily job reports to
      // Telegram, and a rescue that cannot even read D1 has no chat to report into.
      const tgEnv = Object.assign({}, env, { DB: breakOn(/FROM seen_updates/) });
      assert.strictEqual(await tgMod.drainUpdates(tgEnv, Date.now()), 0);
    });

    test('the cron dispatch never runs the IBKR job on the drain schedule', async () => {
      // Two schedules, one handler. Sending the daily pull to the 2-minute clock would
      // trip IBKR's ten-per-minute ceiling and cost the prices job outright.
      const jobsMod = await import('./worker/src/jobs.js');
      const tgEnv = Object.assign({}, env, { TELEGRAM_USER_ID: String(CHAT), TELEGRAM_BOT_TOKEN: 'x' });
      const real = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{"ok":true}', { status: 200 }); };
      try {
        await jobsMod.runScheduled(tgEnv, jobsMod.CRON_DRAIN);
        assert.strictEqual(calls, 0, 'the drain schedule reached out to the network — that is the IBKR job');
        await jobsMod.runScheduled(tgEnv, 'if * * * *');
        assert.strictEqual(calls, 0, 'an unknown schedule guessed a job instead of running none');
      } finally { globalThis.fetch = real; }
    });
  });

  await describe('Investments: sell legs, cost basis, the net-worth bridge', () => {
    // A dedicated ticker, funded only from Wise, so the native (USD) figures are
    // unambiguous. The fixture's IBKR is funded from both Maya and Wise on purpose
    // elsewhere, which is the mixed-currency case asserted at the end.
    test('a sell leg reports as a trade and never as pesos', async () => {
      sqlite.exec("INSERT INTO accounts (id,name,currency,subtype,symbol,starting_balance_u) " +
        "VALUES (7,'ACME','Shares','Shares','ACME',0);" +
        "INSERT INTO prices (symbol,priced_at,price,currency) VALUES ('ACME','2026-08-22',120,'USD');");
      // Two lots: $100 for 2 shares, then $140 for 2 more. Average cost $60.
      await api.createTransfer({ ID: 'ac-b1', Date: '2026-05-05', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'ACME', Amount: 100, ToAmount: 2 }, env);
      await api.createTransfer({ ID: 'ac-b2', Date: '2026-05-06', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'ACME', Amount: 140, ToAmount: 2 }, env);
      // The sell: OUT of the ticker. Amount is the QUANTITY, ToAmount the money.
      await api.createTransfer({ ID: 'ac-s1', Date: '2026-06-10', Category: 'Investment: Growth',
                                 Account: 'ACME', ToAccount: 'Wise', Amount: 2, ToAmount: 150 }, env);
      // This is the trap the whole exclusion exists for: the row's own amount_php_u is
      // a share count read as pesos, because SHARES gets no rate.
      const raw = sqlite.prepare("SELECT fx_rate, amount_php_u FROM transactions WHERE id='ac-s1'").get();
      assert.strictEqual(raw.fx_rate, null);
      assert.strictEqual(raw.amount_php_u, 2000000, '2 shares look like 2 pesos to the generated column');

      // Growth is a Quarterly USD budget, and Q2 is Apr-Jun: x3 ($100) + the two lots
      // ($240). The sale contributes NOTHING — not its 150 dollars, not its 2 "pesos".
      const g = Object.fromEntries((await api.getBudgets({ month: '2026-Jun' }, env))
        .budgets.map((x) => [x.segment, x])).Growth;
      assert.strictEqual(g.actualNative, 340, 'a quantity leaked into the budget');
      assert.strictEqual(g.actualPhp, 340 * 50);

      // The row the bot's querySummary has to skip: shaped Currency 'Shares', with a
      // peso figure that is really a share count. (The skip itself is in test.js.)
      const sold = (await api.listTransactions({ account: 'ACME' }, env)).transactions
        .find((x) => x.ID === 'ac-s1');
      assert.strictEqual(sold.Currency, 'Shares');
      assert.strictEqual(sold['Amount (PHP)'], 2);
    });

    test('cost basis: a sale takes cost out at the average, not off the top', async () => {
      const inv = await api.getInvestments({}, env);
      const p = inv.positions.find((x) => x.name === 'ACME');
      // 4 shares in for $240, half sold: 2 left, $120 of cost, average cost unmoved.
      assert.strictEqual(p.quantity, 2);
      assert.strictEqual(p.avgCostNative, 60);
      assert.strictEqual(p.costCurrency, 'USD');
      // House money: $240 in, $150 back out.
      assert.strictEqual(p.investedNative, 90);
      // The peso pool is historical cost at the stamped rate (50), halved by the sale.
      assert.strictEqual(p.costPhp, 6000);
      assert.strictEqual(p.valuePhp, 2 * 120 * 50);
      assert.strictEqual(p.gainPhp, 6000);
      // The quote behind valuePhp, for the Investments table's Price column.
      assert.deepStrictEqual([p.price, p.priceCurrency, p.pricedAt], [120, 'USD', '2026-08-22']);
      assert.ok(!inv.pulse.excluded.includes('ACME'), 'a growth ticker is in the pulse');
      assert.strictEqual(p.gainPct, 100);
      assert.strictEqual(inv.totalGainPhp, dbm.q2(inv.totalValuePhp - inv.totalCostPhp));

      // The pulse carries the sale as its own side and nets the quarter's dollars.
      const q2q = inv.pulse.quarters.find((x) => x.quarter === '2026-Q2');
      const sell = q2q.buys.find((b) => b.symbol === 'ACME' && b.side === 'sell');
      assert.strictEqual(sell.amount, 150, 'the MONEY side, not the quantity');
      assert.strictEqual(sell.quantity, 2);
      assert.strictEqual(q2q.totalUsd, 100 + 240 - 150, 'a sale is negative flow');

      // IBKR is funded from pesos AND dollars, so no native figure can be true.
      const ibkr = inv.positions.find((x) => x.name === 'IBKR');
      assert.strictEqual(ibkr.avgCostNative, null);
      assert.strictEqual(ibkr.costCurrency, null);
      assert.ok(ibkr.costPhp > 0, 'the peso pool still works — every buy leg has a rate');
    });

    test('the net-worth bridge splits a month into savings and everything else', async () => {
      sqlite.exec("INSERT INTO nw_snapshots (month,net_worth_u,assets_u,liabilities_u,shares_u,taken_at) VALUES " +
        "('2026-May',100000000000,100000000000,0,0,'2026-06-01T00:00:00Z')," +
        "('2026-Jun',150000000000,150000000000,0,0,'2026-07-01T00:00:00Z');");
      const d = await api.getDashboard({ month: '2026-Jun' }, env);
      const jun = d.cashflow.find((x) => x.month === '2026-Jun');
      assert.strictEqual(d.bridge.from, '2026-May');
      assert.strictEqual(d.bridge.live, false);
      assert.strictEqual(d.bridge.deltaNetWorth, 50000);
      assert.strictEqual(d.bridge.savings, jun.income - jun.expense);
      assert.strictEqual(d.bridge.residual, dbm.q2(50000 - d.bridge.savings),
                         'market, FX and timing is whatever the ledger did not explain');

      // The live month bridges the last snapshot to live net worth instead.
      const now = dbm.parseMonthKey(dbm.manilaMonth());
      const prev = dbm.shiftMonth(now.y, now.m, -1);
      sqlite.exec("INSERT OR REPLACE INTO nw_snapshots (month,net_worth_u,assets_u,liabilities_u,shares_u,taken_at) " +
        "VALUES ('" + dbm.monthKey(prev.y, prev.m) + "',1000000,1000000,0,0,'2026-01-01T00:00:00Z')");
      const live = await api.getDashboard({}, env);
      assert.strictEqual(live.bridge.live, true);
      assert.strictEqual(live.bridge.endNetWorth, live.netWorth);
      assert.strictEqual(live.bridge.startNetWorth, 1);

      // No predecessor snapshot, no bridge: history only accrues forward.
      assert.strictEqual((await api.getDashboard({ month: '2025-Feb' }, env)).bridge, null);
    });

    test('the quarterly pulse counts growth tickers only, never an EF park', async () => {
      const before = await api.getInvestments({}, env);
      // A share-priced account filed under a CASH-LIKE subtype: the treasury ETF the
      // owner parks the emergency fund in (IB01 in the real ledger). It is a holding,
      // and the runway counts it as cash — but topping it up is not investing.
      sqlite.exec("INSERT INTO account_types (subtype, type) VALUES ('EF','Asset');" +
        "INSERT INTO accounts (id,name,currency,subtype,symbol,starting_balance_u) " +
        "VALUES (8,'TBILL','Shares','EF','TBILL',0);" +
        "INSERT INTO prices (symbol,priced_at,price,currency) VALUES ('TBILL','2026-08-22',55,'USD');");
      // Tagged Investment: Growth on purpose — the exclusion is by ACCOUNT SUBTYPE, so
      // it must hold even when the category says otherwise.
      await api.createTransfer({ ID: 'tb-b1', Date: '2026-05-20', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'TBILL', Amount: 50, ToAmount: 1 }, env);
      const inv = await api.getInvestments({}, env);

      // Out of the pulse: no leg, and the quarter's dollars did not move.
      assert.ok(!inv.pulse.quarters.some((q) => q.buys.some((b) => b.symbol === 'TBILL')),
                'an EF park landed in the quarterly pulse');
      assert.deepStrictEqual(inv.pulse.excluded, ['TBILL'], 'the footnote names the EF park');
      const q2q = inv.pulse.quarters.find((x) => x.quarter === '2026-Q2');
      assert.strictEqual(q2q.totalUsd, 100 + 240 - 150, 'the EF park inflated the quarter');

      // Still a holding, cost basis and all: the Holdings card is the broad set.
      const p = inv.positions.find((x) => x.name === 'TBILL');
      assert.strictEqual(p.quantity, 1);
      assert.strictEqual(p.avgCostNative, 50);
      assert.strictEqual(p.costPhp, 2500);
      assert.strictEqual(p.valuePhp, 55 * 50);

      // ...but OUT of the Invested tile's totals, which are the growth set: the runway
      // already counts this peso, and counting it twice overstated both figures.
      assert.strictEqual(inv.totalValuePhp, before.totalValuePhp, 'EF leaked into Invested');
      assert.strictEqual(inv.totalCostPhp, before.totalCostPhp, 'EF cost leaked into Invested');
      assert.strictEqual(inv.totalGainPhp, dbm.q2(inv.totalValuePhp - inv.totalCostPhp));
      // Same for the allocation bar: the mix is read against the strategy targets, so a
      // park has no share of it at all (null, not 0) and the growth weights sum to 100.
      assert.strictEqual(p.weightPct, null, 'an EF park took a slice of the allocation');
      const grow = inv.positions.filter((x) => !inv.pulse.excluded.includes(x.name));
      assert.ok(Math.abs(grow.reduce((s2, x) => s2 + x.weightPct, 0) - 100) < 0.2);
      grow.forEach((x) => assert.strictEqual(x.weightPct,
        dbm.q2(Math.round(x.valuePhp / inv.totalValuePhp * 1000) / 10), 'weight is off the growth total'));

      // And the runway is where it DOES count — the same peso, measured once. $50 left
      // Wise (also cash-like) and came back as a 2750-peso holding.
      assert.strictEqual(inv.runway.efPhp, dbm.q2(before.runway.efPhp + 2750 - 2500));
    });
  });

  await describe('Debts: itemising a receivable balance', () => {
    // Its own database. The shared fixture has no receivable, and every balance
    // assertion above depends on its exact contents.
    const ddb = new DatabaseSync(':memory:');
    const dir = path.join(__dirname, 'worker', 'migrations');
    fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .forEach((f) => ddb.exec(fs.readFileSync(path.join(dir, f), 'utf8')));
    const denv = { DB: d1(ddb), FX_CACHE: { get: async () => '50', put: async () => {} } };
    ddb.exec(`
      INSERT INTO account_types (subtype, type) VALUES ('Savings','Asset'),('Receivable','Asset');
      INSERT INTO accounts (id,name,currency,subtype,starting_balance_u) VALUES
        (1,'Maya','PHP','Savings',100000000000),
        (2,'Instalment','PHP','Receivable',0),      -- one big debt paid down monthly
        (3,'Roundtrip','PHP','Receivable',0),       -- small same-amount round trips
        (4,'Opened','PHP','Receivable',5000000000), -- carries a starting balance
        (5,'Spends','PHP','Receivable',0),          -- expenses charged to the tab
        (6,'Worded','PHP','Receivable',0),          -- descriptions that name the debt
        (7,'Routed','PHP','Receivable',0);          -- descriptions that name an account
      INSERT INTO categories (id,name,type,segment) VALUES
        (1,'Expense: Food','Expense','Essentials'), (2,'Transfer: Internal','Transfer',NULL);
    `);
    // A charge (the owner pays FOR them) is a transfer INTO the receivable; a repayment
    // is a transfer OUT of it. Same two shapes the SPA and the bot already write.
    let n = 0;
    const charge = (acct, date, amt, desc) => ddb.exec(
      `INSERT INTO transactions (id,date,category_id,description,account_id,amount_u,to_account_id,to_amount_u)
       VALUES ('${"d"+String(++n).padStart(3,"0")}','${date}',2,'${desc}',1,${amt * 1e6},${acct},${amt * 1e6})`);
    const repay = (acct, date, amt, desc) => ddb.exec(
      `INSERT INTO transactions (id,date,category_id,description,account_id,amount_u,to_account_id,to_amount_u)
       VALUES ('${"d"+String(++n).padStart(3,"0")}','${date}',2,'${desc}',${acct},${amt * 1e6},1,${amt * 1e6})`);
    // A SPEND: an expense funded off the tab, with no destination account. This is
    // the leg that says 'they bought something', as against 'they handed money back'.
    const spend = (acct, date, amt, desc) => ddb.exec(
      `INSERT INTO transactions (id,date,category_id,description,account_id,amount_u)
       VALUES ('${"d"+String(++n).padStart(3,"0")}','${date}',1,'${desc}',${acct},${amt * 1e6})`);
    const of = (payload, name) => payload.accounts.find((a) => a.account === name);

    // The instalment shape: small charges that net out, then one big charge, then
    // equal monthly repayments. This is the case that separates FIFO from LIFO.
    charge(2, '2026-01-10', 600, 'snack run');
    repay(2, '2026-01-20', 600, 'paid back');
    charge(2, '2026-02-01', 1200, 'before the big one');
    charge(2, '2026-02-02', 12000, 'laptop');
    repay(2, '2026-02-05', 1200, 'clearing the small one');
    repay(2, '2026-03-01', 1000, 'instalment 1');
    repay(2, '2026-04-01', 1000, 'instalment 2');

    // The round-trip shape: spot them, get the exact amount back days later.
    charge(3, '2026-01-05', 900, 'standing balance');
    charge(3, '2026-02-10', 140, 'milk tea');
    repay(3, '2026-02-10', 140, 'milk tea back');
    charge(3, '2026-03-11', 318, 'lunch');       // two debts, one payment: the case
    charge(3, '2026-03-11', 154.29, 'coffee');   // the owner was unsure how to handle
    repay(3, '2026-03-12', 472.29, 'both back');

    // The spend shape: one big debt, part-settled in cash and part in kind, then a
    // small unrelated expense charged to the same tab. Every amount below is unique,
    // so nothing here is decided by the exact-amount rule — these test the WORDS.
    charge(5, '2026-01-05', 12000, 'tablet');
    repay(5, '2026-02-01', 2000, 'cash half, rest is the Switch game');
    spend(5, '2026-02-01', 1000, 'Switch game');       // words recur above: a payment
    spend(5, '2026-02-10', 50, 'Parking Ayala Cloverleaf');   // orphan words: own debt

    // Two debts open at once, and a repayment that names which one it pays. FIFO alone
    // would take the older one, so this only passes if the shared word wins.
    charge(6, '2026-01-05', 700, 'older unrelated thing');
    charge(6, '2026-01-20', 900, 'the tablet');
    repay(6, '2026-03-01', 400, 'for the tablet');

    // A description that names an ACCOUNT rather than the debt. Without account names
    // as stopwords, "Maya" would pull this onto the handset instead of the oldest.
    charge(7, '2026-01-05', 300, 'dinner');
    charge(7, '2026-01-20', 500, 'Maya handset');
    repay(7, '2026-03-01', 200, 'Transfer to Maya');

    test('a big debt is reported against ITSELF, not eaten by older items (FIFO, not LIFO)', async () => {
      const a = of(await api.getDebts({}, denv), 'Instalment');
      // 12000 charged, 2000 repaid in two instalments. The Jan and Feb round trips
      // netted out first, so nothing older is left to absorb them.
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.amount, x.open]),
        [['laptop', 12000, 10000]]);
      assert.strictEqual(a.balance, 10000);
    });

    test('one payment settles several debts at once, and an exact amount beats age', async () => {
      const a = of(await api.getDebts({}, denv), 'Roundtrip');
      // The 140 pairs with its own 140 rather than the older 900; the single 472.29
      // clears BOTH the 318 and the 154.29. Only the standing 900 is left.
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.open]), [['standing balance', 900]]);
    });

    test('a part payment leaves the remainder open, not the whole item', async () => {
      repay(2, '2026-05-01', 250, 'short instalment');
      const a = of(await api.getDebts({}, denv), 'Instalment');
      assert.strictEqual(a.items[0].amount, 12000);
      assert.strictEqual(a.items[0].open, 9750);
    });

    test('a starting balance is an item, so it cannot vanish from the list', async () => {
      const a = of(await api.getDebts({}, denv), 'Opened');
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.open, x.date]),
        [['Opening balance', 5000, null]]);
    });

    test('overpaying flips the direction — now the owner owes them', async () => {
      charge(4, '2026-06-01', 100, 'top up');       // 5000 opening + 100 = 5100 owed
      repay(4, '2026-06-02', 6000, 'paid too much');
      const a = of(await api.getDebts({}, denv), 'Opened');
      assert.strictEqual(a.balance, -900);
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.open]), [['paid too much', -900]]);
    });

    test('a spend nothing else refers to opens its own item, instead of paying the big debt', async () => {
      // The reported bug: a small expense charged to a receivable (they bought the
      // owner parking) settled the big instalment, which then read that much cheaper
      // than it really was. It is a debt running the other way, not a payment.
      const a = of(await api.getDebts({}, denv), 'Spends');
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.open]),
        [['tablet', 9000], ['Parking Ayala Cloverleaf', -50]]);
      assert.strictEqual(a.balance, 8950);   // still the account balance, itemised
    });

    test('a spend whose words appear elsewhere is still a payment, not a new debt', async () => {
      // Half an instalment settled in kind: a game handed over, described on its own
      // leg and named again on the cash leg. Its words recur, so it is part of a story
      // and keeps paying the tablet down — it must NOT split off the way parking does.
      const a = of(await api.getDebts({}, denv), 'Spends');
      assert.strictEqual(a.items[0].open, 9000, '12000 less 2000 cash and 1000 in kind');
      assert.ok(!a.items.some((x) => /Switch game/.test(x.description)),
        'a spend named by another row must not become its own debt item');
    });

    test('paying back a debt that runs against the balance settles it, not opens another', async () => {
      // The owner repays the parking: a charge, the same sign as the balance. It used to
      // open a fresh "owes you" item beside the -50 instead of clearing it.
      charge(5, '2026-04-01', 50, 'settling up');   // past the round-trip window
      const a = of(await api.getDebts({}, denv), 'Spends');
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.open]), [['tablet', 9000]]);
    });

    test('a shared description word beats FIFO', async () => {
      const a = of(await api.getDebts({}, denv), 'Worded');
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.open]),
        [['older unrelated thing', 700], ['the tablet', 500]]);
    });

    test('an account name in a description is routing, not a subject', async () => {
      // "Transfer to Maya" says where the money went. Matching on it would pair two
      // unrelated rows, so account names are stopwords and this falls through to FIFO.
      const a = of(await api.getDebts({}, denv), 'Routed');
      assert.deepStrictEqual(a.items.map((x) => [x.description, x.open]),
        [['dinner', 100], ['Maya handset', 500]]);
    });

    test('the open items always sum to the account balance — every account, every time', async () => {
      // The invariant the whole design rests on: the list IS the balance, itemised, so
      // it can never drift from the ledger the way a stored "paid" flag would.
      const { accounts } = await api.getAccounts({}, denv);
      const debts = await api.getDebts({}, denv);
      assert.strictEqual(debts.accounts.length, 6, 'every receivable account must be reported');
      for (const d of debts.accounts) {
        const live = accounts.find((x) => x.name === d.account);
        assert.strictEqual(d.balance, live.balanceNative, d.account + ': items do not sum to the balance');
        assert.strictEqual(d.balance, dbm.q2(d.items.reduce((s, x) => s + x.open, 0)), d.account + ': Balance disagrees with its own items');
      }
    });
  });

  await describe('HTTP layer', () => {
    test('/api is closed without a credential and open with either one', async () => {
      assert.strictEqual((await call('/api?action=getRecurring')).status, 401);
      const cookie = { Cookie: 'mm_auth=' + await hex('pw') };
      assert.strictEqual((await call('/api?action=getRecurring', { headers: cookie })).body.status, 'success');
      const bearer = { Authorization: 'Bearer tok' };
      assert.strictEqual((await call('/api?action=getExportAll', { headers: bearer })).body.status, 'success');
    });

    test('/mcp is read-only by construction and has its own credential', async () => {
      // The AI's door. Its token opens /mcp and nothing else; the owner's two credentials
      // do not open it; and every tool is a READ route, so no prompt can reach a write.
      const { TOOLS } = await load('src/mcp.js');
      const { ROUTES_READ } = await load('worker.js');
      const reads = Object.values(ROUTES_READ);
      for (const [name, t] of Object.entries(TOOLS)) assert.ok(reads.includes(t.fn), name + ' is not a ROUTES_READ handler');
      for (const off of ['getExportAll', 'listTable', 'getParse']) {
        assert.ok(!Object.values(TOOLS).some((t) => t.fn === ROUTES_READ[off]), off + ' must stay off the AI allowlist');
      }
      const rpc = (body, headers) => call('/mcp', { method: 'POST', body: JSON.stringify(body),
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });
      const ai = { Authorization: 'Bearer ai' };
      const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      assert.strictEqual((await rpc(list)).status, 401);
      assert.strictEqual((await rpc(list, { Authorization: 'Bearer tok' })).status, 401, 'INGEST_TOKEN must not open /mcp');
      assert.strictEqual((await rpc(list, { Cookie: 'mm_auth=' + await hex('pw') })).status, 401, 'the SPA cookie must not open /mcp');
      assert.strictEqual((await call('/api?action=getAccounts', { headers: ai })).status, 401, 'AI_READ_TOKEN must not open /api');
      assert.strictEqual((await rpc(list, ai)).body.result.tools.length, Object.keys(TOOLS).length);
      const init = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ai);
      assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
      const future = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, ai);
      assert.strictEqual(future.body.result.protocolVersion, '2025-11-25', 'an unknown version gets ours, not an echo');
      const got =await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_accounts', arguments: {} } }, ai);
      assert.ok(JSON.parse(got.body.result.content[0].text).accounts.length > 0);
      // An undeclared arg never reaches the handler, and the page size is capped.
      const tx = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'list_transactions', arguments: { limit: 5000, id: 'x1' } } }, ai);
      const page = JSON.parse(tx.body.result.content[0].text);
      assert.strictEqual(page.limit, 200);
      assert.ok(page.total > 1, 'the undeclared id filter was applied');
      // A filter the model got wrong is an error, never an empty page it reads as "no spend".
      const tool = async (name, args) => (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, ai)).body.result;
      const txs = async (args) => JSON.parse((await tool('list_transactions', args)).content[0].text);
      for (const [name, args] of [['get_budgets', { month: 'Sep 2026' }], ['list_transactions', { from: '2026/08/01' }],
        ['list_transactions', { category: 'Food' }], ['list_transactions', { account: 'Nobody' }]]) {
        const r = await tool(name, args);
        assert.ok(r.isError, name + ' ' + JSON.stringify(args) + ' must be an error');
      }
      assert.strictEqual((await txs({ category: 'expense: food' })).total, (await txs({ category: 'Expense: Food' })).total, 'names resolve case-insensitively');
      const cats = JSON.parse((await tool('get_categories', {})).content[0].text).categories;
      assert.strictEqual(cats.find((c) => c.name === 'Expense: Food').segment, 'Essentials');
      // A range is inclusive at both ends, and source filters by where the row came from.
      const day = await txs({ date: '2026-08-05' });
      assert.ok(day.total > 0);
      assert.strictEqual((await txs({ from: '2026-08-05', to: '2026-08-05' })).total, day.total);
      const span = await txs({ from: '2026-08-05', to: '2026-08-13' });
      assert.ok(span.total > day.total && span.transactions.every((x) => x.Date >= '2026-08-05' && x.Date <= '2026-08-13'));
      let parts = 0;
      for (const source of TOOLS.list_transactions.props.source.enum) {
        const s = await txs({ source });
        assert.ok(s.transactions.every((x) => source === 'legacy' || x.ID.startsWith(source + '-')), source);
        parts += s.total;
      }
      assert.strictEqual(parts, (await txs({})).total, 'the sources partition the ledger');
      const write = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'deleteTransaction', arguments: {} } }, ai);
      assert.strictEqual(write.body.error.code, -32602);
      const proto = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'constructor' } }, ai);
      assert.strictEqual(proto.body.error.code, -32602);
      // A notification gets 202 and no body; GET is not part of this server.
      assert.strictEqual((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ai)).status, 202);
      assert.strictEqual((await call('/mcp', { headers: ai })).status, 405);
    });

    test('/mcp OAuth: discovery, consent, PKCE, refresh, and one kill switch', async () => {
      // The door claude.ai uses on the web and the phone. Everything is signed with a key
      // from AI_READ_TOKEN, so the tests below end by rotating it.
      const b64u = (b) => Buffer.from(b).toString('base64url');
      const verifier = 'v'.repeat(50);
      const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const cb = 'https://claude.ai/api/mcp/auth_callback';
      const raw = (u, init) => worker.fetch(new Request('https://x' + u, init), wenv, ctx);
      const form = (o) => ({ method: 'POST', body: new URLSearchParams(o).toString(),
                             headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

      // Discovery from nothing but the /mcp URL.
      const deny = await raw('/mcp', { method: 'POST', body: '{}' });
      assert.match(deny.headers.get('WWW-Authenticate'), /resource_metadata="https:\/\/x\/\.well-known\/oauth-protected-resource"/);
      const prm = await (await raw('/.well-known/oauth-protected-resource')).json();
      assert.deepStrictEqual(prm.authorization_servers, ['https://x']);
      const asm = await (await raw('/.well-known/oauth-authorization-server')).json();
      assert.deepStrictEqual(asm.code_challenge_methods_supported, ['S256']);

      // Registration: Claude's callback only.
      const reg = (uris) => raw('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: uris }) });
      assert.strictEqual((await reg([cb])).status, 201);
      assert.strictEqual((await reg(['https://evil.example/cb'])).status, 400);
      assert.strictEqual((await reg([cb, 'https://evil.example/cb'])).status, 400);

      // Consent. A foreign redirect is never followed, even with the right passphrase.
      const q = { response_type: 'code', client_id: 'claude', redirect_uri: cb, state: 's<1>',
                  code_challenge: challenge, code_challenge_method: 'S256' };
      const pageRes = await raw('/authorize?' + new URLSearchParams(q));
      assert.strictEqual(pageRes.status, 200);
      assert.strictEqual(pageRes.headers.get('X-Frame-Options'), 'DENY');
      assert.ok((await pageRes.text()).includes('value="s&lt;1&gt;"'), 'state is escaped into the form');
      const evil = await raw('/authorize', form(Object.assign({}, q, { redirect_uri: 'https://evil.example/cb', pass: 'pw' })));
      assert.strictEqual(evil.status, 400);
      assert.strictEqual(evil.headers.get('Location'), null);
      assert.strictEqual((await raw('/authorize', form(Object.assign({}, q, { pass: 'nope' })))).status, 401);
      assert.strictEqual((await raw('/authorize', form(Object.assign({}, q, { code_challenge_method: 'plain', pass: 'pw' })))).status, 400);
      const ok = await raw('/authorize', form(Object.assign({}, q, { pass: 'pw' })));
      assert.strictEqual(ok.status, 302);
      const loc = new URL(ok.headers.get('Location'));
      assert.strictEqual(loc.origin + loc.pathname, cb);
      assert.strictEqual(loc.searchParams.get('state'), 's<1>');
      const code = loc.searchParams.get('code');

      // Token exchange: the verifier and the redirect must both match.
      const tok = (o) => raw('/token', form(o));
      const exch = { grant_type: 'authorization_code', code, redirect_uri: cb, code_verifier: verifier };
      assert.strictEqual((await tok(Object.assign({}, exch, { code_verifier: 'w'.repeat(50) }))).status, 400);
      assert.strictEqual((await tok(Object.assign({}, exch, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }))).status, 400);
      const t = await (await tok(exch)).json();
      assert.strictEqual(t.token_type, 'Bearer');

      const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      const mcpWith = (bearer) => call('/mcp', { method: 'POST', body: JSON.stringify(list),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer } });
      assert.strictEqual((await mcpWith(t.access_token)).status, 200);
      // A token is only ever its own kind, and never a key to /api.
      assert.strictEqual((await mcpWith(t.refresh_token)).status, 401);
      assert.strictEqual((await mcpWith(code)).status, 401);
      assert.strictEqual((await mcpWith(t.access_token.slice(0, -2) + 'AA')).status, 401, 'a forged signature');
      assert.strictEqual((await call('/api?action=getAccounts', { headers: { Authorization: 'Bearer ' + t.access_token } })).status, 401);
      assert.strictEqual((await tok({ grant_type: 'refresh_token', refresh_token: t.access_token })).status, 400);

      // Refresh gives a working pair.
      const t2 = await (await tok({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).json();
      assert.strictEqual((await mcpWith(t2.access_token)).status, 200);

      // A refresh chain ends 90 days after the passphrase, however often it renews: a
      // stolen refresh token cannot keep itself alive until AI_READ_TOKEN rotates.
      const realNow = Date.now;
      try {
        let rt = t2.refresh_token;
        for (const days of [25, 50, 75]) {
          Date.now = () => realNow() + days * 86400e3;
          const r = await tok({ grant_type: 'refresh_token', refresh_token: rt });
          assert.strictEqual(r.status, 200, 'renews on day ' + days);
          rt = (await r.json()).refresh_token;
        }
        Date.now = () => realNow() + 95 * 86400e3;
        const end = await tok({ grant_type: 'refresh_token', refresh_token: rt });
        assert.strictEqual(end.status, 400);
        assert.match((await end.json()).error_description, /Connect again/);
      } finally { Date.now = realNow; }

      // Rotating AI_READ_TOKEN voids every token issued under the old one; unset, the routes are gone.
      wenv.AI_READ_TOKEN = 'rotated';
      try {
        assert.strictEqual((await mcpWith(t2.access_token)).status, 401);
        assert.strictEqual((await tok({ grant_type: 'refresh_token', refresh_token: t2.refresh_token })).status, 400);
        delete wenv.AI_READ_TOKEN;
        assert.strictEqual((await raw('/.well-known/oauth-authorization-server')).status, 404);
      } finally { wenv.AI_READ_TOKEN = 'ai'; }
    });

    test('a wrangler dev host is open; a deployed host is not', async () => {
      // The passphrase guards the deployed app. Locally it only blocked the agents and
      // the fresh checkouts that have no worker/.dev.vars, and Cloudflare cannot route
      // a production request to Host: localhost.
      const local = await worker.fetch(new Request('http://localhost:8123/api?action=getRecurring'), wenv, ctx);
      assert.strictEqual(local.status, 200);
      assert.strictEqual((await local.json()).status, 'success');
      // ...and with no APP_PASS set at all, which is exactly what a fresh checkout has.
      const bare = await worker.fetch(new Request('http://127.0.0.1/api?action=getRecurring'), env, ctx);
      assert.strictEqual((await bare.json()).status, 'success');
      assert.strictEqual((await call('/api?action=getRecurring')).status, 401);
    });

    test('/api enforces the GET/POST split and answers errors as JSON 200', async () => {
      const cookie = { Cookie: 'mm_auth=' + await hex('pw'), 'Content-Type': 'application/json' };
      const wrongMethod = await call('/api?action=createTransaction', { headers: cookie });
      assert.match(wrongMethod.body.message, /requires POST/);
      const unknown = await call('/api?action=nope', { headers: cookie });
      assert.ok(Array.isArray(unknown.body.knownActions));
      // A handler that throws must come back as {status:'error'} with HTTP 200 — gs()
      // reads that as a final server rejection, and the offline queue depends on it.
      const bad = await call('/api', { method: 'POST', headers: cookie,
        body: JSON.stringify({ action: 'deleteTransaction', ID: 'does-not-exist' }) });
      assert.strictEqual(bad.status, 200);
      assert.strictEqual(bad.body.status, 'error');
      assert.match(bad.body.message, /No transaction/);
    });

    // ── the ETag, which IS the client cache (v2.9.0, replaced meta.data_version) ──
    const cookie = () => hex('pw').then((h) => ({ Cookie: 'mm_auth=' + h }));
    const raw = async (url, headers) =>
      worker.fetch(new Request('https://x' + url, { headers }), wenv, ctx);

    test('a read carries an ETag and answers 304 when the caller already holds it', async () => {
      const h = await cookie();
      const first = await raw('/api?action=getAccounts', h);
      const tag = first.headers.get('ETag');
      assert.ok(tag, 'getAccounts sent no ETag — the whole client cache hangs off it');
      assert.strictEqual(first.status, 200);
      const again = await raw('/api?action=getAccounts', Object.assign({ 'If-None-Match': tag }, h));
      assert.strictEqual(again.status, 304);
      assert.strictEqual(again.headers.get('ETag'), tag);
      assert.strictEqual(await again.text(), '', '304 must carry no body — that is the saving');
      // A stale tag is not a match, and must come back with the whole payload.
      const stale = await raw('/api?action=getAccounts', Object.assign({ 'If-None-Match': '"nope"' }, h));
      assert.strictEqual(stale.status, 200);
      assert.ok((await stale.json()).accounts.length);
    });

    test('a write moves the tag of what it changed and NOT of what it did not', async () => {
      // This is the entire point of the change. Under meta.data_version EVERY tag moved
      // on ANY write, so one Telegram ingest re-downloaded every cached screen.
      const h = await cookie();
      const tagOf = async (url) => (await raw(url, h)).headers.get('ETag');
      const augBefore = await tagOf('/api?action=getBudgets&month=2026-Aug');
      const janBefore = await tagOf('/api?action=getBudgets&month=2026-Jan');
      const recBefore = await tagOf('/api?action=getRecurring');
      const metaBefore = await tagOf('/api?action=listTable&table=meta');
      await api.createTransaction({ ID: 'etag-1', Date: '2026-08-19', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: 250 }, env);
      assert.notStrictEqual(await tagOf('/api?action=getBudgets&month=2026-Aug'), augBefore,
        'August changed and its tag did not move — the screen would go stale');
      assert.strictEqual(await tagOf('/api?action=getBudgets&month=2026-Jan'), janBefore,
        'an August write moved the January tag — a month-scoped key must not refetch');
      assert.strictEqual(await tagOf('/api?action=getRecurring'), recBefore,
        'an unrelated payload moved — the tag is not over its own bytes');
      assert.strictEqual(await tagOf('/api?action=listTable&table=meta'), metaBefore,
        'an admin page moved on a transaction write');
    });

    test('getDashboard is the one screen a write always moves, and that is honest', async () => {
      // Worth pinning, because it is the exception to the paragraph above. EVERY month's
      // dashboard payload carries the LIVE hero (netWorth/assets/liabilities/sharesValue)
      // and the rolling cashflow window, so any write changes January's bytes as well as
      // August's. The tag is telling the truth — the number on that screen really did
      // move — so this is not a bug to fix by trimming the payload; the hero is the point
      // of the screen. It does mean the dashboard is the one key that cannot 304 after a
      // write, and the saving lives on Budgets, Tax and the admin pages instead.
      const h = await cookie();
      const before = (await raw('/api?action=getDashboard&month=2026-Jan', h)).headers.get('ETag');
      await api.createTransaction({ ID: 'etag-2', Date: '2026-08-20', Category: 'Expense: Food',
                                    Account: 'Maya', Amount: 99 }, env);
      assert.notStrictEqual((await raw('/api?action=getDashboard&month=2026-Jan', h)).headers.get('ETag'),
        before, 'the live hero stopped moving the tag — is netWorth still in the payload?');
    });

    test('every read route answers the same bytes twice', async () => {
      // The one way an ETag dies silently: a clock (or anything else per-request) in a
      // read payload makes every tag unique, so nothing ever 304s and nobody notices —
      // the app just quietly costs what it used to. getExportAll is exempt: it stamps
      // exportedAt on purpose, and it is the backup puller's, not a cached screen.
      const h = await cookie();
      const ARGS = { listTable: '&table=meta' };   // the only read that needs one to succeed
      const routes = Object.keys((await load('worker.js')).ROUTES_READ).filter((n) => n !== 'getExportAll');
      for (const action of routes) {
        const url = '/api?action=' + action + (ARGS[action] || '');
        const one = await raw(url, h);
        const two = await raw(url, h);
        assert.strictEqual(one.status, 200, action + ' did not answer 200');
        assert.ok(one.headers.get('ETag'), action + ' sent no ETag');
        assert.strictEqual(two.headers.get('ETag'), one.headers.get('ETag'),
          action + ' answers a different ETag for identical data — something in its payload moves per request');
      }
    });
  });

  // ── the bug audit (2026-09-23) ─────────────────────────────────────────────
  // Last in the file on purpose: it adds accounts and rows, and every figure asserted
  // above is exact. The live rate in the shim is 50; a test that needs it to MOVE passes
  // its own FX_CACHE.
  await describe('Bug audit fixes', () => {
    sqlite.exec("INSERT INTO accounts (id,name,currency,subtype,symbol,starting_balance_u) VALUES " +
      "(90,'Wise Two','USD','Savings',NULL,0),(91,'SAMEDAY','Shares','Shares','SAMEDAY',0);" +
      "INSERT INTO prices (symbol,priced_at,price,currency) VALUES ('SAMEDAY','2026-08-22',50,'USD');");
    const at = (rate) => Object.assign({}, env, { FX_CACHE: { get: async () => String(rate), put: async () => {} } });
    const fxOf = (id) => sqlite.prepare('SELECT fx_rate FROM transactions WHERE id = ?').get(id).fx_rate;
    const xfer = { Date: '2026-03-10', Category: 'Investment: Growth' };

    test('a transfer between two currencies needs the amount that arrived', async () => {
      // "100 wise to bpi" from quick add stored $100 out, ₱100 in, at a rate of 1.
      await assert.rejects(api.createTransfer(Object.assign({ ID: 'ba-1', Account: 'Wise', ToAccount: 'Maya',
                                                              Amount: 100 }, xfer), env), /needs ToAmount/);
      // parseFloat("5,600") is 5 — it must be refused, not stored as five pesos.
      await assert.rejects(api.createTransfer(Object.assign({ ID: 'ba-2', Account: 'Wise', ToAccount: 'Maya',
                                                              Amount: 100, ToAmount: '5,600' }, xfer), env), /must be a number/);
      // Same currency still mirrors, as before.
      const ok = await api.createTransfer(Object.assign({ ID: 'ba-3', Account: 'Wise', ToAccount: 'Wise Two',
                                                          Amount: 100 }, xfer), env);
      assert.strictEqual(ok.transaction.ToAmount, 100);
    });

    test('editing a transfer keeps its rate, unless the edit changes it', async () => {
      await api.createTransfer(Object.assign({ ID: 'ba-4', Account: 'Wise', ToAccount: 'Maya',
                                               Amount: 100, ToAmount: 5600 }, xfer), env);
      // What the transfer form sends for a description fix: every field, no rate. The
      // live rate has moved to 58; the implied 56 must stay.
      const form = { ID: 'ba-4', Date: '2026-03-10', Category: 'Investment: Growth', Account: 'Wise',
                     ToAccount: 'Maya', Amount: 100, Description: 'typo fixed', Period: '' };
      await api.updateTransaction(form, at(58));
      assert.strictEqual(fxOf('ba-4'), 56, 'a description edit re-priced the conversion');
      // A leg that moves re-derives the implied rate, never the live one.
      await api.updateTransaction({ ID: 'ba-4', ToAmount: 5700 }, at(58));
      assert.strictEqual(fxOf('ba-4'), 57);
      // A dollar-to-dollar transfer has no implied rate: its stamp holds still too.
      await api.updateTransaction({ ID: 'ba-3', Account: 'Wise', ToAccount: 'Wise Two', Amount: 100,
                                    Description: 'x' }, at(58));
      assert.strictEqual(fxOf('ba-3'), 50);
      // A real currency change does re-stamp: pesos carry none.
      await api.createTransaction({ ID: 'ba-5', Date: '2026-03-11', Category: 'Expense: Food', Account: 'Wise', Amount: 10 }, env);
      await api.updateTransaction({ ID: 'ba-5', Account: 'Maya' }, at(58));
      assert.strictEqual(fxOf('ba-5'), null);
    });

    test('a bulk reassign re-stamps only the rows whose currency changes', async () => {
      await api.createTransaction({ ID: 'ba-6', Date: '2026-03-12', Category: 'Expense: Food', Account: 'Wise', Amount: 10 }, env);
      await api.createTransaction({ ID: 'ba-7', Date: '2026-03-12', Category: 'Expense: Food', Account: 'Maya', Amount: 10 }, env);
      await api.bulkUpdateTransactions({ ids: ['ba-6', 'ba-7'], patch: { Account: 'Wise Two' } }, at(58));
      assert.strictEqual(fxOf('ba-6'), 50, 'dollars to dollars must keep the stamped rate');
      assert.strictEqual(fxOf('ba-7'), 58, 'pesos to dollars takes the rate of the day');
    });

    test('a rate typed against a PHP account is ignored', async () => {
      const r = await api.createTransaction({ ID: 'ba-8', Date: '2026-03-13', Category: 'Expense: Food',
                                              Account: 'Maya', Amount: 500, ExchangeRate: 56 }, env);
      assert.strictEqual(r.transaction['Amount (PHP)'], 500, '₱500 of food became ₱28,000');
      assert.strictEqual(r.transaction.ExchangeRate, '');
    });

    test('no edit can make a transfer to itself', async () => {
      await assert.rejects(api.updateTransaction({ ID: 'ba-4', ToAccount: 'Wise' }, env), /must differ/);
      await assert.rejects(api.bulkUpdateTransactions({ ids: ['ba-4'], patch: { Account: 'Maya' } }, env), /must differ/);
    });

    test('a money cell takes a thousands separator instead of clearing itself', async () => {
      await api.updateTableCell({ table: 'accounts', pk: 90, column: 'credit_limit_u', value: '60,000' }, env);
      assert.strictEqual(sqlite.prepare('SELECT credit_limit_u c FROM accounts WHERE id = 90').get().c, 60000e6);
      await assert.rejects(api.updateTableCell({ table: 'accounts', pk: 90, column: 'credit_limit_u', value: 'abc' }, env),
                           /must be a number/);
    });

    test('a same-day buy and sell walk buy-first', async () => {
      // The sell is entered FIRST, so insertion order alone would walk it first too.
      await api.createTransfer({ ID: 'ba-s', Date: '2026-04-01', Category: 'Investment: Growth',
                                 Account: 'SAMEDAY', ToAccount: 'Wise', Amount: 1, ToAmount: 60 }, env);
      await api.createTransfer({ ID: 'ba-b', Date: '2026-04-01', Category: 'Investment: Growth',
                                 Account: 'Wise', ToAccount: 'SAMEDAY', Amount: 100, ToAmount: 2 }, env);
      const p = (await api.getInvestments({}, env)).positions.find((x) => x.name === 'SAMEDAY');
      assert.strictEqual(p.quantity, 1);
      assert.strictEqual(p.avgCostNative, 50, 'the sale took no cost out: the average inflated');
    });

    test('a failed prices job still writes the net-worth snapshot', async () => {
      const month = dbm.monthOf(dbm.manilaYesterday());
      sqlite.prepare('DELETE FROM nw_snapshots WHERE month = ?').run(month);
      const real = globalThis.fetch;
      globalThis.fetch = async (u) => {
        if (String(u).includes('interactivebrokers')) throw new Error('ibkr down');
        return new Response('{"ok":true}', { status: 200 });
      };
      try {
        await assert.rejects(jobsMod.runCron(Object.assign({}, env, { IBKR_FLEX_TOKEN: 't', IBKR_FLEX_QUERY_ID: 'q',
                                                                        TELEGRAM_BOT_TOKEN: 'x' })), /ibkr down/);
      } finally { globalThis.fetch = real; }
      assert.ok(sqlite.prepare('SELECT 1 FROM nw_snapshots WHERE month = ?').get(month), 'the month close was skipped');
    });

    test('a failed 06:00 prices job is retried at 09:00, and only two failures message', async () => {
      const jobEnv = Object.assign({}, env, { IBKR_FLEX_TOKEN: 't', IBKR_FLEX_QUERY_ID: 'q', TELEGRAM_BOT_TOKEN: 'x' });
      const real = globalThis.fetch;
      let ibkr = 0; const sent = [];
      globalThis.fetch = async (u, o) => {
        if (String(u).includes('interactivebrokers')) { ibkr++; throw new Error('ibkr down'); }
        sent.push(String(o && o.body));
        return new Response('{"ok":true}', { status: 200 });
      };
      try {
        await dbm.metaSet(env, 'prices_retry', '');
        await jobsMod.runScheduled(jobEnv, jobsMod.CRON_RETRY);
        assert.strictEqual(ibkr, 0, 'the 09:00 retry called IBKR after a good 06:00 run');
        await assert.rejects(jobsMod.runScheduled(jobEnv, jobsMod.CRON_DAILY), /ibkr down/);
        assert.ok(!sent.some((b) => b.includes('prices job')), 'the 06:00 failure messaged before its retry ran');
        assert.match(await dbm.metaGet(env, 'prices_retry', ''), /ibkr down/);
        await assert.rejects(jobsMod.runScheduled(jobEnv, jobsMod.CRON_RETRY), /ibkr down/);
        assert.strictEqual(ibkr, 2, 'the 09:00 run did not retry');
        assert.strictEqual(sent.filter((b) => b.includes('failed twice')).length, 1);
        assert.strictEqual(await dbm.metaGet(env, 'prices_retry', ''), '', 'the retry flag outlived its retry');
      } finally { globalThis.fetch = real; }
    });

    test('a storage fault answers 500, a refused payload 200', async () => {
      const h = { Cookie: 'mm_auth=' + await hex('pw'), 'Content-Type': 'application/json' };
      const post = (e, body) => worker.fetch(new Request('https://x/api', { method: 'POST', headers: h,
        body: JSON.stringify(body) }), e, ctx);
      const lost = () => { throw new Error('D1_ERROR: Network connection lost.'); };
      const down = Object.assign({}, wenv, { DB: { prepare: lost, batch: async () => lost() } });
      const tx = { action: 'createTransaction', ID: 'ba-h', Category: 'Expense: Food', Account: 'Maya', Amount: 1 };
      assert.strictEqual((await post(down, tx)).status, 500, 'the offline queue would drop this write');
      // A broken schema rule IS a refusal, whoever reports it.
      const bad = await post(wenv, Object.assign({}, tx, { Date: '2026-13-01' }));
      assert.strictEqual(bad.status, 200);
      assert.match((await bad.json()).message, /constraint/);
    });

    // A whole Telegram round trip with the network stubbed.
    const CHAT = 424242;
    const tgEnv = Object.assign({}, env, { TELEGRAM_USER_ID: String(CHAT), TELEGRAM_BOT_TOKEN: 'x' });
    const quiet = async (fn) => {
      const real = globalThis.fetch;
      globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });
      try { return await fn(); } finally { globalThis.fetch = real; }
    };

    test('Undo under an older receipt leaves /undo pointing at the newest message', async () => {
      await api.createTransaction({ ID: 'tg-501-0', Date: '2026-03-14', Category: 'Expense: Food', Account: 'Maya', Amount: 5 }, env);
      await dbm.metaSet(env, 'tg_last_ids', JSON.stringify(['tg-502-0']));
      const tap = (id, data) => ({ update_id: id, callback_query: { id: 'c' + id, from: { id: CHAT }, data,
                                                                  message: { message_id: 1, chat: { id: CHAT } } } });
      await quiet(() => tgMod.handleUpdate(tgEnv, tap(990001, 'u:tg-501:0')));
      assert.strictEqual(await dbm.metaGet(env, 'tg_last_ids'), '["tg-502-0"]');
      await quiet(() => tgMod.handleUpdate(tgEnv, tap(990002, 'u:tg-502:0')));
      assert.strictEqual(await dbm.metaGet(env, 'tg_last_ids'), '[]', 'the matching Undo still clears it');
    });

    test('a re-parse that lists the items in another order writes nothing twice', async () => {
      // The first run lands `a` and fails `b`; the retry parses the same text again and
      // the model lists them the other way round. By position, `b` then read as a
      // "duplicate" of a's row and was never written, while `a` was written twice.
      const a = { Date: '2026-03-15', Category: 'Expense: Food', Account: 'Maya', Amount: 120 };
      const b = { Date: '2026-03-15', Category: 'Expense: Food', Account: 'Maya', Amount: 80 };
      await quiet(() => tgMod.logItems(tgEnv, CHAT, 'tg-777', [a, Object.assign({}, b, { Category: 'Nope' })]));
      await quiet(() => tgMod.logItems(tgEnv, CHAT, 'tg-777', [b, a]));
      const rows = sqlite.prepare("SELECT amount_u FROM transactions WHERE id LIKE 'tg-777-%'").all();
      assert.deepStrictEqual(rows.map((x) => x.amount_u).sort((x, y) => x - y), [80e6, 120e6],
        'each item exactly once');
    });
  });
})().catch((err) => { console.error(err); process.exit(1); });
