/**
 * worker.js — the whole backend. Cloudflare Worker + D1, as of v2.0.0.
 *
 * Before v2 this file was a 178-line proxy in front of an Apps Script web app: it
 * existed because Telegram rejects a redirecting webhook and Apps Script 302s every
 * POST, and it grew /api and the SPA because GAS cannot send CORS headers either.
 * The Sheet is now a frozen archive, D1 is the source of truth, and the proxy is the
 * application.
 *
 * Routes (everything else is a static asset from public/, free and unmetered):
 *   POST /tg     — the Telegram webhook. Same URL as before, so no setWebhook re-run.
 *                  Does the work FIRST and answers after (v2.11.0); a turn that dies
 *                  anyway is re-run from D1 by the 2-minute drain cron (v2.12.0).
 *   POST /login  — passphrase -> sha256(APP_PASS) cookie (HttpOnly/Secure/Lax, 1yr).
 *   POST /mcp    — read-only MCP for AI clients, own token AI_READ_TOKEN (src/mcp.js).
 *   /authorize, /token, /register, /.well-known/oauth-* — OAuth for /mcp (src/oauth.js).
 *   GET|POST /api — the JSON API. GET = reads, POST = writes; the split comes from the
 *                  handler name's get…/list… prefix, which is also how the SPA's gs()
 *                  picks its method, so there is exactly one list to keep in sync.
 *
 * Auth on /api: the mm_auth cookie (the SPA) OR `Authorization: Bearer INGEST_TOKEN`
 * (the two remaining Apps Script jobs — the Gmail courier and the backup puller).
 * 401 is JSON, never a redirect: that is what lets gs() prompt for the passphrase and
 * retry the call in place. A request whose HOST is localhost skips the check entirely
 * (see isLocalDev) — that is `wrangler dev`, and Cloudflare cannot route a production
 * request to that hostname.
 *
 * The KV edge read cache is GONE. It existed to hide Apps Script latency and D1 is the
 * thing it was faking; the namespace is rebound as FX_CACHE (see src/fx.js). The
 * client's own cache is untouched — it is still the offline story — and every GET read
 * carries an ETag it revalidates against (see readResponse).
 *
 * Secrets (wrangler secret put ...):
 *   APP_PASS, SECRET_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, GEMINI_API_KEY,
 *   INGEST_TOKEN, IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID, AI_READ_TOKEN (optional; unset closes /mcp)
 * Bindings: DB (D1), FX_CACHE (KV, optional — unbound just means every FX lookup fetches).
 */
import {
  getBootstrap, getDashboard, getAccounts, getBudgets, getInvestments, getRecurring,
  getLedger, listTransactions, getDebts, listTable, getExportAll, getWidget, getParse, setWidgetAccounts, setSmartLists,
  createTransaction, createTransfer, updateTransaction, deleteTransaction, updateAccount,
  bulkUpdateTransactions, bulkDeleteTransactions, updateTableCell, insertTableRow, deleteTableRow
} from './src/api.js';
import { handleUpdate, ingestEmail } from './src/telegram.js';
import { runScheduled } from './src/jobs.js';
import { mcp } from './src/mcp.js';
import { oauth, OAUTH_PATHS } from './src/oauth.js';

const COOKIE = 'mm_auth';

/**
 * GET-only, side-effect-free. Names MUST stay get…/list… — worker/public/app.js picks
 * GET vs POST off that prefix rather than shipping a second copy of this table, and
 * test.js fails the build if a route is ever named against the rule.
 */
export const ROUTES_READ = {
  getBootstrap, getDashboard, getAccounts, getBudgets, getInvestments, getRecurring,
  getLedger, listTransactions,
  getDebts,         // open debts per receivable account
  listTable,        // admin grid
  getExportAll,     // backup puller + the admin screen's CSV
  getWidget,        // the iOS Scriptable widgets
  getParse          // the add field's Gemini parse (writes nothing)
};

export const ROUTES_WRITE = {
  createTransaction, createTransfer, updateTransaction, deleteTransaction, updateAccount,
  bulkUpdateTransactions, bulkDeleteTransactions,
  // The admin grid — and the Tax screen, which writes the `ledger` table through these
  // same three rather than carrying a second copy of them (v3.2.0). getLedger hands the
  // client the header -> column map; everything else here is already generic.
  updateTableCell, insertTableRow, deleteTableRow,
  setWidgetAccounts,                                 // the Accounts screen's widget picker
  setSmartLists,                                     // Activity's saved filters
  ingestEmail                                        // the Gmail courier
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The receipt's "Edit details" button links back into the SPA, which is this same
    // origin now — no WEBHOOK_URL-minus-/tg derivation and no WEB_APP_URL trap left.
    env.APP_URL = url.origin;
    // A webhook carries no cookie, so /tg is gated by SECRET_TOKEN instead. It MUST be
    // /tg and not "/": a POST to "/" is answered 405 by the static-asset handler and
    // never reaches this script, because assets match before the Worker and only serve
    // GET/HEAD. Verified with `wrangler dev`; undocumented either way, so do not
    // re-derive it.
    if (request.method === 'POST' && url.pathname === '/tg') return telegram(request, env);
    if (url.pathname === '/login') return login(request, env);
    if (url.pathname === '/api') return api(request, env, url);
    if (url.pathname === '/mcp') return mcp(request, env, isLocalDev(url));
    if (OAUTH_PATHS.includes(url.pathname)) return oauth(request, env, url);
    return new Response('not found', { status: 404 });   // assets never reach here
  },

  // AWAITED, not handed to ctx.waitUntil — same reason as /tg below. The runtime keeps
  // a scheduled invocation alive for the promise this handler returns, so awaiting is
  // the shape that cannot be cancelled mid-job. `event.cron` picks the job: there are
  // two schedules now, and the drain must never fire the IBKR pull.
  async scheduled(event, env, ctx) {
    await runScheduled(env, event && event.cron);
  }
};

async function telegram(request, env) {
  if (env.SECRET_TOKEN &&
      request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SECRET_TOKEN) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => null);
  // WORK FIRST, ANSWER AFTER — the opposite of what this did until v2.11.0, and the
  // reason is a failure that cost real transactions (2026-09-02).
  //
  // The old shape answered 200 and handed the turn to ctx.waitUntil. Cloudflare
  // CANCELS waitUntil work that outlives its allowance, and a cancelled task is torn
  // down rather than rejected: it throws nothing, so no catch runs, nothing is sent,
  // and the message is gone with only a runtime warning in a log nobody tails. The
  // owner sent a transaction and got silence.
  //
  // Awaiting instead puts the turn inside a PENDING REQUEST, which that allowance does
  // not govern — the same reason ingestEmail never suffered this, since Apps Script
  // holds its connection open. It also buys the one thing waitUntil could not: the
  // invocation survives long enough to say "still working" and KEEP waiting.
  //
  // The comment this replaces said a parse is "not inside Telegram's patience". A
  // healthy parse is a few seconds, and the whole turn is now bounded well under any
  // plausible webhook timeout (see TURN_CEILING_MS in src/telegram.js). If Telegram
  // does give up first it redelivers, and seen() dedups that — so the cost of being
  // wrong is one wasted redelivery, not a duplicated row.
  await handleUpdate(env, update);
  return new Response('ok');
}

/** POST {pass} -> sets the session cookie. The SPA calls this on a 401 from /api. */
async function login(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const body = await request.json().catch(() => ({}));
  // ponytail: plain compare, no rate limiting — use a long random passphrase and the
  // free plan's 100k requests/day is the brute-force ceiling. Add Turnstile or a KV
  // attempt counter only if this ever gets more than one user.
  if (!env.APP_PASS || body.pass !== env.APP_PASS) return new Response('unauthorized', { status: 401 });
  return new Response('ok', {
    headers: {
      'Set-Cookie': `${COOKIE}=${await sha256(env.APP_PASS)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

/**
 * Is the caller allowed? The SPA presents the cookie; the two Apps Script jobs present
 * the bearer token. Either is the owner — there is one user — so both are accepted on
 * every action rather than maintaining a per-route credential matrix.
 */
async function authorized(request, env) {
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (env.INGEST_TOKEN && bearer && bearer === env.INGEST_TOKEN) return true;
  if (!env.APP_PASS) return false;
  const want = `${COOKIE}=${await sha256(env.APP_PASS)}`;
  return (request.headers.get('Cookie') || '').split(/;\s*/).includes(want);
}

/**
 * A `wrangler dev` server is not gated. The passphrase protects the DEPLOYED app; asking
 * for it locally only blocked the agents and the fresh checkouts that have no
 * `worker/.dev.vars` at all, and a local D1 holds `seed.sql`'s invented data anyway.
 * Cloudflare routes to a Worker BY HOSTNAME, so a production request can never arrive
 * with Host: localhost — this is inert once deployed.
 * ponytail: a hostname test, not a DEV flag. A flag has to be planted in every checkout
 * and could be set on the real Worker by accident; a hostname cannot.
 */
const isLocalDev = (url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

/** The JSON API. Handlers throw; a throw becomes {status:'error', message}. */
async function api(request, env, url) {
  if (!isLocalDev(url)) {
    if (!env.APP_PASS) return json({ status: 'error', message: 'APP_PASS is not set on the Worker.' }, 503);
    if (!await authorized(request, env)) return json({ status: 'error', message: 'Locked' }, 401);
  }
  if (!env.DB) return json({ status: 'error', message: 'The D1 binding DB is not configured.' }, 503);

  // Query params + JSON body merged into one args object, body winning. Port of rt_args_.
  const args = {};
  url.searchParams.forEach((v, k) => { args[k] = v; });
  let body = null;
  if (request.method === 'POST') {
    try { body = await request.json(); }
    catch (err) { return json({ status: 'error', message: 'Invalid JSON body: ' + err.message }); }
    Object.keys(body || {}).forEach((k) => { args[k] = body[k]; });
  }

  const action = args.action || '';
  const read = ROUTES_READ[action], write = ROUTES_WRITE[action];
  // Never mutate over GET — link previewers and scanners prefetch URLs.
  if (request.method === 'GET' && write) return json({ status: 'error', message: "Action '" + action + "' requires POST." });
  const handler = request.method === 'GET' ? read : (write || null);
  if (!handler) {
    return json({ status: 'error', message: 'Unknown action: ' + action,
                  knownActions: Object.keys(request.method === 'GET' ? ROUTES_READ : ROUTES_WRITE) });
  }
  try {
    const body = await handler(args, env);
    return request.method === 'GET' ? readResponse(body, request) : json(body);
  } catch (err) {
    console.error(action + ': ' + (err && err.stack ? err.stack : err));
    const message = (err && err.message) ? err.message : String(err);
    return json({ status: 'error', message }, refused(err, message) ? 200 : 500);
  }
}

/**
 * Did the handler refuse THIS payload? That answer is final, so it is HTTP 200 — the
 * offline queue drops a queued write only on a 200 error, because retrying a payload
 * the server rejects would wedge the queue behind it for ever.
 *
 * Everything else is 500: a D1 hiccup ("D1_ERROR: Network connection lost", "D1 DB is
 * overloaded") or a bug in the handler (a TypeError) says nothing about the payload.
 * Both used to answer 200, and the queue DROPPED a saved transaction over a passing
 * storage fault (bug audit, 2026-09-23). A broken schema rule is a refusal whoever
 * reports it, D1 included.
 */
function refused(err, message) {
  if (/constraint failed/i.test(message)) return true;
  return !!err && err.constructor === Error && !/D1[_ ]/.test(message);
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/**
 * A read, answered with an ETag over its own bytes — and 304 when the caller already
 * holds them. This REPLACED meta.data_version (v2.9.0): one counter could only say
 * "something, somewhere, changed", so a Telegram ingest at 03:00 re-downloaded the
 * dashboard, the accounts, the tax year and every admin page the phone had cached.
 * A hash of the payload answers the question the client is actually asking — "is THIS
 * screen different?" — and it answers it for the month-, year- and page-scoped cache
 * keys too, which no counter could see. It also needs nothing from the write handlers,
 * so a new route (or a new cron write) can never forget to invalidate.
 *
 * The tag must be stable for identical data, so a read payload must never carry a
 * clock. test-api.js calls every read route twice and fails if a tag moves.
 * `Cache-Control: no-store` stays: the SPA holds the tag in its own persisted cache and
 * sends If-None-Match itself, so the browser's HTTP cache is not in the path at all —
 * one cache, and it is the one that already survives a reload and works offline.
 */
async function readResponse(body, request) {
  const s = JSON.stringify(body);
  const tag = '"' + (await sha256(s)).slice(0, 32) + '"';
  const headers = Object.assign({ ETag: tag }, HEADERS);
  if (request.headers.get('If-None-Match') === tag) return new Response(null, { status: 304, headers });
  return new Response(s, { status: 200, headers });
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
