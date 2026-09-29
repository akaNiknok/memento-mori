/**
 * oauth.js — the OAuth 2.1 door to /mcp, for the clients that cannot send a fixed header:
 * claude.ai's custom connectors on the web and the phone (2026-09-30).
 *
 * The flow is the one the MCP authorization spec asks for: a 401 from /mcp names the
 * protected-resource metadata, that names this Worker as the authorization server,
 * the client registers itself (/register), sends the owner to /authorize, and trades
 * the code plus its PKCE verifier for tokens at /token.
 *
 * STATELESS. A code, an access token and a refresh token are each a signed claim set
 * (`base64url(json).base64url(hmac)`), so nothing is stored: no KV, no table, no library.
 *   * The HMAC key is derived from AI_READ_TOKEN. Rotating or deleting that one secret
 *     voids every token ever issued, so "delete AI_READ_TOKEN" is still the single
 *     kill switch for every AI door. Unset = these routes do not exist.
 *   * `typ` is signed in, so a code is never an access token and a refresh token is
 *     never either.
 *   * The consent page asks for APP_PASS — the same passphrase as /login, the same
 *     brute-force ceiling (see login() in worker.js).
 * The one real defence is REDIRECTS: a code goes only to a callback in CALLBACKS, fixed
 * in code. /register refuses any other, and /authorize shows an error rather than
 * redirect to one. So the owner's passphrase can mint a code for Claude and nobody else.
 * ponytail: stateless codes are replayable until they expire (2 minutes). PKCE makes a
 * replay useless without the verifier, which only the client that started the flow has.
 * A KV "used" flag would close it; add one only if a second kind of client ever appears.
 * ponytail: CALLBACKS is Claude's only. Another client (ChatGPT, a local one) = add its
 * exact callback here, with a test.
 */
const CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const CODE_TTL = 120, ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400;   // seconds; a refresh rotates

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const key = (env) => crypto.subtle.importKey('raw', enc.encode('oauth:' + env.AI_READ_TOKEN),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function sign(env, claims, ttl) {
  const body = b64u(enc.encode(JSON.stringify(Object.assign({}, claims, { exp: now() + ttl }))));
  return body + '.' + b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), enc.encode(body))));
}

/** The claims of a valid, unexpired token of this `typ`, else null. Never throws. */
export async function verify(env, token, typ) {
  if (!env.AI_READ_TOKEN || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await key(env), unb64u(parts[1]), enc.encode(parts[0]))) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    return c.typ === typ && c.exp > now() ? c : null;
  } catch (e) { return null; }
}

export const OAUTH_PATHS = ['/authorize', '/token', '/register',
  '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp'];

export async function oauth(request, env, url) {
  if (!env.AI_READ_TOKEN || !env.APP_PASS) return new Response('not found', { status: 404 });
  const o = url.origin;
  switch (url.pathname) {
    case '/.well-known/oauth-protected-resource':
    case '/.well-known/oauth-protected-resource/mcp':
      return json({ resource: o + '/mcp', authorization_servers: [o], bearer_methods_supported: ['header'] });
    case '/.well-known/oauth-authorization-server':
      return json({
        issuer: o, authorization_endpoint: o + '/authorize', token_endpoint: o + '/token',
        registration_endpoint: o + '/register', response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
      });
    case '/register': return register(request);
    case '/authorize': return authorize(request, env, url);
    case '/token': return token(request, env);
  }
  return new Response('not found', { status: 404 });
}

/** Dynamic client registration (RFC 7591). Every client is the same public client; what
 * matters is the redirect, and that is checked here and again at /authorize. */
async function register(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const m = await request.json().catch(() => ({})) || {};
  const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris : [];
  if (!uris.length || !uris.every((u) => CALLBACKS.includes(u))) {
    return json({ error: 'invalid_redirect_uri', error_description: 'This server only accepts Claude callbacks.' }, 400);
  }
  return json({
    client_id: 'claude', client_id_issued_at: now(), client_name: m.client_name || 'Claude',
    redirect_uris: uris, token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
  }, 201);
}

async function authorize(request, env, url) {
  const p = request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;
  const q = Object.fromEntries(['redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type']
    .map((k) => [k, p.get(k) || '']));
  // A bad redirect is never followed — that would hand the error, or a code, to a stranger.
  if (!CALLBACKS.includes(q.redirect_uri)) return page(q, 'This app cannot connect here.', 400, false);
  if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) {
    return page(q, 'The request is not valid. Connect again from Claude.', 400, false);
  }
  if (request.method !== 'POST') return page(q, '', 200, true);
  if (p.get('pass') !== env.APP_PASS) return page(q, 'Wrong passphrase', 401, true);
  const code = await sign(env, { typ: 'code', cc: q.code_challenge, ru: q.redirect_uri }, CODE_TTL);
  const to = new URL(q.redirect_uri);
  to.searchParams.set('code', code);
  if (q.state) to.searchParams.set('state', q.state);
  return new Response(null, { status: 302, headers: { Location: to.href, 'Cache-Control': 'no-store' } });
}

async function token(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const p = new URLSearchParams(await request.text());
  const bad = (d) => json({ error: 'invalid_grant', error_description: d }, 400);
  const grant = p.get('grant_type');
  if (grant === 'authorization_code') {
    const c = await verify(env, p.get('code'), 'code');
    if (!c) return bad('The code is not valid or has expired.');
    if (c.ru !== p.get('redirect_uri')) return bad('redirect_uri does not match.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(p.get('code_verifier') || '')));
    if (b64u(digest) !== c.cc) return bad('PKCE verification failed.');
  } else if (grant === 'refresh_token') {
    if (!await verify(env, p.get('refresh_token'), 'refresh')) return bad('The refresh token is not valid or has expired.');
  } else {
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  return json({
    access_token: await sign(env, { typ: 'access' }, ACCESS_TTL), token_type: 'Bearer', expires_in: ACCESS_TTL,
    refresh_token: await sign(env, { typ: 'refresh' }, REFRESH_TTL)
  });
}

const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The consent page. DESIGN.md tokens, copied: this page cannot load the SPA's CSS
 * without also loading its shell. */
function page(q, error, status, form) {
  const hidden = Object.entries(q).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Claude · Memento Mori</title>
<style>
:root{--bg:#F2F2F7;--card:#FFFFFF;--card-2:#E4E4EA;--text:#1C1C1E;--dim:#6C6C70;--accent:#2463EB;--neg:#C4382D;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#000000;--card:#1C1C1E;--card-2:#2C2C2E;--text:#F5F5F7;--dim:#A1A1A6;--accent:#0A84FF;--neg:#FF453A}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
main{background:var(--card);border-radius:20px;padding:20px;margin:16px;max-width:360px;width:calc(100% - 32px);box-sizing:border-box}
h1{font-size:17px;font-weight:600;margin:0 0 8px}p{margin:0 0 16px;color:var(--dim)}
input[type=password]{width:100%;box-sizing:border-box;font-size:17px;padding:12px;border:0;border-radius:12px;background:var(--card-2);color:var(--text)}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
label{display:block;font-size:13px;font-weight:600;color:var(--dim);margin:0 0 6px}
button{width:100%;margin-top:12px;font-family:inherit;font-size:17px;font-weight:600;padding:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--neg);margin:8px 0 0}
</style></head><body><main>
<h1>Connect Claude to Memento Mori</h1>
<p>Claude gets read-only access to your balances, budgets, investments and transactions. It cannot add, change or delete anything.</p>
${form ? `<form method="post" action="/authorize">${hidden}
<label for="pass">Passphrase</label>
<input type="password" id="pass" name="pass" autocomplete="current-password" autocapitalize="off" spellcheck="false" autofocus required>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<button type="submit">Allow read-only access</button></form>`
    : `<p class="err" role="alert">${esc(error)}</p>`}
</main></body></html>`;
  return new Response(html, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    // Never framed: a hidden frame is how a consent click gets stolen.
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer'
  } });
}
