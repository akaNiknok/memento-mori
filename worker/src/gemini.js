/**
 * gemini.js — the message parser: the generateContent call, its responseSchema,
 * the MODELS fallback chain under a per-attempt cap and a chain budget, and the
 * system prompt. Began as a port of tg_parse_/tg_tryModels_/tg_prompt_ from Telegram.gs.
 *
 * UrlFetchApp becomes fetch, and the live category/account lists come from D1
 * instead of two sheet reads. Nothing else moved: the free tier is keyed to the API
 * key, not to the runtime, so the same GEMINI_API_KEY works from the Worker.
 */
import { manilaToday } from './db.js';

// Tried in order; the next is used if the previous errors (overload, 5xx, a model id
// that stopped existing). Cheapest-capable first.
// ponytail: no Pro model here — free tier gives Pro 0 RPD, so it is a guaranteed 429
// that masks flash-lite's real failure (2026-09-02). Add one back only on a paid key.
export const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

/**
 * The parse carries its own clock, and this is why.
 *
 * These are model ids that FLOAT: `-latest` is whatever Google points it at this week,
 * so a parse that took two seconds last month can take thirty today with no change in
 * this repo. Left unbounded, three tries in a row spend about 21s — which in v2.10.1
 * outlived the waitUntil allowance and lost the message in silence (2026-09-02).
 *
 * Since v2.11.0 the turn runs inside a PENDING REQUEST rather than waitUntil, so the
 * ceiling is no longer Cloudflare's allowance but Telegram's patience for a webhook
 * reply. That is a bigger room, so the budget grew — but it is still a room. The
 * numbers are chosen so the whole turn fits under TURN_CEILING_MS (src/telegram.js)
 * with the D1 writes and the send that follow.
 *
 * A per-attempt cap AND a whole-chain budget, because they stop different things: the
 * cap stops one model hanging forever, the budget stops the FALLBACK from adding three
 * caps together.
 */
export const MODEL_TIMEOUT_MS = 9000;    // one attempt
export const PARSE_BUDGET_MS = 20000;    // the whole fallback chain

/**
 * The Gmail courier is not a chat turn and must not inherit Telegram's clock: no human
 * waits on it, Apps Script holds the connection, and its own trigger retries a failed
 * message every 5 minutes for 3 hours. The 9s cap turned an ordinary slow answer on a
 * 3000-char email body into a logged failure (2026-09-04), so the email path gets a
 * patient pair instead. The ceiling here is UrlFetchApp's own ~60s, not TURN_CEILING_MS.
 */
export const EMAIL_TIMEOUT_MS = 20000;   // one attempt
export const EMAIL_BUDGET_MS = 45000;    // the whole fallback chain

// Structured-output schema (OpenAPI subset: nullable, not union types). Only
// intent/error are required — a non-transaction message must be able to come back as
// {error:"..."} without the model inventing a Category to satisfy the schema.
const TX_SCHEMA = {
  type: 'OBJECT',
  properties: {
    Date: { type: 'STRING', description: 'Transaction date, ISO yyyy-MM-dd' },
    Category: { type: 'STRING', description: 'Exact match from VALID CATEGORIES' },
    Description: { type: 'STRING', description: 'Concise description, max 256 chars' },
    Account: { type: 'STRING', description: 'Exact match from VALID ACCOUNTS (source account)' },
    Amount: { type: 'NUMBER', description: 'Positive amount leaving/entering the source account' },
    ExchangeRate: { type: 'NUMBER', nullable: true, description: 'PHP per 1 USD, only if explicitly mentioned' },
    ToAccount: { type: 'STRING', nullable: true, description: 'Destination account, transfers only' },
    ToAmount: { type: 'NUMBER', nullable: true, description: 'Amount received in the destination account, transfers only' }
  }
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    // An enum (2026-09-25): as a plain STRING the model invented "error"/"none" for a
    // non-transaction message. "none" is the honest answer there; error carries why.
    intent: { type: 'STRING', format: 'enum', enum: ['log', 'query', 'balance', 'undo', 'none'], description: '"log" to record transactions, "query" to answer a question about past ones, "balance" to report what is in the accounts right now, "undo" to take back the previous message, "none" when it is none of these (then set error)' },
    items: { type: 'ARRAY', nullable: true, items: TX_SCHEMA,
             description: 'One entry per transaction in the message (intent=log). A message may contain several.' },
    query: { type: 'OBJECT', nullable: true, description: 'Filters for intent=query (intent=balance uses account only); omit the ones the message does not imply',
             properties: {
               month: { type: 'STRING', nullable: true, description: 'Month to restrict to, yyyy-MM. Null means all time' },
               category: { type: 'STRING', nullable: true, description: 'Exact match from VALID CATEGORIES' },
               account: { type: 'STRING', nullable: true, description: 'Exact match from VALID ACCOUNTS' },
               search: { type: 'STRING', nullable: true, description: 'Free-text words to match in the description' }
             } },
    error: { type: 'STRING', nullable: true, description: 'Short error message if the message is none of the four intents; else null' }
  },
  required: ['intent', 'error']
};

/**
 * Message text -> the structured object. Throws on API/parse failure, or on timeout.
 * `budget` ({capMs, budgetMs}) lets a caller with a different clock — the email
 * courier — widen the chat turn's defaults.
 */
export async function parse(env, refs, text, unixDate, budget = {}) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set.');
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: prompt(refs, unixDate) }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA }
  });
  return JSON.parse(await tryModels(MODELS, (model, ms) => generate(model, key, payload, ms),
                                    budget.budgetMs, undefined, budget.capMs));
}

/**
 * Call `fn` with each model until one returns; the last failure surfaces if none do.
 * `fn` receives the milliseconds still left, so a slow first model shortens the second
 * attempt rather than adding to it — three unbounded tries in a row is how a turn ran
 * past its waitUntil allowance and vanished.
 *
 * The chain STOPS when the budget is spent, and the failure that stopped it is the one
 * that surfaces. Falling back with no time left just trades one silent loss for
 * another; a reported timeout is the useful outcome.
 *
 * ponytail: retries the whole call, so a 503 on the primary costs one extra round
 * trip. No per-status logic — a bad response is a bad response either way.
 */
export async function tryModels(models, fn, budgetMs = PARSE_BUDGET_MS, now = () => Date.now(),
                                capMs = MODEL_TIMEOUT_MS) {
  const until = now() + budgetMs;
  for (let i = 0; i < models.length; i++) {
    const left = until - now();
    if (left <= 0) throw new Error('Gemini ran out of time after ' + i + ' of ' +
                                   models.length + ' models (' + Math.round(budgetMs / 1000) + 's budget).');
    try { return await fn(models[i], Math.min(capMs, left)); }
    catch (err) {
      console.warn('gemini ' + models[i] + ' failed: ' + (err && err.message ? err.message : err));
      if (i === models.length - 1) throw err;
    }
  }
}

/**
 * One generateContent call -> the model's raw text. Throws on non-200/empty, and on a
 * model that does not answer in `timeoutMs`. The abort is translated into a plain
 * message: a bare DOMException reads as a bug in this code, and this text goes
 * straight into the owner's chat.
 */
async function generate(model, key, payload, timeoutMs = MODEL_TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model +
        ':generateContent?key=' + encodeURIComponent(key),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
        signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('Gemini ' + model + ' did not answer within ' + Math.round(timeoutMs / 1000) + 's.');
    }
    throw err;
  }
  const body = await res.text();
  if (!res.ok) throw new Error('Gemini ' + res.status + ': ' + body.slice(0, 200));
  return textOf(JSON.parse(body));
}

/** Pull the model's text out of a generateContent response. Throws if it is empty. */
export function textOf(json) {
  const c = json && json.candidates && json.candidates[0];
  const parts = c && c.content && c.content.parts;
  const text = parts && parts[0] && parts[0].text;
  if (!text) throw new Error('Gemini returned no content' + (c && c.finishReason ? ' (' + c.finishReason + ')' : '') + '.');
  return text;
}

/** The parser system prompt, with the live category/account lists inlined. */
export function prompt(refs, unixDate) {
  const today = manilaToday(unixDate ? new Date(unixDate * 1000) : new Date());
  const cats = refs.categories
    .map((c) => '- "' + c.name + '" (' + (c.type || '') + ') - ' + (c.description || '')).join('\n');
  const accts = refs.accounts
    .map((a) => '- "' + a.name + '" (' + (a.currency || '') + ', ' + (a.subtype || '') + ')').join('\n');

  return [
    "You are a personal finance assistant. Classify the user's message and extract structured data.",
    '',
    'VALID CATEGORIES ("Name" (Type) - Description):', cats,
    '',
    'VALID ACCOUNTS ("Name" (Currency, Subtype); a Receivable is a person):', accts,
    '',
    'INTENT:',
    'A. "log" — the message records money moving. Put ONE entry in items per transaction;',
    '   a message may describe several (e.g. one per line). Leave query null.',
    'B. "query" — the message asks about transactions already recorded ("how much on food",',
    '   "what did I spend at bpi"). Fill query with only the filters the message implies,',
    '   and leave items empty.',
    'C. "balance" — the message asks how much is in an account RIGHT NOW ("how much do I',
    '   have", "balance", "how much is in maya", "my bpi balance"). Set query.account only',
    '   when one account is named; leave query null for all accounts. Leave items empty.',
    'D. "undo" — the message asks to take back / cancel / delete what was just logged.',
    '   Leave items and query null.',
    '',
    'RULES:',
    '1. Date must be ISO yyyy-MM-dd. If no date is mentioned, use: ' + today,
    '2. Category must exactly match a name from VALID CATEGORIES (case-sensitive)',
    '3. Copy Account and ToAccount character for character from VALID ACCOUNTS, including',
    '    its capitalisation ("MariBank", not "Maribank") — do NOT echo the spelling the',
    '    message used',
    '4. Amount must be a positive number',
    '5. For a transfer between accounts: use a Transfer-type category and set BOTH ToAccount and ToAmount',
    '   Money sent TO an account in VALID ACCOUNTS (a person included; match part of the name,',
    '   "Ben" is "Tito Ben") is ALWAYS a transfer, even when the message says what it is for:',
    '   "500 from GCash to Tito Ben \\"Fuel for Lola\\"" is a Transfer-type category with',
    '   Description "Fuel for Lola", never an Expense category',
    '6. ExchangeRate is PHP per 1 USD — only set it if explicitly mentioned, otherwise null',
    '7. If it is not a transfer, ToAccount and ToAmount must be null',
    '8. query.month is yyyy-MM; "this month" is ' + today.slice(0, 7) + ', and no period mentioned means null (all time)',
    '9. Past spending/earning is "query"; money sitting in an account today is "balance"',
    '10. If the message is none of the four intents, set error to a short reason and leave the rest null',
    '11. Description: use normal capitalization even if the source shouts ("SM SUPERMARKET" -> "SM Supermarket");',
    '    keep all-caps only for names that are genuinely all-caps (acronyms, brands like BPI, SM, GCash)',
    '12. Leave reference/confirmation/transaction numbers out of the Description',
    '13. Leave Description empty when it would only restate the Category or the accounts',
    '    ("Transfer to MariBank" for a transfer to MariBank, "Cashback" on Income: Cashback).',
    '    Only describe what the Category and Account do not already say (merchant, item, reason)'
  ].join('\n');
}

/**
 * The text an ingested email is parsed as. The leading instructions are what the chat
 * prompt cannot cover: a chat message is sent BECAUSE it is a transaction, whereas a
 * receipt-shaped marketing email is still not one. Port of gmail_text_ — it moves
 * here because the parse moved here; GAS now only ships the raw fields.
 */
export const EMAIL_MAX_BODY = 3000;   // notification mail says everything up top; footers are noise
export function emailText(mail, hints) {
  return [
    'The following is an email notification, not a chat message.',
    'If it does not report money that has actually moved (a payment, charge,',
    'transfer or credit that already happened), set error and log nothing.',
    'The amount to log is the total actually charged or received, tax included.',
    hints || '',
    '',
    'From: ' + (mail.from || ''),
    'Subject: ' + (mail.subject || ''),
    'Date: ' + (mail.date || ''),
    '',
    String(mail.body || '').slice(0, EMAIL_MAX_BODY)
  ].join('\n');
}
