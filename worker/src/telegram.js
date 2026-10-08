/**
 * telegram.js — the bot, now running in the Worker instead of Apps Script.
 *
 * Telegram already delivers to this Worker's /tg (it always did; the Worker existed
 * because Apps Script answers a POST with a 302 and Telegram rejects a redirecting
 * webhook). The only change is that /tg no longer forwards the update to GAS — it
 * handles it here. So the webhook URL does NOT change and setWebhook does NOT need
 * re-running: no GAS boot, no 302 dance, no waitUntil fire-and-forget guesswork,
 * and replies get faster.
 *
 * Everything the owner touches is unchanged: intents, receipts, the ↻ Undo and
 * ✎ Edit details buttons, ⌕ Email, /undo, /balance, one-message-many-transactions.
 * Undo state moved from the TG_LAST_IDS Script Property to meta.tg_last_ids.
 *
 * Two things that look removable and are not:
 *   * the update_id dedup (tg_seen_), which is now a QUEUE. Telegram redelivers until
 *     it gets a timely answer, and one Gemini round trip is slow enough to lose that
 *     race; without a claim, a redelivery starts a SECOND parse and posts a second
 *     receipt. The claim is durable (D1), not cached, because there is no CacheService
 *     here. It carries the update itself (v2.12.0), so an unfinished row is work the
 *     drain cron can re-run — a claim that outlives its execution used to turn one bad
 *     minute into a message that was gone for good.
 *   * the glyph rule. A text variation selector does not stop Telegram emoji-fying a
 *     codepoint, so the buttons use ↻ ⌕ ✎ (outside the emoji set) and never ↩ ✉ ✏.
 *     Guarded by test.js.
 */
import { refs, metaGet, metaSet, manilaToday, parseMonthKey, monthKey } from './db.js';
import { parse, emailText, EMAIL_TIMEOUT_MS, EMAIL_BUDGET_MS } from './gemini.js';
import { createTransaction, createTransfer, deleteTransaction, listTransactions, getAccounts } from './api.js';

const API = 'https://api.telegram.org/bot';
const HELP = '✦ Just send a transaction in plain language.\n' +
             'Check balances: `how much do I have` / `how much is in maya` (or /balance)\n' +
             "Take it back: `undo` (or /undo) removes the last message's rows.";

// ── entry point (POST /tg) ───────────────────────────────────────────────────
/**
 * Never throws to the caller: a non-2xx tells Telegram to redeliver, and a message we
 * already failed to parse will fail again. Problems are reported in the chat.
 *
 * EVERY failure ends in a message or in a released claim — never in silence. route()
 * answers its own errors, but the work around them did not: a D1 read, the send itself
 * or the Worker being cut off mid-waitUntil left console.error as the only trace, and a
 * log nobody tails is the same as nothing. The owner then has no way to tell a message
 * the bot refused from one it never received (2026-09-02).
 */
export async function handleUpdate(env, update) {
  const updateId = update && update.update_id;
  try {
    if (await seen(env, update)) return;
    await route(env, update);
    await settle(env, updateId);
  } catch (err) {
    console.error('telegram: ' + (err && err.stack ? err.stack : err));
    // Say what broke, and close the row: the owner has been told, so a redelivery must
    // not repeat the complaint and the drain must not replay the work. If even that
    // cannot be delivered, drop the claim instead, so Telegram's own redelivery gets a
    // real second attempt — the row ids are idempotent (tg-<update_id>-<i>), so a
    // retry cannot write a transaction twice.
    if (await report(env, update, err)) await settle(env, updateId);
    else await unsee(env, updateId);
  }
}

/**
 * Tell the owner the turn died, in the chat where it died. Returns false when the
 * message could not be delivered at all — which is the only case that may release the
 * claim, and is safe precisely because nothing was said.
 */
async function report(env, update, err) {
  const msg = (update && update.message) || {};
  const cq = update && update.callback_query;
  const chat = (msg.chat && msg.chat.id) || (cq && cq.message && cq.message.chat && cq.message.chat.id)
               || env.TELEGRAM_USER_ID;
  if (!chat) return false;
  try {
    return await send(env, chat, '❌ *Something went wrong*\n› ' + msgOf(err) +
                      '\n› _Nothing was logged. Send it again._', msg.message_id) !== false;
  } catch (e) {
    console.error('telegram: report failed: ' + msgOf(e));
    return false;
  }
}

/**
 * Claim an update, returning true if it was already claimed. Durable (D1) rather than
 * cached — there is no CacheService here.
 *
 * Claimed UP FRONT, so a redelivery cannot start a second parse while the first is
 * still running — that is the retry storm this exists to stop. The claim CARRIES THE
 * UPDATE (v2.12.0): a claim on its own says "someone took this", which is
 * indistinguishable from "this was lost", and that ambiguity is what let one torn-down
 * turn destroy a transaction for good. With the payload stored, an unfinished row is
 * recoverable work and drainUpdates() re-runs it.
 */
async function seen(env, update, now = Date.now()) {
  const updateId = update && update.update_id;
  if (!updateId) return false;
  const [res] = await env.DB.batch([
    env.DB.prepare('INSERT INTO seen_updates (update_id, at, payload, done) VALUES (?, ?, ?, 0) ' +
                   'ON CONFLICT(update_id) DO NOTHING')
      .bind(updateId, now, JSON.stringify(update)),
    // Sweep FINISHED rows only. A pending row is unfinished work, and the drain is what
    // retires it — deleting one here would be the silent loss this table now prevents.
    env.DB.prepare('DELETE FROM seen_updates WHERE done = 1 AND at < ?').bind(now - 86400000),
    // Remember the origin for the drain. env.APP_URL is the request's own origin, so a
    // cron firing has none, and a rescued receipt would silently lose its ✎ Edit button.
    // Riding this batch keeps it to zero extra round trips, and it self-heals per
    // environment — staging stores staging's origin.
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('app_url', ?) " +
                   'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(env.APP_URL || '')
  ]);
  return !res.meta.changes;
}

/**
 * Release an update claim. Only handleUpdate calls it, and only when the failure could
 * not even be reported: Telegram redelivers an update it has not heard back about, and
 * that redelivery is the last chance the message has. Deleting rather than settling is
 * deliberate — the drain would work too, but Telegram's own retry is faster and the
 * two must not both run the turn.
 */
async function unsee(env, updateId) {
  if (!updateId) return;
  try { await env.DB.prepare('DELETE FROM seen_updates WHERE update_id = ?').bind(updateId).run(); }
  catch (err) { console.error('telegram: could not release update ' + updateId + ': ' + msgOf(err)); }
}

/**
 * Close a row: the turn ended, in a receipt or in a reported error. The payload goes
 * with it — it has served its purpose, and the bot should not keep the owner's message
 * text a day longer than the retry window needs.
 *
 * A settle that FAILS leaves the row pending, so the drain re-runs a turn that already
 * finished. That is the safe direction to be wrong in: the row ids are idempotent, so
 * the rescue re-sends the receipt as "Already logged" and writes nothing.
 */
async function settle(env, updateId) {
  if (!updateId) return;
  try {
    await env.DB.prepare('UPDATE seen_updates SET done = 1, payload = NULL WHERE update_id = ?')
      .bind(updateId).run();
  } catch (err) { console.error('telegram: could not settle update ' + updateId + ': ' + msgOf(err)); }
}

// ── the rescue drain (cron) ──────────────────────────────────────────────────
/**
 * How long a claimed turn may stay unfinished before the drain assumes it is dead, how
 * many rescues one update gets, and how many rows one drain may take.
 *
 * STALE_MS sits far above TURN_CEILING_MS on purpose. The cost of calling a turn dead
 * too early is a second turn beside the first: no duplicate row (the ids are
 * idempotent) but a duplicate receipt, and a receipt the owner did not expect is the
 * confusion this whole area exists to remove. Nothing on Cloudflare survives two
 * minutes of wall clock, so a row that old is not running.
 */
export const STALE_MS = 120000;
export const MAX_ATTEMPTS = 3;
export const DRAIN_LIMIT = 5;

/**
 * Re-run the turns that never finished. Returns how many it completed.
 *
 * This is the floor under everything else. /tg reports what it can see going wrong; the
 * drain answers what it cannot — an invocation cut off mid-turn, which throws nothing
 * and so reaches no catch. A message the owner sent now ends in a receipt or in an
 * error message, and the worst case is that it arrives a few minutes late.
 *
 * It calls route() and NOT handleUpdate(), because handleUpdate claims first and the
 * row is already claimed — the rescue would see its own claim and return.
 *
 * `at` is re-stamped BEFORE the work, so an overlapping drain leaves the row alone for
 * another STALE_MS and two rescues cannot run the same turn side by side. That write
 * also spends the attempt: a rescue that dies the same way its turn did must not retry
 * forever, and MAX_ATTEMPTS is what turns a poisonous update into one error message.
 */
export async function drainUpdates(env, now = Date.now()) {
  let rows;
  try {
    rows = (await env.DB.prepare(
      'SELECT update_id, payload, attempts FROM seen_updates ' +
      'WHERE done = 0 AND payload IS NOT NULL AND at <= ? ORDER BY update_id LIMIT ?'
    ).bind(now - STALE_MS, DRAIN_LIMIT).all()).results || [];
  } catch (err) {
    console.error('telegram: the drain could not read the queue: ' + msgOf(err));
    return 0;
  }
  if (!rows.length) return 0;
  // A cron has no request, so no origin. seen() stored the last one it saw; without it
  // the receipt still lands, only without its ✎ Edit button.
  const runEnv = env.APP_URL ? env
    : Object.assign({}, env, { APP_URL: await metaGet(env, 'app_url').catch(() => '') });
  let rescued = 0;
  for (const row of rows) {
    const attempt = (row.attempts || 0) + 1;
    try {
      await env.DB.prepare('UPDATE seen_updates SET attempts = ?, at = ? WHERE update_id = ?')
        .bind(attempt, now, row.update_id).run();
    } catch (err) {
      // The claim cannot be re-stamped, so a second drain would run this row beside us.
      console.error('telegram: could not claim update ' + row.update_id + ' for rescue: ' + msgOf(err));
      continue;
    }
    let update = null;
    try { update = JSON.parse(row.payload); } catch (err) { /* not recoverable, closed below */ }
    if (!update) {
      console.error('telegram: update ' + row.update_id + ' has an unreadable payload');
      await settle(env, row.update_id);
      continue;
    }
    console.warn('telegram: rescuing update ' + row.update_id + ', attempt ' + attempt);
    // Say it ONCE, and only here. A turn that finishes on its own never speaks: the
    // notice used to fire on a 6-second timer inside every live turn, so a merely slow
    // parse — the common case — always sent one. A rescue is the case worth a word:
    // the message is minutes old and the owner has had silence. Fire-and-forget, and
    // only for a chat message, because route() answers a callback in its own bubble.
    if (attempt === 1 && update.message && update.message.text) {
      Promise.resolve(send(runEnv, update.message.chat.id,
        '⏳ *Still working…*\n› _That one took too long. Picking it up again now._',
        update.message.message_id))
        .catch((err) => console.error('telegram: slow notice failed: ' + msgOf(err)));
    }
    try {
      await route(runEnv, update);
      await settle(env, row.update_id);
      rescued++;
    } catch (err) {
      console.error('telegram: rescue of ' + row.update_id + ' failed: ' + msgOf(err));
      // Out of attempts: say so once and close the row. Leaving it open would repeat
      // the same failure every two minutes for a day.
      if (attempt >= MAX_ATTEMPTS) {
        await report(runEnv, update, err);
        await settle(env, row.update_id);
      }
    }
  }
  return rescued;
}

async function route(env, update) {
  if (update && update.callback_query) return callback(env, update.callback_query);
  const msg = update && update.message;
  if (!msg || !msg.text) return;                       // ignore photos/stickers/edits
  const chat = msg.chat.id, replyTo = msg.message_id;

  if (String(msg.from && msg.from.id) !== String(env.TELEGRAM_USER_ID)) {
    return send(env, chat, '⛔ *Unauthorized. This bot is private.*');
  }

  const text = String(msg.text).trim();
  if (text.charAt(0) === '/') {
    const cmd = text.slice(1).split(/[\s@]/)[0];
    if (cmd === 'undo') return undo(env, chat, replyTo);
    if (cmd === 'balance') return balance(env, chat, null, replyTo);   // no parse needed
    return send(env, chat, HELP, replyTo);
  }

  const r = await refs(env);
  let parsed;
  try {
    parsed = await parse(env, r, text, msg.date);
  } catch (err) {
    return send(env, chat, '❌ *Failed to add transaction*\n› ' + msgOf(err), replyTo);
  }
  if (parsed.error) return send(env, chat, '❌ *Failed to add transaction*\n› ' + parsed.error, replyTo);

  if (parsed.intent === 'undo') return undo(env, chat, replyTo);
  if (parsed.intent === 'balance') return balance(env, chat, parsed.query, replyTo);
  if (parsed.intent === 'query') {
    try { return send(env, chat, await queryReply(env, parsed.query), replyTo); }
    catch (err) { return send(env, chat, '❌ *Query failed*\n› ' + msgOf(err), replyTo); }
  }

  const items = parsed.items || [];
  if (!items.length) return send(env, chat, '❌ *Failed to add transaction*\n› Nothing to log.', replyTo);
  await logItems(env, chat, 'tg-' + update.update_id, items, replyTo);
}

/**
 * How long the whole turn may take.
 *
 * /tg holds Telegram's webhook connection open until the turn finishes (v2.11.0), so
 * the limit is Telegram's patience for a reply, not Cloudflare's waitUntil allowance.
 * Telegram does not document that number, so TURN_CEILING_MS is deliberately
 * conservative rather than tuned: the parse budget plus the writes plus the send must
 * fit inside it, and a contract guard in test.js fails the build if they stop fitting.
 * Being wrong costs one redelivery, which seen() dedups — not a duplicated row.
 */
export const TURN_CEILING_MS = 25000;

// ── log (one or many transactions per message) ───────────────────────────────
/**
 * Create every parsed item, reply once, and remember the IDs for undo. A failing item
 * reports itself and the rest still land — a five-line message should not be lost
 * because line three named an account that does not exist.
 *
 * `idPrefix` identifies the source and makes the row IDs idempotent under retries:
 * "tg-<update_id>" for a chat message, "gm-<messageId>" for an ingested email. Row
 * IDs are "<idPrefix>-<rank>" (see below). `mailId` adds the ⌕ Email button. Returns the IDs that
 * landed — the Gmail courier only trashes the mail when every item made it.
 *
 * ponytail: one service call per item. There is no bulk create, and a message carries
 * a handful of transactions, not hundreds.
 */
export async function logItems(env, chat, idPrefix, items, replyTo, mailId) {
  const out = [], ids = [], idx = [], touched = new Set();
  // One read for the whole message, not one per item: resolveAccountName needs the live
  // account list to turn what the model wrote into the name the ledger knows.
  const { accounts, categories } = await refs(env);
  const all = items.map((p) => ({
    Date: p.Date, Category: xferCategory(categories, p), Description: p.Description,
    Account: resolveAccountName(accounts, p.Account),
    Amount: p.Amount, ExchangeRate: p.ExchangeRate,
    ToAccount: p.ToAccount ? resolveAccountName(accounts, p.ToAccount) : p.ToAccount,
    ToAmount: p.ToAmount
  }));
  // The row id is the item's RANK BY CONTENT, not its place in the list. A retry (the
  // drain, or the courier after a Worker that died mid-message) parses the text again,
  // and the model may list the same items in another order: by position, a landed item
  // then read as "duplicate" under someone else's id while it was written a second time.
  // The receipt keeps the message's order; only the ids are sorted. Description and
  // Category stay out of the key — the model rewords those between runs.
  const key = (a) => JSON.stringify([a.Date || '', Number(a.Amount) || 0, a.Account || '',
                                     a.ToAccount || '', Number(a.ToAmount) || 0]);
  const rank = [];
  all.map((a, i) => i)
    .sort((x, y) => (key(all[x]) < key(all[y]) ? -1 : key(all[x]) > key(all[y]) ? 1 : x - y))
    .forEach((i, k) => { rank[i] = k; });
  for (let i = 0; i < items.length; i++) {
    const args = Object.assign({ ID: idPrefix + '-' + rank[i] }, all[i]);
    try {
      const res = args.ToAccount ? await createTransfer(args, env) : await createTransaction(args, env);
      // res.warning is advisory (an unresolved FX rate, a same-day/amount duplicate).
      // The receipt is the only feedback this path has, so it must not swallow it.
      // The receipt reads `args`, not `p`: it must show the resolved account names.
      out.push(receipt(args, res.status) + (res.warning ? '\n› ⚠ ' + res.warning : ''));
      ids.push(args.ID); idx.push(rank[i]);
      touched.add(args.Account); if (args.ToAccount) touched.add(args.ToAccount);
    } catch (err) {
      out.push('❌ *Failed to add transaction*\n› ' + msgOf(err));
    }
  }
  // The balance of every account the message moved, read AFTER the writes (#163).
  // A failed read only drops this block: the receipt still says what was written.
  if (touched.size) {
    try {
      const hits = (await getAccounts({}, env)).accounts.filter((a) => touched.has(a.name));
      if (hits.length) out.push('◈ *New balance' + (hits.length > 1 ? 's' : '') + '*\n' + hits.map(balanceLine).join('\n'));
    } catch (err) { /* the receipt matters more than the balance */ }
  }
  // Only the rows that actually landed, so undo cannot chase a failed item.
  if (ids.length) await metaSet(env, 'tg_last_ids', JSON.stringify(ids));
  await send(env, chat, out.join('\n\n'), replyTo, ids.length ? logKeyboard(env, idPrefix, idx, ids, mailId) : null);
  return ids;
}

// ── the Undo / Edit details buttons under a receipt ──────────────────────────
/**
 * Undo carries its own IDs in callback_data instead of reading meta.tg_last_ids, so
 * the button under an OLDER receipt still undoes that message. Only the indices that
 * landed are encoded — a failed item has no row to delete.
 */
export function undoData(idPrefix, indices) { return 'u:' + idPrefix + ':' + indices.join(','); }

/** Reverse of undoData -> transaction IDs; [] if the payload is not ours. */
export function undoIds(data) {
  const m = /^u:([A-Za-z0-9-]+):(\d+(?:,\d+)*)$/.exec(String(data || ''));
  if (!m) return [];
  // Receipts sent before the prefix carried a source ("u:90210:0") mean Telegram.
  const prefix = /^\d+$/.test(m[1]) ? 'tg-' + m[1] : m[1];
  return m[2].split(',').map((i) => prefix + '-' + i);
}

/**
 * The Worker IS the app origin now, so the "Edit details" link is just the request
 * origin — no WEBHOOK_URL-minus-/tg derivation, no WEB_APP_URL trap.
 */
export function logKeyboard(env, idPrefix, indices, ids, mailId) {
  const row = [];
  const data = undoData(idPrefix, indices);
  // Telegram caps callback_data at 64 bytes; past that, /undo still covers it.
  if (data.length <= 64) row.push({ text: '↻ Undo', callback_data: data });
  const url = env.APP_URL;
  if (url) row.push({ text: '✎ Edit details', url: url + '?screen=transactions' +
                      (ids.length === 1 ? '&tx=' + encodeURIComponent(ids[0]) : '') });
  const rows = row.length ? [row] : [];
  // Its own row: three buttons abreast get squeezed to unreadable on a phone.
  if (mailId) rows.push([{ text: '⌕ Email', callback_data: 'e:' + mailId }]);
  return rows.length ? rows : null;
}

/**
 * A button tap — "u:…" Undo, or "e:<gmail id>" ⌕ Email.
 *
 * Undo rewrites the receipt with the removal summary, which also drops the keyboard,
 * so it cannot be pressed twice against deleted rows. Email replies with the quote the
 * courier stored at ingest time and deliberately LEAVES the keyboard alone: checking
 * the source is a read, and a second look must stay possible.
 */
async function callback(env, cq) {
  const msg = cq.message || {};
  const chat = msg.chat && msg.chat.id;
  if (String(cq.from && cq.from.id) !== String(env.TELEGRAM_USER_ID)) return answer(env, cq, 'Unauthorized.');

  const mail = /^e:([0-9a-zA-Z]{1,64})$/.exec(String(cq.data || ''));
  if (mail) {
    const row = await env.DB.prepare('SELECT quote FROM email_quotes WHERE message_id = ?').bind(mail[1]).first();
    if (!row) return answer(env, cq, 'Email no longer available.');
    await send(env, chat, row.quote, msg.message_id);
    return answer(env, cq, '');
  }

  const ids = undoIds(cq.data);
  if (ids.length) await edit(env, chat, msg.message_id, (await deleteIds(env, ids)).join('\n'));
  return answer(env, cq, ids.length ? 'Removed.' : 'Nothing to undo.');
}

/** Dismiss the button's spinner (an unanswered callback spins for ~30s). */
function answer(env, cq, text) {
  return call(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
}

// ── undo (the last logged message) ───────────────────────────────────────────
async function undo(env, chat, replyTo) {
  let ids = [];
  try { ids = JSON.parse(await metaGet(env, 'tg_last_ids', '[]')); } catch (err) { ids = []; }
  if (!ids.length) return send(env, chat, '✦ *Nothing to undo.*', replyTo);
  return send(env, chat, (await deleteIds(env, ids)).join('\n'), replyTo);
}

/** Delete those rows and describe what went; shared by /undo and the Undo button. */
async function deleteIds(env, ids) {
  const out = ['↻ *Removed*'];
  for (const id of ids) {
    try {
      const t = (await deleteTransaction({ ID: id }, env)).transaction;
      out.push('› _' + t.Category + '_ ' + php(t['Amount (PHP)'] || t.Amount));
    } catch (err) {
      out.push('› ❌ ' + msgOf(err));
    }
  }
  // Cleared when /undo points at these rows, so whichever of the button and /undo fires
  // first stops the other chasing them. ONLY then: the Undo button under an OLDER
  // receipt used to clear it too, and /undo then had nothing for the newest message.
  let last = [];
  try { last = JSON.parse(await metaGet(env, 'tg_last_ids', '[]')); } catch (err) { last = []; }
  if (last.some((id) => ids.includes(id))) await metaSet(env, 'tg_last_ids', '[]');
  return out;
}

// ── query / read-back ────────────────────────────────────────────────────────
async function queryReply(env, query) {
  const args = queryFilters(query);
  const res = await listTransactions(args, env);
  const label = [args.category, args.account, args.search, args.month || 'all time']
    .filter(Boolean).join(' · ');
  return '⌕ *' + label + '*\n' + querySummary(res.transactions, res.total);
}

/** Parsed query object -> listTransactions args. */
export function queryFilters(query) {
  const q = query || {};
  // ponytail: one page. 500 rows is more than any single month; paginate only if an
  // all-time query ever needs a total that big to be exact.
  const args = { limit: 500 };
  if (q.month) args.month = tgMonthKey(q.month);
  if (q.category) args.category = q.category;
  if (q.account) args.account = q.account;
  if (q.search) args.search = q.search;
  return args;
}

/** "2026-08" / "2026-Aug" -> the canonical month key. Falls back to this month. */
export function tgMonthKey(s) {
  const p = parseMonthKey(s) || parseMonthKey(manilaToday().slice(0, 7));
  return monthKey(p.y, p.m);
}

/**
 * Rows -> the reply body: total, count, and the most recent few. Amounts are summed
 * ABSOLUTE, and stay that way while the reports went sign-aware: this answers "how much
 * moved through this", so a refund is movement too, and a mixed Income+Expense filter
 * would otherwise net to a meaningless figure.
 *
 * A row on a SHARES account is skipped from the sum: its Amount is a share quantity, so
 * its 'Amount (PHP)' is a share count read as pesos. It still shows in the list and the
 * count — it happened — it just cannot be added to money.
 */
export function querySummary(rows, total) {
  rows = rows || [];
  const n = (total === undefined) ? rows.length : total;
  if (!n) return 'No matching transactions.';
  const sum = rows.reduce((s, r) => String(r.Currency).toUpperCase() === 'SHARES'
    ? s : s + Math.abs(Number(r['Amount (PHP)']) || 0), 0);
  const lines = rows.slice(0, 5).map((r) =>
    '› _' + String(r.Date).slice(0, 10) + '_ ' + r.Category +
    (r.Description ? ' — ' + r.Description : '') + ' `' + php(r['Amount (PHP)']) + '`');
  if (n > lines.length) lines.push('› _…' + (n - lines.length) + ' more_');
  return '*' + php(sum) + '* across ' + n + ' tx\n' + lines.join('\n');
}

// ── balances ─────────────────────────────────────────────────────────────────
async function balance(env, chat, query, replyTo) {
  try {
    const res = await getAccounts({}, env);
    return send(env, chat, balanceText(res.accounts, query && query.account), replyTo);
  } catch (err) {
    return send(env, chat, '❌ *Balance lookup failed*\n› ' + msgOf(err), replyTo);
  }
}

/**
 * Accounts -> the reply. Non-PHP accounts lead with their native amount and carry PHP
 * behind it, matching the web UI. The total is signed net worth: liabilities pull it down.
 */
export function balanceText(accounts, name) {
  const hits = matchAccounts(accounts || [], name);
  if (!hits.length) return '⌕ No account matching *' + name + '*.';
  const lines = hits.map(balanceLine);
  if (hits.length > 1) {
    const total = hits.reduce((s, a) => s + (Number(a.netWorthPhp) || 0), 0);
    lines.push('*Total* `' + (total < 0 ? '-' : '') + php(total) + '`');
  }
  return '◈ *Balance' + (hits.length > 1 ? 's' : '') + '*\n' + lines.join('\n');
}

/** One account's line: the /balance reply and the new balance under a receipt. */
export function balanceLine(a) {
  const ccy = String(a.currency || 'PHP').toUpperCase();
  const native = (ccy !== 'PHP' && a.balanceNative !== null && a.balanceNative !== undefined)
    ? '`' + money(a.balanceNative, ccy) + '` · ' : '';
  return '› _' + a.name + '_ ' + native + '`' + php(a.balancePhp) + '`' + (a.isLiability ? ' owed' : '');
}

/**
 * No name -> every account. Otherwise case-insensitive substring, so a model that
 * echoes "maya" instead of the exact name still resolves (and "maya" legitimately
 * matching two accounts lists both rather than guessing).
 */
export function matchAccounts(accounts, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return accounts;
  return accounts.filter((a) => String(a.name).toLowerCase().indexOf(q) !== -1);
}

/**
 * The name the ledger knows, from the name the model wrote — the log path's version of
 * what matchAccounts does for /balance. The parser is told to copy a name character for
 * character out of VALID ACCOUNTS, and mostly does, but it echoes the sender's own
 * spelling often enough to lose a transaction ("Maribank" for "MariBank", 2026-08-30).
 * An ingested email is worse again: it shouts "MARIBANK".
 *
 * Four passes, widening but never guessing:
 *   1. exact                       "MariBank"
 *   2. case-insensitive            "maribank", "MARIBANK"
 *   3. letters and digits only     "mari bank", "Mari-Bank"
 *   4. case-insensitive substring  "mari" — the same test /balance already makes
 * Passes 2-4 accept exactly ONE candidate. Two candidates return the name unchanged, so
 * createTransaction throws its usual "Unknown Account" instead of picking the wrong one;
 * 3 and 4 need three characters, because a two-letter fragment matches half the ledger.
 * The resolved name goes on the receipt too — the reply then shows what was really written.
 */
export function resolveAccountName(accounts, name) {
  const raw = String(name === undefined || name === null ? '' : name).trim();
  if (!raw || !accounts || !accounts.length) return name;
  const low = raw.toLowerCase();
  const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = squash(raw);
  const only = (hits) => (hits.length === 1 ? hits[0].name : null);
  if (accounts.some((a) => a.name === raw)) return raw;
  return only(accounts.filter((a) => String(a.name).toLowerCase() === low))
    || (q.length >= 3 ? only(accounts.filter((a) => squash(a.name) === q)) : null)
    || (low.length >= 3 ? only(accounts.filter((a) => String(a.name).toLowerCase().indexOf(low) !== -1)) : null)
    || name;
}

/**
 * A parsed item with a ToAccount but a non-Transfer category ("1000 to Kuya Audi
 * 'Fuel for Daddy'" filed as Transport: Fuel or Family: Support) would fail
 * assertShape. The destination is the reliable half — the model copied it from the
 * account list — so the category yields to "Transfer: Internal", the same fallback the
 * SPA's transfer form makes. The purpose stays in the Description.
 */
export function xferCategory(categories, p) {
  if (!p.ToAccount) return p.Category;
  const type = (name) => { const c = categories.find((x) => x.name === name); return c && c.type; };
  return type(p.Category) !== 'Transfer' && type('Transfer: Internal') ? 'Transfer: Internal' : p.Category;
}

/** Absolute amount with its currency's symbol; unknown currencies (SHARES) trail the code. */
export function money(n, ccy) {
  const c = String(ccy || 'PHP').toUpperCase();
  const v = Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (c === 'PHP') return '₱' + v;
  if (c === 'USD') return '$' + v;
  return v + ' ' + c;
}
const php = (n) => money(n, 'PHP');

// ── replies ──────────────────────────────────────────────────────────────────
/** The confirmation message. `status` is "success" or "duplicate" (a retried update). */
export function receipt(p, status) {
  const lines = [status === 'duplicate' ? '✦ *Already logged*' : '✦ *Logged*',
                 '› _' + p.Date + '_', '› _' + p.Category + '_'];
  // A blank Description is normal (the Category/Account already say it) — no empty line.
  if (p.Description) lines.push('› _' + p.Description + '_');
  lines.push('› _' + p.Account + '_', '› `' + p.Amount + '`');
  if (p.ToAccount) lines.push('› To: _' + p.ToAccount + '_');
  if (p.ToAmount) lines.push('› `' + p.ToAmount + '`');
  return lines.join('\n');
}

/**
 * sendMessage. A description containing `_` or `*` makes Telegram reject the whole
 * Markdown message (400), so a rejected send is retried as plain text rather than
 * silently swallowing the only feedback the user gets.
 */
export async function send(env, chatId, text, replyTo, keyboard) {
  const p = { chat_id: chatId, text };
  if (replyTo) p.reply_to_message_id = replyTo;
  if (keyboard) p.reply_markup = { inline_keyboard: keyboard };
  return call(env, 'sendMessage', p);
}

/** Rewrite a message in place (drops its inline keyboard — no reply_markup sent). */
function edit(env, chatId, messageId, text) {
  return call(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text });
}

/**
 * Bot API call with the Markdown -> plain retry above. Returns whether Telegram
 * accepted it; still THROWS when the network does, which is what makes the Gmail
 * courier hold the mail and re-ingest rather than trash a receipt nobody saw.
 */
async function call(env, method, payload) {
  const post = (p) => fetch(API + env.TELEGRAM_BOT_TOKEN + '/' + method,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  const res = await post(Object.assign({ parse_mode: 'Markdown' }, payload));
  if (res.ok) return true;
  return (await post(payload)).ok;        // markdown rejected -> plain text
}

/** Best-effort owner alert. Cron failures use this — the free plan does not retry them. */
export async function notifyOwner(env, text) {
  try { await send(env, env.TELEGRAM_USER_ID, text); }
  catch (err) { console.error('notifyOwner failed: ' + err); }
}

export const msgOf = (err) => (err && err.message) ? err.message : String(err);

// ── the Gmail courier's endpoint ─────────────────────────────────────────────
/**
 * POST /api?action=ingestEmail, bearer-only. The GAS courier still owns the mailbox
 * (GmailApp is free OAuth to it and has no off-platform equivalent) but no longer
 * parses or writes anything: it posts the email's fields here and trashes the mail
 * only when the response says every item landed.
 *
 * The quote is stored so the receipt's ⌕ Email button still works: the Worker cannot
 * call GmailApp, so the courier ships the same 1200-char excerpt GAS used to build on
 * demand, and the 'e:<messageId>' callback reads it out of D1.
 *
 * `intent` is ignored — an email is never a query or an undo. Only `error` decides
 * whether this was a transaction at all.
 */
export async function ingestEmail(args, env) {
  const messageId = String(args.messageId || '');
  if (!messageId) throw new Error('ingestEmail requires messageId.');
  const r = await refs(env);
  // The chat turn's 9s/20s clock is Telegram's, not this path's — see EMAIL_BUDGET_MS.
  const parsed = await parse(env, r, emailText(args, args.hints), Math.floor(Date.parse(args.date) / 1000) || undefined,
                             { capMs: EMAIL_TIMEOUT_MS, budgetMs: EMAIL_BUDGET_MS });
  const items = parsed.error ? [] : (parsed.items || []);
  if (!items.length) return { status: 'success', logged: 0, total: 0, ids: [], skipped: parsed.error || 'no transactions' };

  if (args.quote) {
    await env.DB.prepare('INSERT INTO email_quotes (message_id, quote) VALUES (?, ?) ' +
      'ON CONFLICT(message_id) DO UPDATE SET quote = excluded.quote').bind(messageId, String(args.quote)).run();
  }
  const ids = await logItems(env, env.TELEGRAM_USER_ID, 'gm-' + messageId, items, null, args.quote ? messageId : null);
  return { status: 'success', logged: ids.length, total: items.length, ids };
}
