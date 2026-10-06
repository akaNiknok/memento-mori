/**
 * api.js — every /api handler. The port of Router.gs's two route tables plus
 * Transactions/Accounts/Budgets/Reads/Dashboard/Ledger/Cache .gs.
 *
 * THE PRIME DIRECTIVE OF THIS FILE: the JSON contract does not change. Same action
 * names, same argument names (the sheet's header casing — `Category`, `Amount`,
 * `Amount (PHP)`), same response keys, same {status:'error'|'duplicate'} semantics.
 * worker/public/app.js is untouched by the platform swap except for the new admin
 * screen. (The one contract change since: the `version` field went away in v2.9.0 —
 * an ETag over the response bytes replaced it, see worker.js readResponse.) The v1
 * fixture diff that proved it (migrate/verify.js) retired with the cutover;
 * test-api.js is the standing check.
 *
 * What DID change, and why it is less code rather than more:
 *   * su_lock_() + cache_bumpVersion_() are gone, and so is the data version that
 *     replaced them (v2.9.0). D1 batch() is transactional, so a write needs no lock;
 *     a read carries an ETag over its own bytes, so no write has a cache to bump.
 *   * the derivation band (ARRAYFORMULAs) is gone. Month and Amount (PHP) are
 *     generated columns; Type/Segment/Currency are JOINs. There is no "never write a
 *     derived column" rule left to break.
 *   * balances are computed here (db.js shapeAccounts) instead of read out of sheet
 *     formulas. Same numbers — reconciled to the centavo at the v2.0.0 cutover.
 *
 * Handler signature is (args, env) and handlers THROW on rejection; worker.js turns
 * a throw into {status:'error', message}, exactly as Router.gs's try/catch did.
 */
import {
  refs, deltas, latestPrices, shapeAccounts, shapeTx, metaGet, metaAll, metaSet,
  toU, fromU, q2, parseDate, parsePeriod, parseMonthKey,
  monthKey, monthOf, shiftMonth, periodMonths, manilaMonth, manilaToday, manilaYesterday, BASE_CURRENCY,
  isInvestedNetWorth, isPulseAcct, isSharesAcct, NOT_SHARES_SRC, resolveAccount, resolveCategory
} from './db.js';
import { fxMap, resolveRate } from './fx.js';
import { parse } from './gemini.js';

// The Ledger's column names, which are still the sheet's — the Tax screen renders
// these strings and LEDGER_COL_ORDER in app.js sorts by them.
const LEDGER_TXID = 'Transaction ID';
const LEDGER_TX_CATEGORY = 'Income: Salary';   // the only category the Tax screen links
const LEDGER_DERIVED = ['Date Received', 'Reporting Period', 'Wise Amount', 'Total Income', '8% Tax'];
const LEDGER_COLS = ['Date Received', 'Reporting Period', 'Filed?', 'Wise Amount',
                     'BSP Reference Rate', 'Total Income', '8% Tax', LEDGER_TXID];
const LEDGER_EDIT = { 'BSP Reference Rate': 'bsp_rate', 'Filed?': 'filed', [LEDGER_TXID]: 'tx_id' };

// Fields a client may supply on a transaction create/update (port of TX_CLIENT_FIELDS).
const TX_CLIENT_FIELDS = ['Date', 'Period', 'Category', 'Description', 'Account',
                          'Amount', 'ExchangeRate', 'ToAccount', 'ToAmount'];

// ── shared helpers ───────────────────────────────────────────────────────────
const list = (n) => new Array(n).fill('?').join(',');

// The FI countdown's two fixed constants. 25x annual spend IS the 4% rule — the
// multiple is the rule's definition, not a preference, so it is not a meta key; the
// expected real return is, because that one is a genuine judgement call
// (`fire_real_return`, percent per year). DAYS_PER_YEAR is the Gregorian mean, so the
// projected date does not drift a day every leap year.
// ponytail: make FIRE_MULTIPLE a meta key only if a withdrawal rate other than 4% is
// ever actually wanted.
const FIRE_MULTIPLE = 25;
const DAYS_PER_YEAR = 365.2425;

/**
 * Invariant, unchanged from tx_assertShape_: a Transfer-type category iff the row
 * carries a destination. A mismatch makes the balance math and the budgets read the
 * row wrong, so every create/update/bulk path rejects it.
 */
function assertShape(type, hasTo) {
  if (type === 'Transfer' && !hasTo) throw new Error('A Transfer category requires a destination account (ToAccount).');
  if (type !== 'Transfer' && hasTo) throw new Error('Only a Transfer category may have a ToAccount.');
}
const hasTo = (v) => !!(v && String(v).trim() !== '');

/**
 * A zero row is never a real event: it moves nothing, it renders as a blank line and
 * it is what an empty form or a mis-parsed message produces. Checked in MICROS, so
 * an amount that rounds to zero is caught too — the same test Release 2's
 * CHECK (amount_u != 0) will make the database enforce. A NEGATIVE amount is legal:
 * that is how a refund is recorded (negative expense, original category).
 */
function assertNonZero(label, v) {
  const u = toU(v);
  // NaN is caught here too: D1 sends its parameters as JSON, where NaN is null, so an
  // amount like "1,234" (Number() says NaN) would otherwise reach the table as NULL.
  if (!Number.isFinite(u)) throw new Error(label + ' must be a number, not "' + v + '".');
  if (u === 0) throw new Error(label + ' must not be zero.');
}

const curOf = (a) => String((a && a.currency) || BASE_CURRENCY).toUpperCase();

/**
 * F16 advisory: the same account, category, amount and date, twice, from two different
 * ids. Idempotency only catches a REPLAY of one id, so a genuine double-log (two
 * Telegram messages, one purchase) sails through. Advisory on purpose — same-day
 * repeats are real (two coffees), so this warns and never blocks.
 */
async function duplicateWarning(env, id, row) {
  const hit = await env.DB.prepare(
    'SELECT id FROM transactions WHERE account_id = ? AND category_id = ? AND amount_u = ? ' +
    'AND date = ? AND id != ? LIMIT 1')
    .bind(row.account_id, row.category_id, row.amount_u, row.date, id).first();
  return hit ? 'Similar transaction exists (' + hit.id + ') — undo if duplicate.' : null;
}

/**
 * A same-currency transfer stores ToAmount == Amount, so an Amount-only edit has to
 * move both — otherwise the destination keeps crediting the old figure while the
 * source moves. An unequal pair is a deliberate cross-currency amount and is left
 * alone, as is an explicit ToAmount. Returns the ToAmount to write, or undefined.
 * Port of tx_mirrorToAmount_.
 */
function mirrorToAmount(cur, patch) {
  if (patch.Amount === undefined || patch.ToAmount !== undefined) return undefined;
  if (!hasTo(cur.ToAccount)) return undefined;
  if (Number(cur.ToAmount) !== Number(cur.Amount)) return undefined;
  return patch.Amount;
}

async function txById(env, r, id) {
  const row = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first();
  return row ? shapeTx(row, r) : null;
}

/** Accounts + the FX map they were priced with — the basis of four screens. */
async function accountsList(env, r) {
  const [net, prices] = await Promise.all([deltas(env, r), latestPrices(env)]);
  // USD is always resolved even when no account holds it: getDashboard reuses this map
  // for the budget bars, and a USD-capped target must not go null there while the
  // Budgets screen (which asks for USD explicitly) shows a figure.
  const fx = await fxMap(env, r.accounts.map((a) => a.currency)
    .concat(Object.values(prices).map((p) => p.currency)).concat(['USD']));
  return { accounts: shapeAccounts(r, net, prices, fx), fx, prices };
}

// ── reads ────────────────────────────────────────────────────────────────────
export async function getAccounts(args, env) {
  const r = await refs(env);
  const { accounts } = await accountsList(env, r);
  return { status: 'success', accounts };
}

/**
 * Itemise a receivable account's balance into the individual debts still open.
 *
 * DERIVED, never stored: there is no "paid" flag to keep in step with the ledger and
 * nothing extra to type when logging. A receivable's rows are folded in date order
 * and each leg is classified by what it does to the running balance — a leg that
 * pushes |balance| UP opens a debt item, one that pulls it toward zero settles the
 * open items. So a single "Transfer: Internal" that repays four small debts at once
 * clears all four, which is the whole reason this is an allocation and not a form.
 *
 * Allocation order: EXACT AMOUNT first, then FIFO (oldest open item).
 *   * exact-amount, because a real receivable is full of same-amount round trips —
 *     spot someone 140, get 140 back the same day — and FIFO alone credits that
 *     payment to some older item instead, so both rows stay open and wrong.
 *   * FIFO for the rest, because it is the only ordering that survives a long
 *     instalment plan. Measured against the real ledger before this was written: one
 *     receivable carried a gadget bought on the owner's card, paid back in 12 equal
 *     instalments, with a year of small round trips around it. FIFO landed within
 *     0.5% of the true remaining balance and smallest-first within 3%, but LIFO was
 *     out by 28% — it holds the charges made days BEFORE the big one open for ever
 *     and pays the big one down that much too fast. Do NOT "improve" this to LIFO.
 *     Smallest-first is the debt-snowball rule and fails the other way: it spends
 *     every payment on the small items, so the big debt never visibly moves.
 *
 * The ordering only ever decides LABELS. The sum of the open items equals the account
 * balance under any ordering, which is what test-api.js asserts.
 *
 * Signs follow the account: positive = they owe the owner, negative = the owner owes
 * them (the same asymmetry netWorthTotals reads). An overpayment empties the queue
 * and opens an item the other way round, which is exactly what it means.
 */
const ROUNDTRIP_DAYS = 14;

/** Days between two 'yyyy-MM-dd' strings. Both come straight out of the date column,
 * which a CHECK constraint already holds to that shape. */
const daysApart = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;

/**
 * Cancel the round trips BEFORE anything is allocated: a leg, and the nearby legs
 * running the other way that add up to exactly it, are one debt that came and went.
 *
 * This has to run as its own pass, not inside the fold, for two reasons the real
 * ledger shows on almost every receivable:
 *   * a round trip is often recorded the WRONG WAY ROUND — the repayment lands the
 *     same day as the charge, or the day before it clears. A date-ordered fold then
 *     spends the repayment on some older debt and leaves the charge open for ever.
 *   * ONE repayment often clears SEVERAL debts (spot someone lunch and coffee, get a
 *     single transfer back the next day). A fold that matches one leg to one leg
 *     cannot see that, and leaves every one of them open.
 * Both end the same way: the total stays right and every label is wrong, which is the
 * one thing this screen exists to get right. Matching a run, in either direction,
 * fixes both spellings at once.
 *
 * The exact sum is what keeps this honest — a near miss cancels nothing and falls
 * through to the fold. Removing a set that sums to zero cannot move the balance, so
 * the invariant holds whatever this pass does.
 */
function cancelRoundTrips(rows) {
  const dead = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (dead.has(i)) continue;
    // Every unallocated leg running the other way, near enough in time, oldest first.
    // Either side of i: the single leg is as often the repayment as the charge.
    const run = [], want = -rows[i].delta_u;
    let sum = 0;
    for (let j = 0; j < rows.length; j++) {
      if (j === i || dead.has(j) || Math.sign(rows[j].delta_u) === Math.sign(rows[i].delta_u)) continue;
      if (daysApart(rows[i].date, rows[j].date) > ROUNDTRIP_DAYS) continue;
      run.push(j); sum += rows[j].delta_u;
      if (sum === want) { dead.add(i); run.forEach((k) => dead.add(k)); break; }
    }
  }
  return rows.filter((_, i) => !dead.has(i));
}

/** Words that carry no subject: the plumbing of a description, not what it is about.
 * ACCOUNT NAMES are added to this per call — "Transfer to MariBank" names the route
 * the money took, not the debt it pays, and matching on it pairs unrelated rows. */
const DEBT_STOPWORDS = ('for to from the and of my in on at be is it back paid pay debt repayment ' +
  'payment transfer minus plus adjustment unlogged catch balance opening money cash').split(' ');

/** The words of a description that say what the debt was FOR. Empty = no signal. */
function debtWords(text, stop) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && stop.indexOf(w) < 0);
}

/**
 * Fold the legs into open debt items. `stop` is the stopword list (generic words plus
 * every account name), built once per request by getDebts.
 *
 * A SETTLEMENT picks what it pays off in this order:
 *   ① the exact amount, anywhere in the queue — the strongest signal there is, and the
 *     one cancelRoundTrips cannot reach because it only looks at nearby dates;
 *   ② a shared description word — "For iPad" pays "iPad for Berry", "From Hippers"
 *     pays "Hippers". This is the owner's own habit, already in the data;
 *   ③ nothing, if this leg is a SPEND whose words appear NOWHERE else in the account.
 *     That is the case this rule exists for: a ₱50 parking charged to a receivable is
 *     the other person buying something for the owner — a fresh IOU running the other
 *     way — not an instalment on the ₱42,990 tablet that happens to be the oldest
 *     thing open. It opens its own item, and the two show as separate lines;
 *   ④ otherwise FIFO, the oldest open item.
 *
 * ③ is narrow on BOTH counts, and each half was needed to keep a real row right.
 *   * SPEND only. A transfer out of the receivable is the repayment channel, so it
 *     always settles something even when its description says nothing useful — most
 *     do not ("Transfer to MariBank" is routing, not a subject).
 *   * ORPHAN WORDS only. A gift logged as a spend can still be half of a payment: one
 *     real instalment was settled as cash plus a game, described "<game>" on one leg
 *     and "For <plan> minus <game>" on the other. Its words appear twice, so it is
 *     part of a story and rule ③ leaves it alone; "Parking Ayala Cloverleaf" appears
 *     once and has nothing to be part of. A word used once cannot link to anything.
 */
function allocateDebts(rows, openingU, stop) {
  const q = [];
  let bal = 0;
  // How many rows use each word, so rule ③ can tell an orphan spend from one that is
  // half of something described elsewhere.
  const freq = Object.create(null);
  rows.forEach((r) => debtWords(r.description, stop).forEach((w) => { freq[w] = (freq[w] || 0) + 1; }));
  const open = (date, description, txId, u) => { q.push({ date, description, txId, orig: u, open: u }); bal += u; };
  if (openingU) open(null, 'Opening balance', null, openingU);
  for (const r of cancelRoundTrips(rows)) {
    let amt = r.delta_u;
    const words = debtWords(r.description, stop);
    while (amt !== 0) {
      // A leg can only settle an item running the OTHER way. Rule ③ lets the queue hold
      // both signs, so "same sign as bal" no longer means "nothing to settle".
      const opp = (x) => Math.sign(x.open) === -Math.sign(amt);
      if (!q.some(opp)) { open(r.date, r.description || '', r.id, amt); break; }
      // ① exact amount. findIndex keeps FIFO among equals (identical repeated charges).
      let i = q.findIndex((x) => x.open === -amt);
      // ② a shared word with an open item.
      if (i < 0 && words.length) {
        i = q.findIndex((x) => opp(x) && debtWords(x.description, stop).some((w) => words.indexOf(w) >= 0));
      }
      // A leg that deepens the balance settles only on ① or ② (paying back a ③ item);
      // otherwise it is a new debt, never FIFO against the minority direction.
      if (i < 0 && Math.sign(amt) === Math.sign(bal)) { open(r.date, r.description || '', r.id, amt); break; }
      // ③ a spend nothing else in the ledger refers to is its own debt, not a payment
      // on someone else's. A word used once has nothing it could be part of.
      if (i < 0 && r.spend && words.length && words.every((w) => freq[w] === 1)) {
        open(r.date, r.description || '', r.id, amt); break;
      }
      if (i < 0) i = q.findIndex(opp);   // ④ FIFO
      const it = q[i];
      const take = Math.min(Math.abs(amt), Math.abs(it.open)) * Math.sign(it.open);
      it.open -= take; bal -= take; amt += take;
      if (it.open === 0) q.splice(i, 1);
    }
  }
  return q;
}

/**
 * One entry per receivable account, each with the debts still open against it.
 * No arguments: the whole payload is a handful of rows, and a pure function of the
 * data, so the ETag carries it.
 *
 * NOT_SHARES_SRC is not needed here even though this counts Transfers: the fold runs
 * in the receivable's NATIVE units and a receivable is never share-priced, so the leg
 * being read is always money and never a share quantity.
 */
export async function getDebts(args, env) {
  const r = await refs(env);
  const accts = r.accounts.filter(isReceivable);
  if (!accts.length) return { status: 'success', accounts: [] };
  const holes = accts.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    'SELECT t.id, t.date, t.description, ra.id AS acct_id, ' +
    'CASE WHEN t.account_id = ra.id ' +
    "     THEN (CASE WHEN c.type = 'Income' THEN t.amount_u ELSE -t.amount_u END) " +
    '     ELSE t.to_amount_u END AS delta_u, ' +
    // A leg with no destination is a SPEND off the tab (they bought something), not a
    // repayment. allocateDebts rule ③ needs to tell the two apart.
    '(t.account_id = ra.id AND t.to_account_id IS NULL) AS spend ' +
    'FROM transactions t ' +
    'JOIN categories c ON c.id = t.category_id ' +
    'JOIN accounts ra ON ra.id = t.account_id OR ra.id = t.to_account_id ' +
    'WHERE ra.id IN (' + holes + ') ' +
    'ORDER BY t.date, t.created_at, t.id'
  ).bind(...accts.map((a) => a.id)).all()).results;

  // Account names join the stopwords: a description naming one is saying where the
  // money went, which is true of every transfer and tells us nothing about the debt.
  const stop = DEBT_STOPWORDS.concat(
    r.accounts.reduce((s, x) => s.concat(debtWords(x.name, [])), []));

  return { status: 'success', accounts: accts.map((a) => {
    const items = allocateDebts(rows.filter((x) => x.acct_id === a.id), a.starting_balance_u || 0, stop);
    return {
      account: a.name,
      currency: a.currency,
      // The sum of the open items, by construction. Reported so the SPA needs no
      // second call to head the list with "owes 1,234.56".
      balance: q2(fromU(items.reduce((s, x) => s + x.open, 0))),
      items: items.map((x) => ({
        txId: x.txId,
        date: x.date,
        description: x.description,
        amount: q2(fromU(x.orig)),   // what the debt started at
        open: q2(fromU(x.open))      // still unpaid; less than amount = part paid
      }))
    };
  }) };
}

/** Every category with its type, segment and description. The descriptions carry the
 * filing conventions (Growth, refunds, EF), so an AI reader gets what the Gemini prompt gets. */
export async function getCategories(args, env) {
  const r = await refs(env);
  return { status: 'success', categories: r.categories.map((c) => ({
    name: c.name, type: c.type || null, segment: c.segment || null, description: c.description || null
  })) };
}

export async function getRecurring(args, env) {
  const rows = (await env.DB.prepare('SELECT * FROM recurring ORDER BY id').all()).results;
  return { status: 'success', rows: rows.map((r) => ({
    Description: r.description || '',
    Currency: r.currency || '',
    // Blank sheet cells were '' in v1, and the Recurring rows are full of them.
    Amount: r.amount_u == null ? '' : fromU(r.amount_u),
    'Transaction Fee': r.fee_u == null ? '' : fromU(r.fee_u),
    'Months Left': r.months_left == null ? '' : r.months_left,
    Group: r.grp || ''
  })) };
}

const TX_SOURCES = ['tg', 'gm', 'ui', 'interest'];   // id prefixes; see telegram.js logItems and app.js gs()
export async function listTransactions(args, env) {
  const r = await refs(env);
  const where = ['1 = 1'], bind = [];
  const add = (sql, ...v) => { where.push(sql); bind.push(...v); };
  if (args.id) add('t.id = ?', String(args.id));
  if (args.month) add('t.month = ?', String(args.month));
  if (args.date) add('t.date = ?', String(args.date));
  if (args.from) add('t.date >= ?', String(args.from));
  if (args.to) add('t.date <= ?', String(args.to));
  // A name nobody has resolves to an error, not an empty page: an AI caller that guesses
  // "Food" for "Expense: Food" must not read zero rows as zero spend (2026-09-30).
  if (args.account) {
    const a = resolveAccount(r, String(args.account));
    if (!a) throw new Error('Unknown account: ' + args.account);
    add('(t.account_id = ? OR t.to_account_id = ?)', a.id, a.id);
  }
  if (args.category) {
    const c = resolveCategory(r, String(args.category));
    if (!c) throw new Error('Unknown category: ' + args.category + '. get_categories lists them.');
    add('t.category_id = ?', c.id);
  }
  if (args.segment) add('c.segment = ?', String(args.segment));
  if (args.type) add('c.type = ?', String(args.type));
  // The v1 haystack was Description + " " + Category, matched as one string — keep it
  // concatenated so a term spanning the two still matches. LIKE is ASCII-case-insensitive.
  if (args.search) add("(COALESCE(t.description,'') || ' ' || c.name) LIKE ?", '%' + String(args.search) + '%');
  // Amount bounds are peso magnitudes. On a share-priced source amount_php_u is a share
  // QUANTITY (NOT_SHARES_SRC), so a bounded search leaves those rows out rather than
  // matching 2 shares as 2 pesos.
  const minU = parseFloat(args.minAmount), maxU = parseFloat(args.maxAmount);
  if (!isNaN(minU) || !isNaN(maxU)) add(NOT_SHARES_SRC);
  if (!isNaN(minU)) add('ABS(t.amount_php_u) >= ?', toU(minU));
  if (!isNaN(maxU)) add('ABS(t.amount_php_u) <= ?', toU(maxU));
  // Where a row came from is its id prefix; anything else is legacy (sheet-era ids).
  if (args.source) {
    const src = String(args.source);
    if (TX_SOURCES.includes(src)) add('t.id LIKE ?', src + '-%');
    else if (src === 'legacy') add(TX_SOURCES.map(() => 't.id NOT LIKE ?').join(' AND '), ...TX_SOURCES.map((x) => x + '-%'));
    else throw new Error('Unknown source: ' + src);
  }

  const from = ' FROM transactions t JOIN categories c ON c.id = t.category_id ' +
               'JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id ' +
               'WHERE ' + where.join(' AND ');
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const limit = Math.max(1, parseInt(args.limit, 10) || 100);
  // rowid desc as the tie-break = insertion order, matching v1's __row tie-break, so
  // two same-day rows still show latest-entered first.
  const [cnt, page] = await env.DB.batch([
    // net = income − expense over the WHOLE filtered set, not the page: the Activity
    // header's "N results · ₱X". Transfers move money, they do not add or spend it.
    env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE c.type WHEN 'Income' THEN t.amount_php_u " +
                   "WHEN 'Expense' THEN -t.amount_php_u ELSE 0 END) AS net" + from).bind(...bind),
    env.DB.prepare('SELECT t.*' + from + ' ORDER BY t.date DESC, t.rowid DESC LIMIT ? OFFSET ?')
      .bind(...bind, limit, offset)
  ]);
  return {
    status: 'success',
    total: cnt.results[0].n, net: fromU(cnt.results[0].net || 0), offset, limit,
    transactions: page.results.map((row) => shapeTx(row, r))
  };
}

/**
 * Budget targets vs computed actuals. The plan lives in the budgets table; actuals
 * are one GROUP BY over the ledger and are never stored — same reasoning as
 * Budgets.gs, one query instead of a full-sheet scan.
 *
 * Actuals count Expense AND Transfer: a segment like Growth is funded by moving cash
 * into an investment account, so that transfer must draw the Growth budget down.
 *
 * The sums are SIGNED, not ABS: a refund is a negative-amount row in the original
 * expense category, and it must net the spend down. ABS() made a refund INFLATE the
 * figure it should reduce. Every ordinary row is positive by convention, so the two
 * agree everywhere except on a refund.
 */
async function budgetsPayload(env, monthArg, fx) {
  const ref = parseMonthKey(monthArg) || parseMonthKey(manilaMonth());
  const rows = (await env.DB.prepare('SELECT * FROM budgets ORDER BY id').all()).results;
  const incomePhp = Number(await metaGet(env, 'monthly_income_php', '0')) || 0;
  const usd = fx.USD || null;

  const needed = new Set();
  rows.forEach((b) => periodMonths(b.period, ref).forEach((m) => needed.add(m)));
  const keys = [...needed];
  const actual = Object.create(null);
  if (keys.length) {
    // Budgets count Transfers, so they are the one report a SELL leg can reach: its
    // amount_u is a share quantity. NOT_SHARES_SRC keeps quantities out of the peso
    // and dollar sums; the buy leg (IBKR -> ticker, real dollars) still counts.
    // Three sums per segment-month, because a budget is measured in the currency it
    // is planned in: `s` is the PHP total every other read speaks, `usd_s` is the
    // dollar total of the rows already denominated in dollars, and `rest_s` is the
    // PHP total of everything else (converted at the live rate when a USD budget
    // needs it). Summing dollars natively keeps a USD meter still while the peso
    // moves — the round trip through amount_php_u and back reprices every past row.
    const q = await env.DB.prepare(
      'SELECT TRIM(c.segment) AS seg, t.month AS m, SUM(t.amount_php_u) AS s, ' +
      "SUM(CASE WHEN a.currency = 'USD' THEN t.amount_u ELSE 0 END) AS usd_s, " +
      "SUM(CASE WHEN a.currency = 'USD' THEN 0 ELSE t.amount_php_u END) AS rest_s " +
      'FROM transactions t JOIN categories c ON c.id = t.category_id ' +
      'JOIN accounts a ON a.id = t.account_id ' +
      "WHERE c.type IN ('Expense','Transfer') AND " + NOT_SHARES_SRC +
      ' AND t.month IN (' + list(keys.length) + ') ' +
      'GROUP BY seg, m').bind(...keys).all();
    q.results.forEach((x) => { actual[x.seg + '|' + x.m] = x; });
  }

  const budgets = rows.map((b) => {
    const months = periodMonths(b.period, ref);
    const seg = String(b.segment).trim();
    const sum = (col) => months.reduce((s, m) => {
      const x = actual[seg + '|' + m];
      return s + (x ? (x[col] || 0) : 0);
    }, 0);
    const actualPhp = q2(fromU(sum('s')));
    // A Percent target is a share of PHP income, so it is planned in pesos whatever
    // the currency column says.
    const isUsd = b.target_type !== 'Percent' &&
                  String(b.currency || BASE_CURRENCY).toUpperCase() === 'USD';
    let targetPhp;
    if (b.target_type === 'Percent') {
      targetPhp = incomePhp ? q2((b.period === 'Quarterly' ? incomePhp * 3 : incomePhp) * b.target / 100) : null;
    } else if (isUsd) {
      targetPhp = usd ? q2(b.target * usd) : null;
    } else {
      targetPhp = q2(b.target);
    }
    const remaining = targetPhp === null ? null : q2(targetPhp - actualPhp);
    // The figures the meter reads, in `currency`. Dollar rows count as dollars; a
    // peso row inside a dollar budget is converted at the live rate, which is the
    // only rate that can express it (nothing stamps a PHP->USD rate at write time).
    const targetNative = isUsd ? q2(b.target) : targetPhp;
    const actualNative = isUsd
      ? q2(fromU(sum('usd_s')) + (usd ? fromU(sum('rest_s')) / usd : 0))
      : actualPhp;
    const remainingNative = targetNative === null ? null : q2(targetNative - actualNative);
    return {
      segment: b.segment, period: b.period, targetType: b.target_type,
      targetValue: b.target,
      // The currency the *Native figures are in — always a real code, so the client
      // formats them without knowing the plan's rules.
      currency: isUsd ? 'USD' : BASE_CURRENCY,
      targetPhp, actualPhp, remainingPhp: remaining,
      targetNative, actualNative, remainingNative,
      pctUsed: (targetNative === null || targetNative === 0) ? null : Math.round(actualNative / targetNative * 1000) / 10,
      isOver: remainingNative !== null && remainingNative < 0,
      window: months, notes: b.notes || null
    };
  });

  return { month: monthKey(ref.y, ref.m), incomePhp, fxUsdPhp: usd, budgets,
           essentialsRewards: combine(budgets, ['Essentials', 'Rewards']) };
}

/** Roll a few segments into one figure (Essentials + Rewards). Port of bud_combine_. */
function combine(budgets, names) {
  const picked = budgets.filter((b) => names.indexOf(b.segment) !== -1);
  if (!picked.length) return null;
  let target = 0, actual = 0, anyTarget = false;
  picked.forEach((b) => {
    actual += b.actualPhp || 0;
    if (b.targetPhp !== null) { target += b.targetPhp; anyTarget = true; }
  });
  const targetPhp = anyTarget ? q2(target) : null;
  const actualPhp = q2(actual);
  const remaining = targetPhp === null ? null : q2(targetPhp - actualPhp);
  return {
    segments: picked.map((b) => b.segment),
    targetPhp, actualPhp, remainingPhp: remaining,
    pctUsed: (targetPhp === null || targetPhp === 0) ? null : Math.round(actualPhp / targetPhp * 1000) / 10,
    isOver: remaining !== null && remaining < 0
  };
}

/**
 * The whole Budgets screen in one response. `recurring` rides along because the screen
 * always draws both and getRecurring is a handful of rows: two GETs meant two ETags to
 * revalidate and two round trips on a cell connection to learn nothing changed.
 * getRecurring stays a route of its own — getBootstrap and the admin grid still use it.
 */
export async function getBudgets(args, env) {
  const r = await refs(env);
  const fx = await fxMap(env, r.accounts.map((a) => a.currency).concat(['USD']));
  const [payload, recurring] = await Promise.all([
    budgetsPayload(env, args.month, fx),
    getRecurring({}, env)
  ]);
  return Object.assign({ status: 'success', recurring: recurring.rows }, payload);
}

/** The net-worth fold over shaped accounts, in raw PHP (q2 at the boundary).
 * Signs match what is STORED and what the API reports: `liabilities` is NEGATIVE
 * (it sums netWorthPhp, which is already signed), netWorth is signed, shares are a
 * subset of assets. The SPA's hero takes Math.abs of it. Do not "fix" the sign —
 * every nw_snapshots row on disk holds it this way. sharesValue uses
 * isInvestedNetWorth (subtype-based, NARROWER than the Holdings card's isShares)
 * so a near-cash share holding — a treasury ETF held as an EF, say — sits with liquid
 * here while still showing in Holdings. Shared by getDashboard and snapshotNetWorth
 * so the tile, chart and snapshot agree exactly.
 *
 * A RECEIVABLE that has gone negative is money the owner OWES, not an asset worth
 * less: it reports under liabilities, so a debt cannot hide inside the asset total. */
export function netWorthTotals(accounts) {
  let netWorth = 0, assets = 0, liabilities = 0, sharesValue = 0;
  accounts.forEach((a) => {
    const php = a.netWorthPhp == null ? 0 : a.netWorthPhp;
    if (isInvestedNetWorth(a)) sharesValue += a.balancePhp || 0;
    netWorth += php;
    if (a.isLiability || (php < 0 && isReceivable(a))) liabilities += php; else assets += php;
  });
  return { netWorth, assets, liabilities, sharesValue };
}

/** Money lent out (an Asset subtype). Negative means the flow reversed and the owner
 * is the borrower — the sign, not the subtype, says which way the debt runs. */
const isReceivable = (a) => /receivable/i.test(String(a.subtype || ''));

/** Cron: record this month's net worth (jobs.js runs it after prices, so it uses
 * fresh quotes). Upsert by month — the last write of a month is its close. Not an
 * /api write and not user data the SPA caches, so it deliberately does NOT bump
 * the data version: the current-month point on the chart uses live netWorth, and
 * a closed month's snapshot never changes. */
export async function snapshotNetWorth(env) {
  const r = await refs(env);
  const { accounts } = await accountsList(env, r);
  const t = netWorthTotals(accounts);
  // Yesterday's month, not today's. The cron runs 06:00 Manila, so the last run INSIDE
  // a month happens on its last day and would close the month without that day's
  // activity; the run on the 1st now writes the previous month's TRUE close. Days 2..n
  // still refresh the current month, so nothing else about the upsert changes. Same
  // convention as migrate/backfill-nw.js, which valued real month-ends.
  const month = monthOf(manilaYesterday());
  await env.DB.prepare(
    'INSERT INTO nw_snapshots (month, net_worth_u, assets_u, liabilities_u, shares_u, taken_at) ' +
    'VALUES (?,?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET net_worth_u = excluded.net_worth_u, ' +
    'assets_u = excluded.assets_u, liabilities_u = excluded.liabilities_u, ' +
    'shares_u = excluded.shares_u, taken_at = excluded.taken_at')
    .bind(month, toU(t.netWorth), toU(t.assets), toU(t.liabilities), toU(t.sharesValue), new Date().toISOString())
    .run();
  return { month, netWorth: q2(t.netWorth) };
}

// `pre` ({r, accounts, fx}) is getWidget's: it already ran the balance fold, the most
// expensive read here (two full scans of transactions). The router passes two args only.
export async function getDashboard(args, env, pre) {
  const month = args.month ? String(args.month) : manilaMonth();
  const ref = parseMonthKey(month) || parseMonthKey(manilaMonth());
  const r = pre ? pre.r : await refs(env);
  const { accounts, fx } = pre || await accountsList(env, r);
  const totals = netWorthTotals(accounts);
  const bud = await budgetsPayload(env, month, fx);

  // Chart window, client-chosen (6 on a phone, 12 on a big screen, 24 on request).
  // Clamped because every key becomes a bound parameter in two queries below.
  const months = Math.min(24, Math.max(2, Math.round(Number(args.months)) || 6));
  const flowKeys = [];
  for (let i = months - 1; i >= 0; i--) { const s = shiftMonth(ref.y, ref.m, -i); flowKeys.push(monthKey(s.y, s.m)); }

  // Aggregation in SQL, not JS: the 10ms CPU budget is the one real constraint on
  // this handler, and a full-table scan in JS is what would break it.
  // Signed sums, no ABS: a refund is a negative expense row and nets its category down.
  //
  // The FI countdown reads CLOSED months only, and always the three before the LIVE
  // month — never `ref`. Browsing the Dashboard back to March must not re-date your
  // retirement, and the chart window (2-24, client-chosen) must not resize its inputs.
  const now = parseMonthKey(manilaMonth());
  const closedKeys = [1, 2, 3].map((i) => { const p = shiftMonth(now.y, now.m, -i); return monthKey(p.y, p.m); });

  const [[spend, flow, recent, snaps, closed, lastSnap], fireReturn] = await Promise.all([
    env.DB.batch([
      env.DB.prepare(
        // Single quotes only: SQLite reads "" as an identifier, not an empty string.
        "SELECT COALESCE(NULLIF(TRIM(c.segment), ''), 'Unsegmented') AS seg, c.name AS cat, " +
        'SUM(t.amount_php_u) AS s FROM transactions t JOIN categories c ON c.id = t.category_id ' +
        "WHERE t.month = ? AND c.type = 'Expense' GROUP BY seg, cat").bind(month),
      env.DB.prepare(
        'SELECT t.month AS m, c.type AS type, SUM(t.amount_php_u) AS s FROM transactions t ' +
        'JOIN categories c ON c.id = t.category_id ' +
        "WHERE t.month IN (" + list(flowKeys.length) + ") AND c.type IN ('Income','Expense') " +
        'GROUP BY m, type').bind(...flowKeys),
      env.DB.prepare('SELECT * FROM transactions ORDER BY date DESC, rowid DESC LIMIT 10'),
      env.DB.prepare('SELECT month, net_worth_u, shares_u FROM nw_snapshots WHERE month IN (' + list(flowKeys.length) + ')').bind(...flowKeys),
      env.DB.prepare(
        'SELECT c.type AS type, SUM(t.amount_php_u) AS s FROM transactions t ' +
        'JOIN categories c ON c.id = t.category_id ' +
        "WHERE t.month IN (" + list(closedKeys.length) + ") AND c.type IN ('Income','Expense') " +
        'GROUP BY c.type').bind(...closedKeys),
      // The last CLOSED month's snapshot, never the live figure: the cron re-stamps the
      // current month every morning, so reading that row would put the market's daily
      // noise straight into the countdown.
      env.DB.prepare('SELECT net_worth_u FROM nw_snapshots WHERE month = ?').bind(closedKeys[0])
    ]),
    metaGet(env, 'fire_real_return', '5')
  ]);

  const spendBySegment = {}, spendByCategory = {};
  spend.results.forEach((x) => {
    spendBySegment[x.seg] = q2((spendBySegment[x.seg] || 0) + fromU(x.s));
    spendByCategory[x.cat] = q2((spendByCategory[x.cat] || 0) + fromU(x.s));
  });
  const byMonth = {};
  flowKeys.forEach((k) => { byMonth[k] = { month: k, income: 0, expense: 0 }; });
  flow.results.forEach((x) => {
    if (byMonth[x.m]) byMonth[x.m][x.type === 'Income' ? 'income' : 'expense'] = q2(fromU(x.s));
  });
  // Real historical net worth per month (nulls where no snapshot exists yet — the
  // client falls back to rolling cash flow backward for those). The live month is
  // omitted deliberately: the chart uses `netWorth` (now) for it, always fresher.
  // netWorthHistory = total; sharesHistory = the invested subset. The client
  // derives the liquid (non-shares) line as total − shares, so the cash-flow
  // bars and their overlaid line move together, and stacks the two into the
  // Net worth chart. Both omit the live month (chart uses live figures there).
  const netWorthHistory = {}, sharesHistory = {}, snapNw = {};
  snaps.results.forEach((s) => {
    snapNw[s.month] = q2(fromU(s.net_worth_u));
    if (s.month === manilaMonth()) return;
    netWorthHistory[s.month] = q2(fromU(s.net_worth_u));
    sharesHistory[s.month] = q2(fromU(s.shares_u));
  });

  // FI countdown. Progress is the closed month's net worth minus money lent out; a
  // NEGATIVE receivable is a debt the snapshot already carries, so only positive ones
  // come off. Averages are over the three closed months, signed (a refund nets down).
  let inc = 0, exp = 0;
  closed.results.forEach((x) => { if (x.type === 'Income') inc = fromU(x.s) || 0; else exp = fromU(x.s) || 0; });
  const lentOut = accounts.reduce((s, a) => s + (isReceivable(a) ? Math.max(0, a.balancePhp || 0) : 0), 0);
  const nwAtClose = lastSnap.results[0] ? fromU(lastSnap.results[0].net_worth_u) : null;
  const fire = nwAtClose == null ? null : fireEta({
    netWorthPhp: nwAtClose - lentOut,
    monthlyExpensePhp: exp / closedKeys.length,
    monthlySavingsPhp: (inc - exp) / closedKeys.length,
    realReturnPct: Number(fireReturn) || 0,
    today: manilaToday()
  });

  return {
    status: 'success', month, fire,
    netWorth: q2(totals.netWorth), assets: q2(totals.assets), liabilities: q2(totals.liabilities),
    sharesValue: q2(totals.sharesValue),
    spendBySegment, spendByCategory,
    cashflow: flowKeys.map((k) => byMonth[k]),
    netWorthHistory, sharesHistory,
    bridge: nwBridge(month, snapNw, byMonth, ref, totals.netWorth),
    // Budgets: the meters AND the Essentials+Rewards roll-up, because the Budgets
    // screen was merged into the Dashboard (v2.14.0). budgetsPayload already ran for
    // this month, so the two extra fields cost no query. Named, not spread — the
    // payload also carries its own canonical `month`, which would overwrite the one
    // above (this handler echoes back what the caller asked for). getBudgets stays:
    // it is the tested surface for budgetsPayload, and an old service-worker-cached
    // app.js still calls it.
    budgets: bud.budgets, incomePhp: bud.incomePhp, essentialsRewards: bud.essentialsRewards,
    recentTransactions: recent.results.map((row) => shapeTx(row, r))
  };
}

/**
 * The net-worth bridge: why did net worth move this much? Delta splits into what the
 * ledger explains (income - expense) and what it does not. The residual is market and
 * FX movement plus timing (a Period override reports a flow in a month its cash left
 * in another) — and, when it is large and unexplained, unlogged spending. Five weeks
 * of it once piled up into a single 33.7k catch-up row before anybody saw it.
 *
 * A closed month bridges snapshot to snapshot. The live month bridges the last
 * snapshot to live net worth, so today's figure is comparable. Null when the previous
 * month has no snapshot — history only accrues forward, so early months never bridge.
 */
export function nwBridge(month, snapNw, byMonth, ref, liveNetWorth) {
  const p = shiftMonth(ref.y, ref.m, -1);
  const from = monthKey(p.y, p.m);
  const live = month === manilaMonth();
  const start = snapNw[from];
  const end = live ? q2(liveNetWorth) : snapNw[month];
  const f = byMonth[month];
  if (start == null || end == null || !f) return null;
  const savings = q2(f.income - f.expense);
  return {
    month, from, live,
    startNetWorth: start, endNetWorth: end,
    deltaNetWorth: q2(end - start),
    savings,
    residual: q2(end - start - savings)
  };
}

/**
 * The financial-independence countdown, the Dashboard's top line.
 *
 * Target is the 4% rule: 25 x annual spend. Progress is net worth minus money LENT
 * OUT — a receivable is not a pile you can retire on, the same asymmetry the
 * emergency runway makes. The path is the standard future-value-of-an-annuity solve:
 * the pile compounds at `realReturnPct` while `monthlySavingsPhp` goes in every
 * month. A linear "gap / savings" answer would be simpler and wrong by years —
 * over a 15-year horizon the compounding IS most of the answer.
 *
 * EVERY INPUT IS A CLOSED MONTH, and the projection is anchored to the FIRST DAY OF
 * THE CURRENT MONTH, never to today. That is the whole design. The inputs only move
 * at a month close, so the ETA date holds still for the month and the countdown
 * falls by exactly one day every day. Anchor it to today instead and the date walks
 * forward with you — the number never moves, and a countdown that never moves is
 * not a spur.
 *
 * Returns null when there is no spend history to build a target from. `days` is null
 * (not Infinity) when the inputs never reach the target: no savings and no growth is
 * a real state, and "never" is the honest word for it.
 */
export function fireEta({ netWorthPhp, monthlyExpensePhp, monthlySavingsPhp, realReturnPct, today }) {
  if (!(monthlyExpensePhp > 0)) return null;
  const targetPhp = q2(monthlyExpensePhp * 12 * FIRE_MULTIPLE);
  const out = {
    targetPhp, netWorthPhp: q2(netWorthPhp),
    monthlyExpensePhp: q2(monthlyExpensePhp), monthlySavingsPhp: q2(monthlySavingsPhp),
    realReturnPct, withdrawalRatePct: q2(100 / FIRE_MULTIPLE),
    progressPct: Math.max(0, Math.min(100, Math.round(netWorthPhp / targetPhp * 1000) / 10))
  };
  if (netWorthPhp >= targetPhp) return { ...out, date: today, days: 0 };

  // (1+r)^n * (NW + P/r) - P/r = T, solved for n. A non-positive base means the pile
  // shrinks faster than it grows, and the log has nothing to say about that.
  const r = Math.pow(1 + realReturnPct / 100, 1 / 12) - 1;
  let n = Infinity;
  if (r <= 0) { if (monthlySavingsPhp > 0) n = (targetPhp - netWorthPhp) / monthlySavingsPhp; }
  else {
    const c = monthlySavingsPhp / r, base = netWorthPhp + c;
    if (base > 0 && targetPhp + c > 0) n = Math.log((targetPhp + c) / base) / Math.log(1 + r);
  }
  // 1200 months is a century. Past that the model is not projecting, it is dividing by
  // a rounding error — so it says "never" instead of naming a date in the year 2400.
  if (!(n > 0) || !isFinite(n) || n > 1200) return { ...out, date: null, days: null };

  const anchor = Date.parse(today.slice(0, 8) + '01T00:00:00Z');
  const eta = anchor + n * (DAYS_PER_YEAR / 12) * 86400000;
  return {
    ...out,
    date: new Date(eta).toISOString().slice(0, 10),
    days: Math.max(0, Math.ceil((eta - Date.parse(today + 'T00:00:00Z')) / 86400000))
  };
}

/** 'yyyy-MM-dd' -> 'yyyy-Qn' (calendar quarter, same as the investment pulse). */
const quarterOf = (d) => d.slice(0, 4) + '-Q' + Math.ceil(+d.slice(5, 7) / 3);

export async function getInvestments(args, env) {
  const r = await refs(env);
  const { accounts, prices } = await accountsList(env, r);
  const symOf = Object.fromEntries(r.accounts.map((a) => [a.name, a.symbol]));
  // Share-priced accounts only: a broker's cash balance (IBKR, subtype "For
  // Investment") is money waiting to buy, not a position, and the SPA's Assets card
  // already lists it. The SPA hides these same accounts from that card in turn.
  const positions = accounts.filter((a) => a.isShares).map((a) => ({
    name: a.name, subtype: a.subtype, currency: a.currency,
    quantity: a.balanceNative,
    valuePhp: a.balancePhp,
    // The quote behind valuePhp, for the Investments table's Price column.
    ...(() => { const p = prices[symOf[a.name]];
      return { price: p ? p.price : null, priceCurrency: p ? p.currency : null, pricedAt: p ? p.priced_at : null }; })()
  }));

  // The trade legs ARE transfers into and out of share-priced accounts, so the history
  // needs no category discipline — it is derived from account subtypes and works
  // retroactively. Funding legs (Wise→IBKR) never appear here: IBKR itself is not
  // share-priced. A BUY runs cash→ticker, a SELL runs ticker→cash, and the two sides
  // swap meaning: on a sell, amount_u is the QUANTITY and to_amount_u is the money. One
  // UNION ALL normalises them to (cash, qty, side). A ticker→ticker move is neither and
  // is excluded from both arms, so nothing is counted twice.
  // This set is the BROAD one (isSharesAcct) because it also feeds the cost basis, which
  // every holding needs. The quarterly pulse takes a narrower slice of the same rows —
  // see pulseSymbols below.
  const shareIds = r.accounts.filter(isSharesAcct).map((a) => a.id);
  const ids = shareIds.length ? list(shareIds.length) : 'NULL';
  const monthKeys = [];   // last 3 CLOSED months, for the runway's average spend
  const ref = parseMonthKey(manilaMonth());
  for (let i = 3; i >= 1; i--) { const s = shiftMonth(ref.y, ref.m, -i); monthKeys.push(monthKey(s.y, s.m)); }
  const [legsQ, spendQ] = await env.DB.batch([
    env.DB.prepare(
      'SELECT t.date AS d, t.amount_u AS cash, t.to_amount_u AS qty, t.amount_php_u AS cash_php, ' +
      "b.name AS symbol, COALESCE(a.currency, 'USD') AS cur, 'buy' AS side FROM transactions t " +
      'JOIN accounts b ON b.id = t.to_account_id LEFT JOIN accounts a ON a.id = t.account_id ' +
      'WHERE t.to_account_id IN (' + ids + ') AND t.account_id NOT IN (' + ids + ') ' +
      'UNION ALL ' +
      // cash_php is NULL on a sell on purpose: amount_php_u there is a share count read
      // as pesos. A sale's peso cost comes out of the basis pool, never off the row.
      "SELECT t.date, t.to_amount_u, t.amount_u, NULL, a.name, COALESCE(b.currency, 'USD'), 'sell' " +
      'FROM transactions t JOIN accounts a ON a.id = t.account_id ' +
      'LEFT JOIN accounts b ON b.id = t.to_account_id ' +
      'WHERE t.account_id IN (' + ids + ') AND t.to_account_id IS NOT NULL ' +
      'AND t.to_account_id NOT IN (' + ids + ') ' +
      // Inside one day a SELL sorts first, so the oldest-first walk below meets the buy
      // before it: a same-day buy and sell walked sell-first found no shares, took no
      // cost out, and inflated the average for good.
      'ORDER BY d DESC, side DESC').bind(...shareIds, ...shareIds, ...shareIds, ...shareIds),
    env.DB.prepare(
      'SELECT SUM(t.amount_php_u) AS s FROM transactions t JOIN categories c ON c.id = t.category_id ' +
      "WHERE c.type = 'Expense' AND t.month IN (" + list(monthKeys.length) + ')').bind(...monthKeys)
  ]);

  // Cost basis, average-cost method, walked oldest-first. A buy puts cash in the pool
  // and shares in the count; a sell takes cost OUT in proportion to the shares leaving,
  // so the average entry price does not move when you sell. Two pools, because the two
  // questions differ: poolNative is dollars actually paid, poolPhp is those dollars at
  // the rate stamped on the day (the historical peso cost, comparable to valuePhp).
  // investedNative is the separate house-money figure — cash in minus proceeds out — and
  // it goes NEGATIVE once a position has returned more than it ever cost.
  const basis = Object.create(null);
  for (let i = legsQ.results.length - 1; i >= 0; i--) {
    const x = legsQ.results[i];
    const b = basis[x.symbol] || (basis[x.symbol] =
      { qty: 0, poolNative: 0, poolPhp: 0, investedNative: 0, currency: x.cur });
    const cash = fromU(x.cash) || 0, qty = fromU(x.qty) || 0;
    if (x.side === 'buy') {
      // Funded from two different currencies over the position's life? Then no native
      // figure is true and only the peso pool means anything — every buy leg carries a
      // stamped rate, so poolPhp is always well defined.
      if (x.cur !== b.currency) b.mixed = true;
      b.qty += qty; b.poolNative += cash; b.poolPhp += fromU(x.cash_php) || 0;
      b.investedNative += cash;
    } else {
      const f = b.qty > 0 ? Math.min(1, qty / b.qty) : 0;
      b.qty -= qty; b.poolNative -= b.poolNative * f; b.poolPhp -= b.poolPhp * f;
      b.investedNative -= cash;
    }
  }
  positions.forEach((p) => {
    const b = basis[p.name];
    if (!b) return;
    p.costCurrency = b.mixed ? null : b.currency;
    p.investedNative = b.mixed ? null : q2(b.investedNative);
    p.avgCostNative = (b.mixed || b.qty <= 0) ? null : Math.round(b.poolNative / b.qty * 10000) / 10000;
    p.costPhp = q2(b.poolPhp);
    p.gainPhp = p.valuePhp == null ? null : q2(p.valuePhp - b.poolPhp);
    p.gainPct = (p.valuePhp == null || !b.poolPhp) ? null
      : Math.round((p.valuePhp / b.poolPhp - 1) * 1000) / 10;
  });

  // Quarterly pulse: GROWTH holdings only. A leg into or out of a share-priced account
  // filed under a cash-like subtype (IB01, subtype EF) is EF parking, not investing, and
  // the runway card already measures it — counting it here reported the same peso twice
  // and inflated the quarter. Symbol is the ticker account's name on both arms, so one
  // name set filters the rows the pulse may see; the cost basis above still walks all of
  // them. Newest quarter first; the SPA flags the current quarter when it has no buys.
  const pulseSymbols = new Set(r.accounts.filter(isPulseAcct).map((a) => a.name));

  // The Invested tile is GROWTH only, the same split the pulse makes: an EF park (IB01,
  // subtype EF) is priced as a share but is runway cash, and the runway card already
  // counts it — totalling it here reported the same peso as invested AND as reserve.
  // The allocation bar and the holdings table still carry it, and weightPct still spans
  // every position, so the two tiles answer different questions on purpose.
  const growth = positions.filter((p) => pulseSymbols.has(p.name));
  const growthValuePhp = growth.reduce((s, p) => s + (p.valuePhp || 0), 0);
  const totalCostPhp = growth.reduce((s, p) => s + (p.costPhp || 0), 0);
  // weightPct is the ALLOCATION share, so it spans the same growth set and sums to 100 —
  // it is read against the 60/25/15 strategy targets, and an EF park is not part of that
  // mix. A park gets null, not 0: it has no share of a total it is not in.
  positions.forEach((p) => {
    p.weightPct = !pulseSymbols.has(p.name) ? null
      : growthValuePhp ? Math.round((p.valuePhp || 0) / growthValuePhp * 1000) / 10 : 0;
  });
  const quarters = [];
  legsQ.results.forEach((x) => {
    if (!pulseSymbols.has(x.symbol)) return;
    const q = quarterOf(x.d);
    let row = quarters[quarters.length - 1];
    if (!row || row.quarter !== q) { row = { quarter: q, totalUsd: 0, buys: [] }; quarters.push(row); }
    const amt = q2(fromU(x.cash));
    row.buys.push({ date: x.d, symbol: x.symbol, amount: amt, currency: x.cur,
                   quantity: fromU(x.qty), side: x.side });
    // A sale is negative flow in its quarter: the pulse answers "did I park money this
    // quarter", and money taken back out is not parking.
    if (x.cur === 'USD') row.totalUsd = q2(row.totalUsd + (x.side === 'sell' ? -amt : amt));
  });

  // Emergency runway: EF pesos are commingled with spending money (no dedicated EF
  // account), so the honest figure is the whole cash-like pool, expressed in months
  // of average spend. "Cash-like" reuses the net-worth liquid/invested split
  // (isInvestedNetWorth: IB01-as-EF counts, growth tickers don't) minus receivables
  // (money lent is not reachable in an emergency) minus credit balances.
  // ponytail: targetMonths is the doc's fixed 4-month rule; make it a meta key if it ever moves.
  // The pool in its four parts, so the Summary tooltip can show the sum it is (v3).
  // `parts` are signed as they add: credit and owed are negative.
  const parts = { cashPhp: 0, efSharesPhp: 0, creditPhp: 0, owedPhp: 0 };
  accounts.forEach((a) => {
    const b = a.balancePhp || 0;
    if (a.isLiability) parts.creditPhp -= b;
    else if (isInvestedNetWorth(a)) return;
    // A receivable is asymmetric on purpose: money LENT is not reachable in an
    // emergency, so a positive balance adds nothing — but a NEGATIVE one is money the
    // owner owes, and a debt does shorten the runway. Excluding both hid ₱13.6k of it.
    else if (isReceivable(a)) parts.owedPhp += Math.min(0, b);
    else if (a.isShares) parts.efSharesPhp += b;
    else parts.cashPhp += b;
  });
  const efPhp = parts.cashPhp + parts.efSharesPhp + parts.creditPhp + parts.owedPhp;
  Object.keys(parts).forEach((k) => { parts[k] = q2(parts[k]); });
  const avg = spendQ.results[0] && spendQ.results[0].s ? fromU(spendQ.results[0].s) / monthKeys.length : 0;
  const runway = {
    efPhp: q2(efPhp), parts,
    avgMonthlyExpensePhp: q2(avg),
    months: avg ? Math.round(efPhp / avg * 10) / 10 : null,
    targetMonths: 4,
    targetPhp: avg ? q2(avg * 4) : null
  };

  return {
    status: 'success',
    totalValuePhp: q2(growthValuePhp), totalCostPhp: q2(totalCostPhp),
    totalGainPhp: q2(growthValuePhp - totalCostPhp), positions,
    // excluded = the holdings the pulse skips (an EF park like IB01), named in its footnote.
    pulse: { currentQuarter: quarterOf(manilaToday()), quarters,
             excluded: positions.filter((p) => !pulseSymbols.has(p.name)).map((p) => p.name) },
    runway,
    coreTargets: { 60: 'Core', 25: 'Growth', 15: 'Speculative' },
    // Reference figures for the Investments allocation tile, not a computed thing. These SUM TO 85
    // ON PURPOSE: Stability was removed in v2.3.0 (the EF accrues as unspent residue,
    // which no monthly meter can track — the runway card is its only measure), and the
    // missing 15 IS that residue. Do not "correct" it back to 100.
    segmentTargets: { Essentials: 50, Rewards: 10, Growth: 25 }
  };
}

export async function getBootstrap(args, env) {
  const r = await refs(env);
  const [{ accounts, fx }, meta, recurring, minRow, recent] = await Promise.all([
    accountsList(env, r),
    metaAll(env),
    getRecurring({}, env),
    env.DB.prepare('SELECT MIN(date) AS d FROM transactions').first(),
    recentSets(env, r)
  ]);
  const categories = {};
  r.categories.forEach((c) => {
    categories[c.name] = { Type: c.type || null, Segment: c.segment || null, Description: c.description || null };
  });
  return {
    status: 'success',
    owner: meta.owner_email || '',
    baseCurrency: BASE_CURRENCY,
    categories,
    accounts,
    budgets: (await budgetsPayload(env, args.month, fx)).budgets,
    recurring: recurring.rows,
    fxUsdPhp: fx.USD || null,
    widgetAccounts: widgetNames(meta[WIDGET_META]),   // the Admin screen's widget picker
    smartLists: smartLists(meta[SMART_META]),         // Activity's saved filters
    quickPicks: recent.quickPicks,                    // the add sheet's "Or repeat one" chips
    descCategory: recent.descCategory,                // the add field's instant category guess
    // Oldest ledger month, so the month pickers reach all history.
    minMonth: minRow && minRow.d ? monthOf(minRow.d) : null
  };
}

/**
 * The add field's memory, from ONE query over the last 90 days of non-transfer rows,
 * grouped by (description, category, account, amount). quickPicks = the 8 most repeated
 * sets; descCategory = lower-cased description -> the category of its LATEST use.
 */
async function recentSets(env, r) {
  const { results } = await env.DB.prepare(
    "SELECT description AS d, category_id AS c, account_id AS a, amount_u AS u, COUNT(*) AS n, MAX(date || id) AS last " +
    "FROM transactions WHERE to_account_id IS NULL AND description IS NOT NULL AND description != '' " +
    "AND date >= date(?, '-90 days') GROUP BY lower(description), category_id, account_id, amount_u"
  ).bind(manilaToday()).all();
  const descCategory = {}, latest = {};
  results.forEach((x) => {
    const k = x.d.toLowerCase();
    if (!(k in latest) || x.last > latest[k]) { latest[k] = x.last; descCategory[k] = r.catById[x.c].name; }
  });
  const quickPicks = results.slice()
    .sort((a, b) => b.n - a.n || (b.last > a.last ? 1 : b.last < a.last ? -1 : 0)).slice(0, 8)
    .map((x) => ({ Description: x.d, Category: r.catById[x.c].name, Account: r.acctById[x.a].name, Amount: fromU(x.u) }));
  return { quickPicks, descCategory };
}

/**
 * GET {text} — the add field's parse on Return: the bot's own Gemini call, same prompt,
 * so its category rules hold. A read (it writes nothing); the SPA saves through
 * createTransaction/createTransfer afterwards, so the offline queue still applies.
 */
export async function getParse(args, env) {
  const text = String(args.text || '').trim().slice(0, 500);
  if (!text) return { status: 'success', intent: 'log', items: [], error: 'Nothing to parse.' };
  const p = await parse(env, await refs(env), text);
  return { status: 'success', intent: p.intent || 'log', items: p.error ? [] : (p.items || []), error: p.error || null };
}

// ── iOS widgets (widgets/memento-mori.js) ─────────────────────────────────
/** meta key holding the balance widget's accounts: a JSON array of up to 3 names. */
const WIDGET_META = 'widget_accounts';
const WIDGET_SEGMENTS = ['Essentials', 'Rewards'];
export function widgetNames(v) {
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String).slice(0, 3) : []; }
  catch (e) { return []; }
}

/**
 * Every home-screen widget in ONE small GET: a widget refresh is a background task with
 * a tight time and memory budget, so it gets the four answers in one round trip and not
 * the whole Dashboard payload. The balance fold runs ONCE and is handed to getDashboard.
 */
export async function getWidget(args, env) {
  const r = await refs(env);
  const pre = Object.assign({ r }, await accountsList(env, r));
  const [d, pins] = await Promise.all([
    getDashboard({ months: 6 }, env, pre), metaGet(env, WIDGET_META, '[]')
  ]);
  const accounts = widgetNames(pins).map((n) => pre.accounts.find((x) => x.name === n)).filter(Boolean)
    .map((x) => ({ name: x.name, color: x.color, currency: x.currency, balanceNative: x.balanceNative,
                   balancePhp: x.balancePhp, isLiability: x.isLiability, isShares: x.isShares }));
  // Same as the SPA's netWorthSeries: the live figure anchors the newest month, a
  // snapshot wins where one exists, and a month without one rolls the flows backward.
  const cf = d.cashflow, netWorth = [];
  let nw = d.netWorth;
  for (let i = cf.length - 1; i >= 0; i--) {
    const snap = i < cf.length - 1 ? d.netWorthHistory[cf[i].month] : null;
    if (snap != null) nw = snap;
    netWorth.unshift({ month: cf[i].month, value: q2(nw) });
    nw -= cf[i].income - cf[i].expense;
  }
  return {
    status: 'success', month: d.month, accounts, netWorth,
    segments: d.budgets.filter((b) => WIDGET_SEGMENTS.includes(b.segment)).map((b) => ({
      segment: b.segment, period: b.period, currency: b.currency, actual: b.actualNative, actualPhp: b.actualPhp,
      target: b.targetNative, remaining: b.remainingNative, pctUsed: b.pctUsed, isOver: b.isOver })),
    essentialsRewards: d.essentialsRewards,
    recent: d.recentTransactions.slice(0, 3).map((t) => ({
      Date: t.Date, Description: t.Description, Category: t.Category, Type: t.Type,
      Amount: t.Amount, Currency: t.Currency, 'Amount (PHP)': t['Amount (PHP)'], ToAccount: t.ToAccount,
      Segment: t.Segment }))
  };
}

/**
 * The Glance RPC (worker.js `Glance.summary`): left to spend this month, the emergency
 * runway against its target, and what is held. Built from the two handlers that already
 * answer each part, so every figure matches the screen that shows it.
 */
export async function glance(env) {
  const [inv, bud] = await Promise.all([getInvestments({}, env), getBudgets({}, env)]);
  return {
    left: bud.essentialsRewards ? bud.essentialsRewards.remainingPhp : null,
    runway: inv.runway.months, runwayTarget: inv.runway.targetMonths,
    // The account name IS the ticker (accounts.symbol holds the same string).
    holdings: inv.positions.map((p) => ({ ticker: p.name, subtype: p.subtype, quantity: p.quantity }))
  };
}

/** POST {names:[...]} — the balance widget's accounts, set from the Admin screen. */
export async function setWidgetAccounts(args, env) {
  const names = Array.isArray(args.names) ? args.names.filter((n) => n) : [];
  if (names.length > 3) throw new Error('The widget shows at most 3 accounts.');
  const r = await refs(env);
  const canon = names.map((n) => {
    const acc = resolveAccount(r, n);
    if (!acc) throw new Error('Unknown Account: ' + n);
    return acc.name;
  });
  await metaSet(env, WIDGET_META, JSON.stringify(canon));
  return { status: 'success', widgetAccounts: canon };
}

// ── Activity smart lists ─────────────────────────────────────────────────────
/** meta key holding the saved filter sets: JSON [{name, filters}], at most 20. */
const SMART_META = 'smart_lists';
const SMART_KEYS = ['month', 'date', 'type', 'category', 'segment', 'account', 'source',
                    'minAmount', 'maxAmount', 'search'];
export function smartLists(v) {
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.slice(0, 20) : []; }
  catch (e) { return []; }
}

/** POST {lists:[{name, filters}]} — replaces the whole set; the SPA sends it back edited. */
export async function setSmartLists(args, env) {
  const lists = Array.isArray(args.lists) ? args.lists : [];
  if (lists.length > 20) throw new Error('Keep at most 20 smart lists.');
  const canon = lists.map((l) => {
    const name = String((l && l.name) || '').trim().slice(0, 40);
    if (!name) throw new Error('A smart list needs a name.');
    const filters = {};
    SMART_KEYS.forEach((k) => {
      const v = l.filters && l.filters[k];
      if (v != null && v !== '') filters[k] = String(v);
    });
    return { name, filters };
  });
  await metaSet(env, SMART_META, JSON.stringify(canon));
  return { status: 'success', smartLists: canon };
}

// ── ledger (Tax screen) ──────────────────────────────────────────────────────
/** One ledger_view row -> the {header: value} object the Tax screen renders. */
function shapeLedger(v) {
  return {
    __row: v.id,                       // the opaque row handle the UI sends back
    [LEDGER_TXID]: v.tx_id || '',
    'BSP Reference Rate': v.bsp_rate == null ? '' : v.bsp_rate,
    'Filed?': v.filed || '',
    // The sheet formula rendered this warning when the linked tx was gone; the
    // LEFT JOIN miss is the same condition, so the same string keeps the UI honest.
    'Date Received': v.tx_deleted ? '⚠ transaction deleted' : (v.date_received || ''),
    'Reporting Period': v.reporting_period || '',
    'Wise Amount': fromU(v.wise_amount_u),
    'Total Income': fromU(v.total_income_u),
    '8% Tax': fromU(v.tax_u)
  };
}

/**
 * ONE TAX YEAR, not the whole ledger. BIR files per year and the screen sorts newest
 * first, so every row before January was payload the phone downloaded to scroll past.
 * The set only grows — it is one row per payslip, forever — so an unbounded read was a
 * bill that went up every month.
 *
 * A row with NO date is always included, whatever the year: that is a link to a deleted
 * transaction (the view's tx_deleted), and a year filter must never be the reason a
 * broken row stops being visible. `years` is what the client's picker is drawn from.
 */
export async function getLedger(args, env) {
  const r = await refs(env);
  const cat = r.catByName[LEDGER_TX_CATEGORY];
  const [years, view, unlinked] = await env.DB.batch([
    env.DB.prepare("SELECT DISTINCT substr(date_received,1,4) AS y FROM ledger_view " +
      "WHERE date_received IS NOT NULL AND date_received <> '' ORDER BY y DESC"),
    env.DB.prepare("SELECT * FROM ledger_view WHERE substr(date_received,1,4) = ? " +
      "OR date_received IS NULL OR date_received = '' ORDER BY id")
      .bind(String(args.year || manilaToday().slice(0, 4))),
    env.DB.prepare('SELECT t.* FROM transactions t WHERE t.category_id = ? ' +
      'AND t.id NOT IN (SELECT tx_id FROM ledger WHERE tx_id IS NOT NULL) ' +
      'ORDER BY t.date DESC, t.rowid DESC').bind(cat ? cat.id : -1)
  ]);
  return {
    status: 'success',
    year: String(args.year || manilaToday().slice(0, 4)),
    years: years.results.map((x) => x.y),
    rows: view.results.map(shapeLedger),
    cols: LEDGER_COLS, derived: LEDGER_DERIVED, txIdCol: LEDGER_TXID,
    // The Tax screen WRITES through the admin grid's routes (updateTableCell /
    // insertTableRow / deleteTableRow), so `ledger` needs no write routes of its own —
    // it is already a TABLES entry. This is the one thing the client cannot derive:
    // which db column each of the sheet-era headers above maps to. Everything not
    // listed is derived and the screen renders it read-only.
    table: 'ledger', pk: 'id', edit: LEDGER_EDIT,
    unlinked: unlinked.results.map((row) => shapeTx(row, r))
  };
}

// ── transaction writes ───────────────────────────────────────────────────────
/**
 * Create. Idempotent on a caller-supplied ID: ON CONFLICT DO NOTHING plus a
 * changes===0 check reports {status:'duplicate'} instead of a second row. The SPA's
 * offline queue and Telegram's retry dedup BOTH depend on that exact contract —
 * test.js fails if either half goes missing.
 *
 * ponytail: the version bump rides in the batch even when the insert was a duplicate.
 * A no-op replay therefore invalidates client caches once; that is one extra refetch
 * against saving a round trip on every real write. Split the batch only if replays
 * ever stop being rare.
 */
export async function createTransaction(args, env) {
  const r = await refs(env);
  if (!args.Category) throw new Error('Missing required field: Category');
  if (!args.Account) throw new Error('Missing required field: Account');
  const cat = resolveCategory(r, args.Category);
  if (!cat) throw new Error('Unknown Category: ' + args.Category);
  const acct = resolveAccount(r, args.Account);
  if (!acct) throw new Error('Unknown Account: ' + args.Account);
  if (args.Amount === undefined || args.Amount === '' || isNaN(parseFloat(args.Amount)))
    throw new Error('Missing/invalid required field: Amount');
  assertNonZero('Amount', args.Amount);
  assertShape(cat.type, false);   // a plain tx never has a destination

  const id = args.ID || crypto.randomUUID();
  const fx = await resolveRate(env, acct.currency, args.ExchangeRate);
  const row = { date: parseDate(args.Date), category_id: cat.id, account_id: acct.id, amount_u: toU(args.Amount) };
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO transactions (id, date, period, category_id, description, account_id, amount_u, fx_rate) ' +
      'VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id, row.date, parsePeriod(args.Period) || null, cat.id,
            args.Description || '', acct.id, row.amount_u, fx.blank ? null : fx.rate)
  ]);
  const transaction = await txById(env, r, id);
  if (!res.meta.changes) return { status: 'duplicate', message: 'ID already exists.', transaction };
  const out = { status: 'success', message: 'Transaction created.', transaction };
  const dup = await duplicateWarning(env, id, row);
  if (fx.warning || dup) out.warning = [fx.warning, dup].filter(Boolean).join(' ');
  return out;
}

/**
 * The rate to stamp on a transfer. A conversion that LANDS IN PESOS already knows its
 * own rate — ToAmount/Amount is the rate the transfer actually realised, spread and
 * fees included. The live rate is a different number, so stamping it valued the source
 * leg at a rate nobody got and made the conversion spread vanish from the books
 * (two prod rows, ~₱65 of phantom money). An explicit ExchangeRate still wins, and
 * every other shape falls through to resolveRate unchanged.
 *
 * Only a PHP destination qualifies: fx_rate converts the SOURCE amount to pesos, so
 * ToAmount/Amount is that rate only when ToAmount is in pesos. A PHP source needs no
 * rate at all (resolveRate returns blank), and a Shares leg is a quantity, not money.
 */
function impliedUsable(from, to, amount, toAmount, override) {
  const src = curOf(from), dst = curOf(to);
  return !!((override === undefined || override === null || override === '') &&
    src !== dst && dst === BASE_CURRENCY && src !== 'SHARES' &&
    Number(amount) && Number(toAmount));
}
async function impliedRate(env, from, to, amount, toAmount, override) {
  if (impliedUsable(from, to, amount, toAmount, override))
    return { rate: Math.abs(toAmount / amount), blank: false, source: 'implied' };
  return resolveRate(env, from.currency, override);
}

/** Transfer: ONE row carrying both sides, same as the sheet. Same idempotency contract. */
export async function createTransfer(args, env) {
  const r = await refs(env);
  if (!args.Account || !args.ToAccount) throw new Error('Transfer needs both Account and ToAccount.');
  const acct = resolveAccount(r, args.Account);
  if (!acct) throw new Error('Unknown Account: ' + args.Account);
  const to = resolveAccount(r, args.ToAccount);
  if (!to) throw new Error('Unknown ToAccount: ' + args.ToAccount);
  // Compare the RESOLVED rows, not the strings: "maribank" and "MariBank" name one
  // account, and a self-transfer would otherwise slip through as two different names.
  if (acct.id === to.id) throw new Error('Account and ToAccount must differ.');
  if (!args.Category) throw new Error('Transfer needs a Category (Transfer type).');
  const cat = resolveCategory(r, args.Category);
  if (!cat) throw new Error('Unknown Category: ' + args.Category);
  assertShape(cat.type, true);
  if (args.Amount === undefined || isNaN(parseFloat(args.Amount)))
    throw new Error('Missing/invalid Amount (source amount).');
  assertNonZero('Amount', args.Amount);

  const given = args.ToAmount !== undefined && args.ToAmount !== null && args.ToAmount !== '';
  // Two currencies, no ToAmount: the copy below would credit $100 out as ₱100 in, at a
  // stamped rate of 1. Quick add did exactly that for "100 wise to bpi" (bug audit,
  // 2026-09-23). Refuse it — only the sender knows what arrived.
  if (!given && curOf(acct) !== curOf(to))
    throw new Error('A transfer from ' + acct.currency + ' to ' + to.currency +
                    ' needs ToAmount (the amount that arrived).');
  // Number, not parseFloat: parseFloat("5,600") is 5, and would be stored as such.
  const toAmount = given ? Number(args.ToAmount) : Number(args.Amount);
  assertNonZero('ToAmount', given ? args.ToAmount : args.Amount);
  const id = args.ID || crypto.randomUUID();
  const fx = await impliedRate(env, acct, to, args.Amount, toAmount, args.ExchangeRate);
  const row = { date: parseDate(args.Date), category_id: cat.id, account_id: acct.id, amount_u: toU(args.Amount) };
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO transactions (id, date, period, category_id, description, account_id, amount_u, fx_rate, to_account_id, to_amount_u) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id, row.date, parsePeriod(args.Period) || null, cat.id,
            args.Description || '', acct.id, row.amount_u, fx.blank ? null : fx.rate,
            to.id, toU(toAmount))
  ]);
  const transaction = await txById(env, r, id);
  if (!res.meta.changes) return { status: 'duplicate', message: 'ID already exists.', transaction };
  const out = { status: 'success', message: 'Transfer created.', transaction };
  const dup = await duplicateWarning(env, id, row);
  if (fx.warning || dup) out.warning = [fx.warning, dup].filter(Boolean).join(' ');
  return out;
}

export async function updateTransaction(args, env) {
  if (!args.ID) throw new Error('update requires an ID.');
  const r = await refs(env);
  const cur = await txById(env, r, args.ID);
  if (!cur) throw new Error('No transaction with ID: ' + args.ID);

  const nCat = args.Category === undefined ? null : resolveCategory(r, args.Category);
  const nAcct = args.Account === undefined ? null : resolveAccount(r, args.Account);
  const nTo = (args.ToAccount === undefined || args.ToAccount === '') ? null : resolveAccount(r, args.ToAccount);
  if (args.Category !== undefined && !nCat) throw new Error('Unknown Category: ' + args.Category);
  if (args.Account !== undefined && !nAcct) throw new Error('Unknown Account: ' + args.Account);
  if (args.ToAccount !== undefined && args.ToAccount !== '' && !nTo)
    throw new Error('Unknown ToAccount: ' + args.ToAccount);

  const patch = {};
  TX_CLIENT_FIELDS.forEach((f) => { if (args[f] !== undefined) patch[f] = args[f]; });
  // Canonical names from here down — every lookup below indexes the exact-name maps.
  if (nCat) patch.Category = nCat.name;
  if (nAcct) patch.Account = nAcct.name;
  if (nTo) patch.ToAccount = nTo.name;
  if (!Object.keys(patch).length) throw new Error('Nothing to update.');

  if (patch.Amount !== undefined) assertNonZero('Amount', patch.Amount);
  if (patch.ToAmount !== undefined && patch.ToAmount !== '') assertNonZero('ToAmount', patch.ToAmount);

  const effCat = patch.Category !== undefined ? patch.Category : cur.Category;
  const effTo = patch.ToAccount !== undefined ? patch.ToAccount : cur.ToAccount;
  assertShape(r.catByName[effCat] ? r.catByName[effCat].type : null, hasTo(effTo));
  const mirrored = mirrorToAmount(cur, patch);
  if (mirrored !== undefined) patch.ToAmount = mirrored;

  const acct = r.acctByName[patch.Account !== undefined ? patch.Account : cur.Account];
  const dst = hasTo(effTo) ? r.acctByName[effTo] : null;
  // createTransfer refuses this; an edit must not be the way round it.
  if (dst && acct && dst.id === acct.id) throw new Error('Account and ToAccount must differ.');

  const set = [], bind = [];
  const put = (col, v) => { set.push(col + ' = ?'); bind.push(v); };
  if (patch.Date !== undefined) put('date', parseDate(patch.Date));
  if (patch.Period !== undefined) put('period', parsePeriod(patch.Period) || null);
  if (patch.Category !== undefined) put('category_id', r.catByName[patch.Category].id);
  if (patch.Description !== undefined) put('description', patch.Description || '');
  if (patch.Account !== undefined) put('account_id', r.acctByName[patch.Account].id);
  if (patch.Amount !== undefined) put('amount_u', toU(patch.Amount));
  if (patch.ToAccount !== undefined) put('to_account_id', hasTo(patch.ToAccount) ? r.acctByName[patch.ToAccount].id : null);
  if (patch.ToAmount !== undefined) put('to_amount_u', patch.ToAmount === '' ? null : toU(patch.ToAmount));
  // Re-stamp the rate only when it can have changed: the client sent one (including ''
  // to clear a manual override), the source CURRENCY changed, or a transfer that lands
  // in pesos had a leg edited — its rate IS ToAmount/Amount. Anything else keeps the
  // stamp, so history never reprices. "The Account was sent" is not a reason: the
  // transfer form sends it on every save, and that put today's live rate on a months-old
  // conversion, erasing its implied rate (bug audit, 2026-09-23).
  const amt = patch.Amount !== undefined ? patch.Amount : cur.Amount;
  const toAmt = patch.ToAmount !== undefined ? patch.ToAmount : cur.ToAmount;
  const legMoved = ['Account', 'ToAccount', 'Amount', 'ToAmount'].some((k) => patch[k] !== undefined);
  if (args.ExchangeRate !== undefined || (acct && curOf(acct) !== String(cur.Currency).toUpperCase()) ||
      (dst && legMoved && impliedUsable(acct, dst, amt, toAmt, args.ExchangeRate))) {
    const fx = dst ? await impliedRate(env, acct, dst, amt, toAmt, args.ExchangeRate)
                   : await resolveRate(env, acct ? acct.currency : '', args.ExchangeRate);
    put('fx_rate', fx.blank ? null : fx.rate);
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE transactions SET ' + set.join(', ') + ' WHERE id = ?').bind(...bind, args.ID)
  ]);
  return { status: 'success', message: 'Transaction updated.', transaction: await txById(env, r, args.ID) };
}

export async function deleteTransaction(args, env) {
  if (!args.ID) throw new Error('delete requires an ID.');
  const r = await refs(env);
  const snapshot = await txById(env, r, args.ID);
  if (!snapshot) throw new Error('No transaction with ID: ' + args.ID);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(args.ID)
  ]);
  return { status: 'success', message: 'Transaction deleted.', transaction: snapshot };
}

export async function bulkUpdateTransactions(args, env) {
  const ids = (args.ids || []).map(String);
  const patch = args.patch || {};
  if (!ids.length) throw new Error('bulkUpdate requires a non-empty ids[].');
  const r = await refs(env);
  const nCat = patch.Category === undefined ? null : resolveCategory(r, patch.Category);
  const nAcct = patch.Account === undefined ? null : resolveAccount(r, patch.Account);
  const nTo = (patch.ToAccount === undefined || patch.ToAccount === '') ? null : resolveAccount(r, patch.ToAccount);
  if (patch.Category !== undefined && !nCat) throw new Error('Unknown Category: ' + patch.Category);
  if (patch.Account !== undefined && !nAcct) throw new Error('Unknown Account: ' + patch.Account);
  if (patch.ToAccount !== undefined && patch.ToAccount !== '' && !nTo)
    throw new Error('Unknown ToAccount: ' + patch.ToAccount);

  const p = {};
  TX_CLIENT_FIELDS.forEach((f) => { if (patch[f] !== undefined) p[f] = patch[f]; });
  // Canonical names from here down — every lookup below indexes the exact-name maps.
  if (nCat) p.Category = nCat.name;
  if (nAcct) p.Account = nAcct.name;
  if (nTo) p.ToAccount = nTo.name;
  if (!Object.keys(p).length) throw new Error('Nothing to update.');

  if (p.Amount !== undefined) assertNonZero('Amount', p.Amount);
  if (p.ToAmount !== undefined && p.ToAmount !== '') assertNonZero('ToAmount', p.ToAmount);

  const found = (await env.DB.prepare(
    'SELECT t.id, t.account_id, t.to_account_id, c.type AS type FROM transactions t JOIN categories c ON c.id = t.category_id ' +
    'WHERE t.id IN (' + list(ids.length) + ')').bind(...ids).all()).results;
  const have = new Set(found.map((x) => x.id));
  const skipped = ids.filter((id) => !have.has(id));

  // Shape guard: reject a Category/ToAccount mismatch on ANY affected row before
  // touching the first one (v1 did the same, per-row, off two column reads).
  if (p.Category !== undefined || p.ToAccount !== undefined) {
    found.forEach((row) => {
      const type = p.Category !== undefined ? r.catByName[p.Category].type : row.type;
      const to = p.ToAccount !== undefined ? p.ToAccount : row.to_account_id;
      assertShape(type, hasTo(to));
    });
  }
  // No row may end up a transfer to itself (createTransfer refuses one).
  const newFrom = p.Account !== undefined ? r.acctByName[p.Account].id : null;
  const newTo = hasTo(p.ToAccount) ? r.acctByName[p.ToAccount].id : null;
  found.forEach((row) => {
    const from = newFrom || row.account_id, to = p.ToAccount !== undefined ? newTo : row.to_account_id;
    if (to && from === to) throw new Error('Account and ToAccount must differ (row ' + row.id + ').');
  });

  const set = [], bind = [];
  const put = (col, v) => { set.push(col + ' = ?'); bind.push(v); };
  if (p.Date !== undefined) put('date', parseDate(p.Date));
  if (p.Period !== undefined) put('period', parsePeriod(p.Period) || null);
  if (p.Category !== undefined) put('category_id', r.catByName[p.Category].id);
  if (p.Description !== undefined) put('description', p.Description || '');
  if (p.Account !== undefined) put('account_id', r.acctByName[p.Account].id);
  if (p.Amount !== undefined) put('amount_u', toU(p.Amount));
  if (p.ToAccount !== undefined) put('to_account_id', hasTo(p.ToAccount) ? r.acctByName[p.ToAccount].id : null);
  if (p.ToAmount !== undefined) put('to_amount_u', p.ToAmount === '' ? null : toU(p.ToAmount));
  const acct = p.Account !== undefined ? r.acctByName[p.Account] : null;
  if (patch.ExchangeRate !== undefined) {
    // ponytail: an explicit rate goes on every row, resolved against the new account's
    // currency (or none) — no UI path sends one; it is here for the API's sake.
    const fx = await resolveRate(env, acct ? acct.currency : '', patch.ExchangeRate);
    put('fx_rate', fx.blank ? null : fx.rate);
  } else if (acct) {
    // A reassign re-stamps ONLY the rows whose currency changes. The rest keep their
    // rate: moving old dollar rows between two dollar accounts used to put today's rate
    // on all of them. SQLite evaluates every SET expression against the OLD row, so the
    // subquery reads the account the row is leaving.
    const fx = await resolveRate(env, acct.currency);
    set.push('fx_rate = CASE WHEN UPPER((SELECT currency FROM accounts WHERE id = transactions.account_id)) = ? ' +
             'THEN fx_rate ELSE ? END');
    bind.push(curOf(acct), fx.blank ? null : fx.rate);
  }

  const targets = [...have];
  if (targets.length) {
    await env.DB.batch([
      env.DB.prepare('UPDATE transactions SET ' + set.join(', ') + ' WHERE id IN (' + list(targets.length) + ')')
        .bind(...bind, ...targets)
    ]);
  }
  return { status: 'success', message: 'Bulk update complete.', updated: targets.length, skipped };
}

export async function bulkDeleteTransactions(args, env) {
  const ids = (args.ids || []).map(String);
  if (!ids.length) throw new Error('bulkDelete requires a non-empty ids[].');
  const found = (await env.DB.prepare('SELECT id FROM transactions WHERE id IN (' + list(ids.length) + ')')
    .bind(...ids).all()).results.map((x) => x.id);
  const have = new Set(found);
  if (found.length) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM transactions WHERE id IN (' + list(found.length) + ')').bind(...found)
    ]);
  }
  return { status: 'success', message: 'Bulk delete complete.', deleted: found.length,
           skipped: ids.filter((id) => !have.has(id)) };
}

// ── accounts ─────────────────────────────────────────────────────────────────
// Editable account fields, keyed by the wire name the SPA still sends (the sheet's
// header text). Anything else in the payload is ignored, as ACCOUNT_EDITABLE did.
const ACCOUNT_EDITABLE = {
  'Starting Balance': ['starting_balance_u', 'money'],
  'Interest Frequency': ['interest_frequency', 'text'],
  'Interest Rate': ['interest_rate', 'num'],
  'Credit Limit': ['credit_limit_u', 'money'],
  Notes: ['notes', 'text'],
  Color: ['color', 'text']
};

export async function updateAccount(args, env) {
  if (!args.Name) throw new Error('updateAccount requires Name.');
  const set = [], bind = [];
  Object.keys(ACCOUNT_EDITABLE).forEach((field) => {
    if (args[field] === undefined) return;
    const [col, kind] = ACCOUNT_EDITABLE[field];
    const raw = args[field];
    let v;
    if (kind === 'money') v = (raw === '' || raw === null) ? null : toU(raw);
    else if (kind === 'num') v = (raw === '' || raw === null) ? null : Number(raw);
    else v = raw === null ? '' : String(raw);
    set.push(col + ' = ?'); bind.push(v);
  });
  if (!set.length) throw new Error('No editable fields supplied. Editable: ' + Object.keys(ACCOUNT_EDITABLE).join(', '));
  // Resolve the target first: the UPDATE matches on the exact name, so a case slip would
  // otherwise report "Unknown Account" for an account that is right there.
  const target = resolveAccount(await refs(env), args.Name);
  if (!target) throw new Error('Unknown Account: ' + args.Name);
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET ' + set.join(', ') + ' WHERE id = ?').bind(...bind, target.id)
  ]);
  if (!res.meta.changes) throw new Error('Unknown Account: ' + args.Name);
  return { status: 'success', message: 'Account updated.', name: target.name, fieldsWritten: set.length };
}

// ── admin grid + export ──────────────────────────────────────────────────────
/**
 * The server-side table whitelist behind the Admin screen. There is deliberately no
 * SQL console: anything this grid cannot express is `wrangler d1 execute` from the
 * owner's machine, where it belongs.
 *
 *   edit  — columns an UPDATE may touch
 *   add   — columns an INSERT may set (a natural primary key appears here, not in edit:
 *           renaming one under a live foreign key is a data-loss move, not a cell edit)
 *   money — micros columns, converted to/from decimals at this boundary like every
 *           other handler, so the grid shows 47200 and not 47200000000
 *
 * `transactions` is read + delete only: it has real handlers with validation, FX
 * stamping and version bumping, and the grid must not be a way around them. Delete
 * stays for surgery on a row the UI cannot reach.
 *
 * KEY ORDER IS THE ADMIN PICKER'S BUTTON ORDER — listTable ships `tables` and the
 * screen draws its row of buttons from that, so this is the only place the set of
 * tables (and the order they are offered in) is written down. Most-used first.
 */
const TABLES = {
  accounts: {
    pk: 'id',
    edit: ['name', 'currency', 'subtype', 'symbol', 'starting_balance_u', 'interest_frequency',
           'interest_rate', 'credit_limit_u', 'notes', 'color'],
    money: ['starting_balance_u', 'credit_limit_u'], num: ['interest_rate']
  },
  categories: { pk: 'id', edit: ['name', 'type', 'segment', 'description'] },
  account_types: { pk: 'subtype', edit: ['type'], add: ['subtype', 'type'] },
  budgets: { pk: 'id', edit: ['segment', 'period', 'target_type', 'target', 'currency', 'notes'],
             num: ['target'] },
  recurring: {
    pk: 'id', edit: ['description', 'currency', 'amount_u', 'fee_u', 'months_left', 'grp'],
    money: ['amount_u', 'fee_u']
  },
  ledger: { pk: 'id', edit: ['tx_id', 'bsp_rate', 'filed', 'date_received', 'wise_amount_u'],
            money: ['wise_amount_u'], num: ['bsp_rate'] },
  prices: { pk: 'rowid', edit: [], add: ['symbol', 'priced_at', 'price', 'currency'], num: ['price'] },
  // Cron-owned history: fully read-only (nodelete) so the grid can't corrupt or
  // hole the net-worth line. money cols render as PHP, not micros.
  nw_snapshots: { pk: 'month', edit: [], nodelete: true,
                  money: ['net_worth_u', 'assets_u', 'liabilities_u', 'shares_u'] },
  meta: { pk: 'key', edit: ['value'], add: ['key', 'value'] },
  transactions: { pk: 'id', edit: [], money: ['amount_u', 'to_amount_u', 'amount_php_u'] },
  email_quotes: { pk: 'message_id', edit: [] }
};

function tableSpec(name) {
  const t = TABLES[String(name || '')];
  if (!t) throw new Error('Unknown table: ' + name + '. Allowed: ' + Object.keys(TABLES).join(', '));
  return t;
}
const moneyCols = (t) => t.money || [];
const addCols = (t) => t.add || t.edit;

export async function listTable(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  const limit = Math.min(1000, Math.max(1, parseInt(args.limit, 10) || 200));
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const pkSel = t.pk === 'rowid' ? 'rowid AS rowid, ' : '';
  const [cnt, page] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM ' + name),
    env.DB.prepare('SELECT ' + pkSel + '* FROM ' + name + ' ORDER BY ' + t.pk + ' LIMIT ? OFFSET ?')
      .bind(limit, offset)
  ]);
  const rows = page.results.map((row) => {
    const o = Object.assign({}, row);
    moneyCols(t).forEach((c) => { if (c in o) o[c] = fromU(o[c]); });
    return o;
  });
  return {
    status: 'success',
    table: name, pk: t.pk, editable: t.edit, addable: addCols(t), money: moneyCols(t),
    deletable: !t.nodelete,
    tables: Object.keys(TABLES),   // the Admin screen's picker buttons, in TABLES order
    cols: rows.length ? Object.keys(rows[0]) : addCols(t),
    total: cnt.results[0].n, offset, limit, rows
  };
}

/**
 * Decimal -> micros for the whitelisted money columns, a real Number for the `num`
 * (REAL-affinity) ones, and everything else passes through.
 *
 * `num` exists because the grid hands every cell over as a typed STRING, and SQLite's
 * REAL affinity converts "57.5" but NOT "1,234.5" — a thousands separator silently
 * lands a TEXT value in a numeric column, which then reads as 0 in every sum. Only the
 * columns declared numeric are stripped, so a description with commas in it is safe.
 */
function coerceCell(t, col, value) {
  const num = () => {
    const n = Number(String(value).replace(/,/g, ''));
    if (isNaN(n)) throw new Error(col + ' must be a number, not "' + value + '".');
    return n;
  };
  // Money cells take the same thousands separator. toU("1,000") is NaN, and D1 sends NaN
  // as null: a typed credit limit or recurring amount was silently CLEARED under a
  // "Saved" toast (bug audit, 2026-09-23).
  if (moneyCols(t).indexOf(col) !== -1) return (value === '' || value == null) ? null : toU(num());
  if (value === '') return null;
  if ((t.num || []).indexOf(col) !== -1 && value != null) return num();
  return value;
}

/**
 * Cells that rewrite the MEANING of history, not just a label. Flipping an
 * account_type Asset↔Liability inverts every past delta on every account of that
 * subtype; changing an account's currency reprices every fx-NULL row it carries;
 * changing a category's type breaks the Transfer⇔ToAccount invariant on rows already
 * written. Each is frozen while any transaction references the record — the numbers
 * would silently change under rows nobody re-checked. Escape hatch, deliberately
 * outside the app: `wrangler d1 execute`, followed by fixing up the affected rows.
 *
 * `binds` is how many times the pk goes into the statement.
 */
const FROZEN_CELLS = {
  'categories|type': { sql: 'SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', binds: 1 },
  'accounts|currency': { sql: 'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?', binds: 2 },
  'accounts|subtype': { sql: 'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?', binds: 2 },
  'account_types|type': { sql: 'SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ' +
                               'ON a.id = t.account_id OR a.id = t.to_account_id WHERE a.subtype = ?', binds: 1 }
};

async function assertNotFrozen(env, table, col, pk) {
  const f = FROZEN_CELLS[table + '|' + col];
  if (!f) return;
  const row = await env.DB.prepare(f.sql).bind(...new Array(f.binds).fill(pk)).first();
  if (row && row.n) throw new Error(
    table + '.' + col + ' is frozen: ' + row.n + ' transaction(s) reference this row, and changing it ' +
    'rewrites what they mean. Use `wrangler d1 execute` if that is really the intent.');
}

export async function updateTableCell(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  const col = String(args.column || '');
  if (t.edit.indexOf(col) === -1)
    throw new Error(col + ' is not editable on ' + name + '. Editable: ' + (t.edit.join(', ') || '(none)'));
  if (args.pk === undefined || args.pk === null || args.pk === '') throw new Error('updateTableCell requires pk.');
  await assertNotFrozen(env, name, col, args.pk);
  const [res] = await env.DB.batch([
    env.DB.prepare('UPDATE ' + name + ' SET ' + col + ' = ? WHERE ' + t.pk + ' = ?')
      .bind(coerceCell(t, col, args.value), args.pk)
  ]);
  if (!res.meta.changes) throw new Error('No ' + name + ' row with ' + t.pk + ' = ' + args.pk);
  return { status: 'success', table: name, pk: args.pk, column: col };
}

export async function insertTableRow(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  const allowed = addCols(t);
  if (!allowed.length) throw new Error(name + ' is read-only in the admin grid.');
  const row = args.row || {};
  const cols = [], vals = [];
  Object.keys(row).forEach((c) => {
    if (allowed.indexOf(c) === -1) return;
    cols.push(c); vals.push(coerceCell(t, c, row[c]));
  });
  if (!cols.length) throw new Error('Nothing to insert. Settable: ' + allowed.join(', '));
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO ' + name + ' (' + cols.join(',') + ') VALUES (' + list(cols.length) + ')').bind(...vals)
  ]);
  return { status: 'success', table: name, pk: res.meta.last_row_id };
}

export async function deleteTableRow(args, env) {
  const name = String(args.table || '');
  const t = tableSpec(name);
  if (t.nodelete) throw new Error(name + ' is read-only in the admin grid.');
  if (args.pk === undefined || args.pk === null || args.pk === '') throw new Error('deleteTableRow requires pk.');
  const [res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM ' + name + ' WHERE ' + t.pk + ' = ?').bind(args.pk)
  ]);
  if (!res.meta.changes) throw new Error('No ' + name + ' row with ' + t.pk + ' = ' + args.pk);
  return { status: 'success', table: name, pk: args.pk, deleted: res.meta.changes };
}

/**
 * Every table as raw JSON — backup layer 1 (the nightly GAS pull into a spreadsheet)
 * and the admin screen's CSV download. Raw means micros as stored: a backup is for
 * fidelity, not for reading.
 *
 * Named getExportAll rather than the plan's `exportAll` because the get…/list… prefix
 * is what picks GET vs POST in the SPA's gs(), and test.js enforces it.
 */
export async function getExportAll(args, env) {
  const names = Object.keys(TABLES);
  const res = await env.DB.batch(names.map((n) => env.DB.prepare('SELECT * FROM ' + n)));
  const tables = {};
  names.forEach((n, i) => { tables[n] = res[i].results; });
  return { status: 'success',
           exportedAt: new Date().toISOString(), tables };
}
