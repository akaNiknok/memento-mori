/* ============================================================================
 * app.js — the Memento Mori SPA.
 * Vanilla JS, served as a static asset by the Cloudflare Worker, which since
 * v2.0.0 IS the backend: /api runs against Cloudflare D1, not Apps Script. The
 * JSON contract did not change with that swap, so nothing in this file did
 * either, apart from the new Admin screen. Six screens: Summary (key
 * `dashboard`) · Activity (key `transactions`) · Accounts · Swap · Tax · Admin.
 * ========================================================================== */

/* ── server bridge: /api → Promise ───────────────────────────────────────────
 * fn is the handler name ('api_getDashboard'); the Worker takes the action without
 * the prefix. Reads go over GET, writes POST the args as JSON, and the `get`/`list`
 * name prefix IS the rule that picks between them — it matches ROUTES_READ in
 * worker.js, so there's no second list to keep in sync. Nothing secret reaches
 * this file. */
var GS_TIMEOUT = 20000;
function gs(fn, arg, etag, _retried){
  var action = fn.replace(/^api_/, '');
  var read = /^(get|list)/.test(action);
  var url = '/api?action=' + encodeURIComponent(action), init, body = null;
  if (read){
    Object.keys(arg || {}).forEach(function(k){
      if (arg[k] != null && arg[k] !== '') url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(arg[k]);
    });
    // No `_v` cache-bucket stamp any more: the Worker's KV read cache went away with
    // Apps Script in v2.0.0 (it existed to hide GAS latency, and D1 is the thing it was
    // faking). The gate that matters is one level up in cachedCall, and it is what
    // makes the persisted cache the offline story.
    // The conditional request: hand the tag we already hold back to the Worker, which
    // answers 304 with no body when that payload has not changed. This is what makes
    // an unrelated write (a 03:00 Telegram ingest) cost headers instead of a screen.
    init = { method:'GET', headers: etag ? { 'If-None-Match': etag } : {} };
  } else {
    body = arg ? structuredClone(arg) : {};
    body.action = action;
    // A client-supplied ID is what makes an offline replay safe: if the request did
    // reach GAS before the connection died, the retry hits the idempotency check and
    // returns {status:'duplicate'} instead of posting a second row. Stamped here,
    // before the first attempt, so the attempt and the replay carry the same one.
    // The `ui-` prefix is read back by SOURCES on the Activity list — keep it.
    if (QUEUEABLE[action] && !body.ID) body.ID = 'ui-' + crypto.randomUUID();
    init = { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) };
  }
  // A dying connection leaves fetch hanging forever instead of rejecting — the spinner
  // never resolves AND the offline queue never engages, because the whole offline story
  // below depends on that rejection. An abort lands in the reject branch and is treated
  // as offline, which is the right answer: the write is queued and replays under the
  // same client-supplied ID, so a request that DID land can't post twice.
  // ponytail: one fixed budget for every route; split it if a slow report ever trips it.
  init.signal = AbortSignal.timeout(GS_TIMEOUT);
  return fetch(url, init).then(function(res){
    netSeen(true);
    // The passphrase cookie expired (or was never set). Ask once, then retry —
    // a clean 401 is why /api answers JSON instead of redirecting to a login page.
    if (res.status === 401 && !_retried) return unlock().then(function(){ return gs(fn, arg, etag, true); });
    // Nothing changed. Only cachedCall ever sends a tag, so only cachedCall sees this.
    if (res.status === 304) return { __304:true };
    return res.json().then(function(r){
      if (r == null) throw new Error('Empty response from server (a Date may have leaked into the payload).');
      if (r.status === 'error'){
        // `_server` marks a FINAL refusal — the ONLY thing flushQueue may discard a
        // queued write for. The Worker answers 200 only when it refused this payload; a
        // storage hiccup, a bug or a 503 setup error comes back 5xx and is NOT final
        // (it used to be, and the queue dropped a saved transaction over one).
        var se = new Error(r.message || 'Server error'); se._server = res.ok; throw se;
      }
      // The tag travels beside the payload; cachedCall lifts it off before storing.
      r.__etag = res.headers.get('ETag');
      return r;
    }, function(){ throw new Error('Server returned '+res.status+' (not JSON)'); });
  }, function(){
    // fetch only rejects on a genuine network failure — a 4xx/5xx resolves — so this
    // branch IS "offline", without trusting navigator.onLine (true on a captive portal).
    netSeen(false);
    if (body && QUEUEABLE[action] && !flushQueue._busy) return enqueue(fn, body);
    var err = new Error(read ? 'Offline — no cached copy of this yet'
                             : 'Offline — reconnect to save this');
    err._offline = true;
    throw err;
  });
}

/* ── offline ─────────────────────────────────────────────────────────────────
 * Reads already survive a dead connection: cachedCall paints from the persisted
 * S.cache and swallows the failed revalidation. sw.js caches the shell so the app
 * opens at all. What's left is writes, and only these two get queued — both are
 * idempotent on a client-supplied ID, so replaying one that actually landed can't
 * double-post. Edits, deletes, account and Ledger writes are NOT queued: they're
 * desk work rather than something you do in a queue at a till, and a ledger insert
 * isn't idempotent at any price. They fail with a clear message. */
var LS_QUEUE = 'mm.queue';
var QUEUEABLE = { createTransaction:1, createTransfer:1 };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function(){});
// Ask for storage that eviction under pressure will not take. A no-op on iOS (Add to
// Home Screen already grants it) and it can be refused anywhere; the queue's own quota
// handling below is what actually has to hold, so nothing branches on the answer.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function(){});

function queue(){ try{ return JSON.parse(localStorage.getItem(LS_QUEUE)||'[]'); }catch(e){ return []; } }
/* A swallowed quota error here is a lost transaction the app still says it saved —
 * the same "dropping money" bug flushQueue is careful about, through a different door.
 * LS_CACHE is the only thing big enough to fill the quota (bootstrap plus a payload per
 * month), and it is disposable by definition, so evict it and retry. If it STILL fails,
 * the caller has to hear about it: enqueue must not toast "Saved offline". */
function queueSet(q){
  var s = JSON.stringify(q);
  try{ localStorage.setItem(LS_QUEUE, s); }
  catch(e){
    try{ localStorage.removeItem(LS_CACHE); localStorage.setItem(LS_QUEUE, s); }
    catch(e2){ throw new Error('Storage is full — this entry was NOT saved. Free up space and re-enter it.'); }
  }
}
function queueDrop(id){ queueSet(queue().filter(function(x){ return x.arg.ID !== id; })); }
function enqueue(fn, body){
  var q = queue(); q.push({ fn:fn, arg:body }); queueSet(q);
  toast('Saved offline — '+q.length+' waiting to sync','ok');
  syncUI();
  return { status:'queued' };
}
/* Pending rows are derived from the queue, so an offline entry is still on screen
 * after a relaunch. Called on boot and after a flush — NOT on enqueue, where the
 * call site's own optimistic row is already painted and equivalent. */
function rebuildPending(){
  S.tx.pendingAdds = queue().map(function(item){ return optimisticTx(item.arg); });
  repaintTxList();
}
/* Replay oldest-first, serially (writes take a script lock anyway, and order is the
 * order they were entered). `_busy` is also what stops gs() re-queueing a call that
 * fails mid-flush — without it, flushing on a still-dead connection would duplicate
 * every entry it touched. */
function flushQueue(){
  if(flushQueue._busy || !queue().length) return Promise.resolve();
  flushQueue._busy = true;
  var sent = 0;
  return queue().reduce(function(p, item){
    return p.then(function(){
      return gs(item.fn, item.arg).then(function(){ sent++; queueDrop(item.arg.ID); }, function(e){
        // Discard ONLY when GAS itself rejected the payload (a category renamed while
        // offline, say) — that would otherwise retry forever and wedge the queue behind
        // one bad row. Everything else keeps the entry and stops the run: still offline,
        // an expired passphrase cookie, a cancelled or mistyped prompt, a 5xx. Dropping
        // money because the cookie lapsed would be the worst bug in here.
        if(!(e && e._server)) throw e;
        queueDrop(item.arg.ID);
        toast('Dropped an offline entry: '+(e.message||e),'err');
      });
    });
  }, Promise.resolve()).catch(function(){}).then(function(){
    flushQueue._busy = false;
    rebuildPending();
    syncUI();
    if(sent){ toast('Synced '+sent+(sent>1?' entries':' entry'),'ok'); afterMutation(); }
  });
}
window.addEventListener('online', flushQueue);

/* ── login ───────────────────────────────────────────────────────────────────
 * A real <form> with a real password field, NOT window.prompt. prompt() was the
 * single cause of all three complaints about this dialog: it shows the passphrase
 * in clear text, no password manager will ever fill it, and on iOS its field
 * autocapitalises and autocorrects — which is why the passphrase used to take
 * several attempts to land. The form is what makes iOS offer AutoFill (the key
 * above the keyboard) and offer to save into Apple Passwords on submit; the
 * username field is there so the saved entry has a name to match on.
 * A wrong passphrase now re-asks in place instead of rejecting every in-flight
 * call, so one typo no longer costs you the whole boot.
 * Shared between concurrent callers: boot fires several /api calls at once, so a
 * lapsed cookie produces several 401s together — without this you get a stack of
 * identical dialogs, one per in-flight request. */
var _unlocking = null;
function unlock(){
  if (_unlocking) return _unlocking;
  _unlocking = new Promise(function(resolve, reject){
    var f = el('form');
    f.innerHTML =
      '<div class="modal-h"><h3>Unlock</h3></div>' +
      '<div class="modal-b">' +
        '<div class="field"><label for="loginUser">App</label>' +
          '<input id="loginUser" name="username" autocomplete="username" value="Memento Mori" readonly></div>' +
        '<div class="field"><label for="loginPass">Passphrase</label>' +
          '<input id="loginPass" name="password" type="password" autocomplete="current-password" ' +
                 'autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" required>' +
          '<p class="hint" id="loginErr" style="color:var(--neg)" hidden></p></div>' +
      '</div>' +
      '<div class="modal-f"><button type="button" class="btn" id="loginCancel">Cancel</button>' +
        '<button type="submit" class="btn primary">Unlock</button></div>';
    openModal(f);
    closeModal.onClose = function(){ reject(new Error('Locked')); };   // backdrop / Escape / ✕
    $('#loginCancel', f).onclick = closeModal;
    setTimeout(function(){ $('#loginPass', f).focus(); }, 0);
    f.onsubmit = function(e){
      e.preventDefault();
      var pass = $('#loginPass', f).value, btn = $('.btn.primary', f), err = $('#loginErr', f);
      btn.disabled = true; err.hidden = true;
      fetch('/login', { method:'POST', headers:{'Content-Type':'application/json'},
                        body:JSON.stringify({ pass:pass }) })
        .then(function(r){
          btn.disabled = false;
          if (!r.ok){ err.textContent = 'Wrong passphrase'; err.hidden = false; $('#loginPass', f).select(); return; }
          closeModal.onClose = null; closeModal();
          resolve();
        }, function(){
          btn.disabled = false;
          err.textContent = 'No connection'; err.hidden = false;
        });
    };
  });
  _unlocking.then(function(){ _unlocking = null; }, function(){ _unlocking = null; });
  return _unlocking;
}

/* ── stale-while-revalidate cache, revalidated with an ETag ──────────────────
 * cachedCall(key, loader, onData): paint instantly from cache, then re-ask for the
 * payload WITH the tag we already hold. Unchanged → 304, no body, nothing repainted.
 * Changed → the new payload, cached and repainted. onData may fire twice: once from
 * cache, once after a real refetch. `loader(etag)` returns a Promise.
 *
 * This replaced one `meta.data_version` counter in v2.9.0. A counter can only say
 * "something, somewhere, changed", so ANY write — a Telegram ingest at 03:00 the
 * owner never saw — re-downloaded every screen the phone had cached. A tag over the
 * payload's own bytes answers the question actually being asked, "is THIS screen
 * different?", and it is the only thing that can see the month-, year- and
 * page-scoped keys below: today's transaction does not change `dashboard|2026-Mar`,
 * so browsing back through history now answers 304 instead of refetching in full.
 *
 * REVAL_TTL is the one part of the counter worth keeping: a key revalidated inside
 * the window is not revalidated again, which kills the duplicate requests from a
 * re-render or a quick tab flip. Data Saver widens it to a minute — on a cell
 * connection the cost is the RADIO WAKE-UP, not the ~200 bytes, and walking four
 * screens used to spend four of them. Refresh clears the stamps, so a forced check
 * is still one tap. `connection` is Chromium-only; everywhere else gets 3000. */
var REVAL_TTL = (navigator.connection && navigator.connection.saveData) ? 60000 : 3000;
function fresh(c){ return c && (Date.now() - (c.at||0)) < REVAL_TTL; }
/* Post-write invalidation. The TAGS are kept on purpose: a write moves some screens
 * and not others, and the ones it did not move now answer 304 on their next visit
 * instead of refetching. Only the freshness stamp goes, so every key revalidates. */
function dropCache(){
  Object.keys(S.cache).forEach(function(k){ S.cache[k].at = 0; });
  saveCache();
}
function putCache(key, data, etag){
  S.cache[key] = { data:data, etag:etag||null, at:Date.now() };
  saveCache();
}
function cachedCall(key, loader, onData){
  var cached = S.cache[key], gen = screenGen;
  // Cache the payload regardless, but only PAINT it if the screen that asked for it
  // is still on screen — otherwise a slow fetch lands after you've navigated away and
  // yanks you back to the screen you left.
  function emit(d){ if (gen === screenGen) onData(d); }
  if (cached){
    emit(cached.data);                    // instant paint from cache
    if (fresh(cached)) return Promise.resolve();
  }
  return loader(cached && cached.etag).then(function(data){
    if (data && data.__304){               // unchanged: keep the paint, restamp
      cached.at = Date.now(); saveCache();
      return;
    }
    var etag = data && data.__etag; if (data) delete data.__etag;
    putCache(key, data, etag); emit(data);
  }).catch(function(e){
    // A cold key has nothing on screen, so its caller still needs the error. With a
    // cached paint up, a revalidation hiccup is not worth one — keep showing stale.
    if (!cached) throw e;
  });
}

/* ── cache persistence ───────────────────────────────────────────────────────
 * The ETag makes the cache safe to reuse across a reload, so keep it in
 * localStorage: a reload (or reopening the home-screen shortcut) paints from disk
 * and spends one 304 instead of going cold on every screen. The TAG is persisted
 * with the payload — that is what makes the first request after a relaunch
 * conditional rather than a full download. Since
 * v1.6.0 this actually survives: the app has a stable origin of its own, where the
 * old GAS sandbox origin could rotate and wipe it. Still best-effort (Safari
 * evicts under storage pressure and in private browsing). */
// `s` is a schema stamp: bump it whenever a cached payload's SHAPE changes, so a
// deploy can't leave the old session's blob rendering against new code.
var LS_CACHE = 'mm.cache', LS_SCHEMA = 14;   // 2 = D1 cutover; 3 = netWorthHistory; 4 = sharesHistory; 5 = pulse/runway; 6 = listTable.tables; 7 = budget *Native figures; 8 = cost basis + the NW bridge; 9 = ETag entries + budgets carries recurring; 10 = the dashboard carries the budgets payload; 11 = runway.parts; 12 = listTransactions.net + bootstrap.smartLists; 13 = bootstrap.quickPicks + descCategory; 14 = positions carry price + pulse.excluded
function saveCache(){
  clearTimeout(saveCache._t);
  saveCache._t = setTimeout(function(){
    try{
      // ponytail: keep the last 12 keys — that's the entire eviction policy. Object
      // key order is insertion order, and an evicted key just goes cold once.
      var keys = Object.keys(S.cache).slice(-12), c = {};
      keys.forEach(function(k){ c[k] = S.cache[k]; });
      var boot = S.boot ? { data:S.boot, etag:S.bootEtag } : null;
      localStorage.setItem(LS_CACHE, JSON.stringify({ s:LS_SCHEMA, boot:boot, cache:c }));
    }catch(e){ try{ localStorage.removeItem(LS_CACHE); }catch(e2){} }  // quota/full → start clean
  }, 400);
}
function loadCache(){
  try{
    var o = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
    if(!o || o.s !== LS_SCHEMA) return false;
    if(o.cache) S.cache = o.cache;
    if(o.boot){ S.boot = o.boot.data ? o.boot.data : null; S.bootEtag = o.boot.etag || null; }
    return !!o.boot;
  }catch(e){ return false; }
}

/* Transaction-page fetch. st = {filters,offset,limit}. */
function fetchTxPage(st,etag){
  var args={ limit:st.limit, offset:st.offset }, fl=st.filters||{};
  TX_KEYS.forEach(function(k){ if(fl[k]) args[k]=fl[k]; });
  return gs('api_listTransactions',args,etag);
}

/* ── app state ───────────────────────────────────────────────────────────── */
var S = {
  boot:null,            // getBootstrap payload
  month:null,           // selected period "yyyy-MMM"
  screen:'dashboard',
  bootEtag:null,        // the ETag of the getBootstrap payload in S.boot
  cache:{},             // key → { data, etag, at } (stale-while-revalidate, persisted)
  // edit: Activity's Select mode (checkboxes + bulk bar + inline edit); filters: the
  // tokens (TX_KEYS); sel: ID → true for the bulk selection. pending*: optimistic writes.
  tx:{ rows:[], total:0, net:0, offset:0, limit:50, filters:{}, edit:false, sel:{},
       pendingAdds:[], pendingDeletes:{}, pendingEdits:{} },
  // admin: which whitelisted table the Admin grid is showing (sticky, like the screen)
  admin:{ table:(function(){ try{ return localStorage.getItem('mm.adminTable')||''; }catch(e){ return ''; } })(), offset:0 },
  taxYear:null,         // the Tax screen's year; null = the current one
  // Dashboard cash-flow window, in months. Sticky per device; the default follows
  // the screen's SHORT edge, so a phone gets 6 bars and an iPad/desktop 12 in both
  // orientations (innerWidth would call a landscape phone a tablet).
  cfMonths:({6:6,12:12,24:24})[+prefGet('cfMonths')] || (typeof screen!=='undefined'&&Math.min(screen.width,screen.height)>=700?12:6)
};

var PHP = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2});
var PHP0 = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:0});
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* ── tiny DOM helpers ────────────────────────────────────────────────────── */
function $(s,r){return (r||document).querySelector(s);}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function money(n,big){if(n==null||n==='')return '—';return (big?PHP0:PHP).format(Number(n));}
// Currency-aware format — used for non-PHP transactions so a USD amount renders
// as $ (narrow symbol), not ₱. Falls back to "CUR 1,234.56" on unknown codes.
var _curFmt={};
function moneyCur(n,cur){
  if(n==null||n==='')return '—';
  cur=cur||'PHP';
  if(cur==='PHP')return PHP.format(Number(n));
  try{ if(!_curFmt[cur])_curFmt[cur]=new Intl.NumberFormat('en-PH',{style:'currency',currency:cur,currencyDisplay:'narrowSymbol',maximumFractionDigits:2});
       return _curFmt[cur].format(Number(n)); }
  catch(e){ return cur+' '+Number(n).toLocaleString('en-PH',{maximumFractionDigits:2}); }
}
function num(n){return n==null?'—':Number(n).toLocaleString('en-PH',{maximumFractionDigits:4});}
// USD equivalent of a PHP figure, at bootstrap's live rate. '' while the rate is
// not loaded yet — the re-render after boot lands fills it in.
function usdOf(php){var r=S.boot&&S.boot.fxUsdPhp;return (php==null||!r)?'':moneyCur(php/r,'USD');}
function pct(n){return n==null?'—':(Math.round(n*10)/10)+'%';}
/* A gain reads '+' explicitly, so the sign is text and not only color. */
function signedMoney(n){return n==null?'—':((n>0?'+':'')+money(n,true));}

/* ── account color helpers (color-coding across screens) ─────────────────── */
function isHex6(c){return !!c && /^#[0-9a-fA-F]{6}$/.test(c);}
// Look up an account's color by name from the bootstrap (null if boot not loaded).
function acctColor(name){
  if(!S.boot||!name) return null;
  var a=(S.boot.accounts||[]).filter(function(x){return x.name===name;})[0];
  return (a && isHex6(a.color))?a.color:null;
}
// A small colored dot (validated hex, so safe to inline into innerHTML).
function dotHTML(c){ return isHex6(c)?'<span class="acct-dot" style="background:'+c+'"></span>':''; }
// Account options for comboEl, carrying each account's color for the dropdown dots.
function acctOptions(){
  return (S.boot&&S.boot.accounts?S.boot.accounts:[]).map(function(a){
    return {value:a.name,label:a.name,color:a.color};
  });
}
function acctCurrency(name){
  var a=((S.boot&&S.boot.accounts)||[]).filter(function(x){return x.name===name;})[0];
  return a?(a.currency||'PHP'):'PHP';
}
// A tx is a transfer if its derived Type says so or it carries a ToAccount.
function txIsXfer(t){ return String(t.Type||'')==='Transfer'||!!(t.ToAccount&&String(t.ToAccount).trim()); }
// Categories valid for a row's shape: Transfer categories only on transfers, and
// vice versa (mirrors the server invariant so the picker can't offer a mismatch).
function catsForShape(isXfer){
  var c=(S.boot&&S.boot.categories)||{};
  return Object.keys(c).filter(function(k){ return (String(c[k].Type)==='Transfer')===!!isXfer; }).sort();
}

/* ── toast ───────────────────────────────────────────────────────────────── */
/* A modal <dialog> makes the whole document outside it inert — live regions included —
 * so an error raised from inside a form would never be announced from #toastRoot's
 * usual place. Park the host in whichever dialog is on top instead. It is fixed and
 * pointer-events:none, so the move never shows. The modal is always the upper of the
 * two: the only stack in the app is the unlock dialog over the editor. */
function toastRoot(){
  var m=$('#modalRoot'), host=(m&&m.open)?m:((ED.root&&ED.root.open)?ED.root:document.body);
  var r=$('#toastRoot');
  if(r.parentNode!==host) host.appendChild(r);
  return r;
}
function toast(msg,kind){
  var t=el('div','toast '+(kind||''),esc(msg));
  toastRoot().appendChild(t);
  var ms = kind==='err'?6000:2400; // errors linger long enough to read
  setTimeout(function(){t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(function(){t.remove();},300);},ms);
}

/* ── month helpers ───────────────────────────────────────────────────────── */
function monthKey(d){return d.getFullYear()+'-'+MONTHS[d.getMonth()];}      // "2026-Jun"
function monthLabel(m){var p=String(m).split('-');return p.length===2?p[1]+' '+p[0]:m;} // "Jun 2026"
function monthOptions(){return buildMonthList().map(function(m){return {value:m,label:monthLabel(m)};});}
/* The period control lives on the screen it actually drives (the Dashboard),
 * not the topbar — there it was a silent no-op on the other six screens, since
 * Transactions owns its month as one of five in-screen filters.
 * Refocus after the repaint: the picker is inside the screen we just replaced, and
 * arrow-keying a closed <select> fires change per keypress. */
function monthPickerEl(){
  var mp=el('select','month-picker'); mp.title='Period';
  buildMonthList().forEach(function(m){var o=el('option');o.value=m;o.textContent=monthLabel(m);mp.appendChild(o);});
  mp.value=S.month;
  mp.onchange=function(){
    // Do NOT wipe S.cache here: the 'dashboard|<month>' keys are already
    // month-scoped keys, so flipping the picker repaints a visited month from cache
    // (version-gated) instead of refetching behind a skeleton.
    S.month=mp.value;
    Promise.resolve(render()).then(function(){ var n=$('.month-picker'); if(n) n.focus(); });
  };
  return mp;
}
function buildMonthList(){
  var out=[], now=new Date();
  // Extend back to the oldest ledger month so older history is reachable; floor at
  // 15 months (before any data lands) and cap at 120 to bound a huge/garbled ledger.
  var min=(S.boot&&S.boot.minMonth)?monthKey2date(S.boot.minMonth):null;
  var count=15;
  if(min){
    var months=(now.getFullYear()-min.getFullYear())*12+(now.getMonth()-min.getMonth())+1;
    count=Math.min(120,Math.max(15,months));
  }
  // Starts at i=-1 (NEXT month) so income booked forward via Period — salary paid on
  // the 29th for the following month — is both selectable and viewable.
  for(var i=-1;i<count;i++){var d=new Date(now.getFullYear(),now.getMonth()-i,1);out.push(monthKey(d));}
  return out;
}
// "2026-Jun" → Date(first of month); null on bad input.
function monthKey2date(m){
  var p=String(m).split('-'); if(p.length!==2) return null;
  var mi=MONTHS.indexOf(p[1]); if(mi<0) return null;
  return new Date(parseInt(p[0],10),mi,1);
}

/* ── boot ────────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', boot);

// getBootstrap (categories/accounts for modals & filters) loads in the BACKGROUND
// so the first screen can paint without waiting on it / on the live FX fetch.
var _bootPromise=null;
function applyBoot(b){
  S.bootEtag = b.__etag || null; delete b.__etag;
  S.boot=b;
  // getBootstrap already carries the full api_getAccounts payload, so seed that
  // screen's cache key from it — the Accounts screen then opens with zero fetches.
  // No tag of its own (bootstrap's tag is not getAccounts' tag), so the first visit
  // after REVAL_TTL costs one full fetch and every visit after that is conditional.
  if(b.accounts) S.cache['accounts']={data:{status:'success',accounts:b.accounts},etag:null,at:Date.now()};
  saveCache();
  return b;
}
function ensureBoot(){
  if(S.boot) return Promise.resolve(S.boot);   // incl. a boot restored from storage
  if(!_bootPromise) _bootPromise=gs('api_getBootstrap').then(applyBoot);
  return _bootPromise;
}
/* A boot restored from localStorage is stale by definition, so revalidate it in the
 * background — conditionally, since this is the biggest single payload the app pulls
 * (every account, every category, the budgets and the recurring rows). A launch that
 * changed nothing now costs one 304 instead of all of it. */
function revalidateBoot(){
  var old=S.boot;
  return gs('api_getBootstrap', null, S.bootEtag).then(function(b){
    if(b.__304) return old;
    applyBoot(b);
    render();
    return b;
  });
}
/** Run cb once reference data is available (used by modals/filters that need it). */
function withBoot(cb){
  if(S.boot) return cb();
  toast('Loading…');
  return ensureBoot().then(cb).catch(function(e){ toast(e.message||e,'err'); });
}

/* ── last-resort net ─────────────────────────────────────────────────────────
 * Every fetch path already has a .catch. What had nothing was a throw OUTSIDE one:
 * a render reading a field a stale cached payload doesn't carry, or an API iOS
 * doesn't ship. That left #main half-painted or blank — no toast, no Retry, nothing
 * to do but force-quit the app. Toast it always, and when there is nothing usable on
 * screen fall back to showErr, which at least offers a way back.
 * Resource errors (a failed <img>) arrive here with e.target and no e.error; they are
 * not ours to report. */
function crash(e){
  var msg = (e && e.message) || String(e || 'Something went wrong');
  try{
    toast(msg,'err');
    var m = $('#main');
    if(m && (!m.firstElementChild || $('#bootLoader'))) showErr(msg);
  }catch(e2){}   // a handler that throws would loop straight back into itself
}
window.addEventListener('error', function(e){ if(e.error) crash(e.error); });
window.addEventListener('unhandledrejection', function(e){ crash(e.reason); });

/* ── resume ──────────────────────────────────────────────────────────────────
 * iOS suspends a backgrounded PWA and restores it in place, so coming back through
 * the app switcher can show figures from days ago under a green "Synced" dot. There
 * is no push and nothing self-refreshes, so the return to the foreground IS the
 * signal. dropCache keeps the ETags, so a screen that did not move costs a 304.
 * The threshold is REVAL_TTL on purpose: a quick flip to the Telegram bot and back
 * still repaints at once, while Data Saver's 60 s protects the radio wake-up. */
var _hidAt = 0;
function onResume(){
  if(document.hidden){ _hidAt = Date.now(); return; }
  if(Date.now() - _hidAt < REVAL_TTL) return;
  dropCache();
  flushQueue();   // 'online' does not fire for an app that was suspended offline
  // Never while the owner is mid-entry: a repaint would throw away an open editor or
  // an inline-edit cell. The stamps are already cleared, so the next navigation
  // revalidates anyway — only the immediate repaint is skipped.
  var a = document.activeElement;
  if(edOpen() || $('#modalRoot').open || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
  render();
}

function boot(){
  var warm = loadCache();   // before the first render: paint from the last session
  S.month = monthKey(new Date());
  document.querySelectorAll('.nav-item[data-screen]').forEach(function(b){
    b.addEventListener('click', function(){ go(b.dataset.screen); });
  });
  // mobile "More" sheet (secondary screens)
  $('#navMore').addEventListener('click', openSheet);
  $('.sheet-backdrop').addEventListener('click', closeSheet);
  document.querySelectorAll('.sheet-item').forEach(function(b){
    b.addEventListener('click', function(){ go(b.dataset.screen); });
  });
  wireShell();

  // Browser back/forward moves between screens. Plain History API now that the app
  // is served from its own origin instead of the GAS sandbox iframe (which blocked
  // pushState and needed google.script.history).
  window.addEventListener('popstate', function(){
    var s=new URLSearchParams(location.search).get('screen')||'dashboard';
    if(s!==S.screen) go(s,true);
  });
  document.addEventListener('visibilitychange', onResume);
  // Safari's back/forward cache restores a whole live page, which the visibility
  // event does not cover; the same staleness applies.
  window.addEventListener('pageshow', function(e){ if(e.persisted){ _hidAt = 0; onResume(); } });
  // Scroll-wheel over a focused number input silently changes the value — block it.
  document.addEventListener('wheel',function(e){
    if(e.target.type==='number' && document.activeElement===e.target) e.preventDefault();
  },{passive:false});

  // Paint the first screen right away (it fetches its own data); hydrate the
  // reference data in parallel, then re-render so warm FX / counts are reflected.
  // One synchronous decision, so a reload never flashes the Dashboard first:
  // ?screen= (a bookmarked or Telegram-sent link) wins over the stored last screen.
  // Before the first paint, so anything written while offline is already in the row
  // list the render is about to build (S.screen is still the default here, so this
  // can't re-enter renderTxList early).
  rebuildPending();
  var p=new URLSearchParams(location.search);
  var first=p.get('screen')||lastScreen();
  if(first) go(first,true); else render();
  // Write the screen we actually opened into this history entry, and drop ?tx=: Back
  // from the next screen then returns here (not to Summary), and a reload does not
  // reopen the editor.
  history.replaceState(null,'','?screen='+encodeURIComponent(S.screen));
  // ?tx=<ID> — the Telegram receipt's "Edit details" button: open that row's modal.
  if(p.get('tx')) openTxById(p.get('tx'));
  (warm ? revalidateBoot() : ensureBoot().then(function(){
    if(S.screen==='dashboard'||S.screen==='accounts'||S.screen==='investments') render();
  })).catch(function(e){ toast('Reference data failed: '+(e.message||e),'err'); });
  // Launching IS a reconnect signal: the 'online' event doesn't fire for an app that
  // was closed while offline and reopened with a connection.
  flushQueue();
}

function refresh(){
  var btns=document.querySelectorAll('.sync'); btns.forEach(function(b){ b.classList.add('busy'); });
  S.cache={}; S.boot=null; S.bootEtag=null; _bootPromise=null; saveCache();
  // Also drop the cached shell and retry the queue, which makes Refresh the single
  // answer to both "I deployed and still see the old UI" (a cached shell on a slow network,
  // see sw.js) and "this is still waiting to sync".
  if(window.caches) caches.keys().then(function(ks){ ks.forEach(function(n){ caches.delete(n); }); });
  flushQueue();
  ensureBoot().then(function(){ return render(); }).finally(function(){ btns.forEach(function(b){ b.classList.remove('busy'); }); });
}

/* ── shell: theme, sync state, the add field ─────────────────────────────────
 * The nav, the add bar and the More sheet are static markup in index.html; this
 * wires them. One nav element is the tab bar, the rail or the sidebar by width
 * (app.css), so nothing here branches on the layout. */

/* Theme: Auto / Light / Dark per device (DESIGN.md "Input parity and keys").
 * 'mm.theme' absent = Auto. index.html's head script applies it before first
 * paint; this is the same rule for a switch at run time. */
var THEME_BG={light:'#F2F2F7',dark:'#000000'};   // = --bg; the theme-color meta cannot read a var()
var darkMQ=window.matchMedia?matchMedia('(prefers-color-scheme: dark)'):null;
function themePref(){ try{ var t=localStorage.getItem('mm.theme'); return t==='light'||t==='dark'?t:'auto'; }catch(e){ return 'auto'; } }
function themeNow(){ var p=themePref(); return p!=='auto'?p:(darkMQ&&darkMQ.matches?'dark':'light'); }
function applyTheme(pref, fade){
  try{ if(pref==='auto') localStorage.removeItem('mm.theme'); else localStorage.setItem('mm.theme',pref); }catch(e){}
  var root=document.documentElement;
  if(fade){ root.classList.add('theme-fade'); setTimeout(function(){ root.classList.remove('theme-fade'); },220); }
  if(pref==='auto') delete root.dataset.theme; else root.dataset.theme=pref;
  var m=$('meta[name=theme-color]'); if(m) m.content=THEME_BG[themeNow()];
  var now=themeNow();
  document.querySelectorAll('link[rel=icon],link[rel=apple-touch-icon]').forEach(function(l){ l.href=now==='dark'?'/icon-180-dark.png':'/icon-180.png'; });
  document.querySelectorAll('.theme-btn').forEach(function(b){
    // The icon shows where a tap goes: a sun in dark, a moon in light.
    b.innerHTML=icon(now==='dark'?'sun':'moon');
    var label='Switch to '+(now==='dark'?'light':'dark')+(pref==='auto'?' (now following the system)':'');
    b.setAttribute('aria-label',label); b.title=label+' · '+MOD+' Shift L · right-click or hold for Auto';
  });
}
function toggleTheme(){ applyTheme(themeNow()==='dark'?'light':'dark', true); }
function themeAuto(){ applyTheme('auto', true); toast('Theme follows the system','ok'); }
function wireThemeBtn(b){
  var held=null, skip=false;
  b.addEventListener('click',function(){ if(skip){ skip=false; return; } toggleTheme(); });
  b.addEventListener('contextmenu',function(e){ e.preventDefault(); themeAuto(); });
  // Long press on touch = Auto. iOS sends no contextmenu for a button, so time it.
  b.addEventListener('pointerdown',function(e){
    if(e.pointerType!=='touch') return;
    held=setTimeout(function(){ held=null; skip=true; themeAuto(); },550);
  });
  ['pointerup','pointerleave','pointercancel'].forEach(function(ev){
    b.addEventListener(ev,function(){ if(held){ clearTimeout(held); held=null; } });
  });
}
// Auto follows a system switch live, not only at the next launch.
if(darkMQ&&darkMQ.addEventListener) darkMQ.addEventListener('change',function(){ if(themePref()==='auto') applyTheme('auto'); });

var IS_APPLE=/Mac|iPhone|iPad/.test((typeof navigator!=='undefined'&&(navigator.platform||navigator.userAgent))||'');
var MOD=IS_APPLE?'⌘':'Ctrl';

/** One icon from the sprite in index.html, as markup. */
function icon(name){ return '<svg class="ico" aria-hidden="true"><use href="#i-'+name+'"/></svg>'; }

/* Sync state: online / offline / N queued. "Offline" is what gs() last saw (a
 * fetch that rejected), not navigator.onLine, which reads true on a captive portal. */
var net={offline:false, at:0};
function netSeen(ok){
  net.offline=!ok; if(ok) net.at=Date.now();
  syncUI();
}
/** The words for the sync state. Pure, so test.js can pin them. */
function syncText(offline, queued, at, now){
  if(queued) return (offline?'Offline · ':'')+queued+' waiting to sync';
  if(offline) return 'Offline';
  if(!at) return 'Synced';
  var min=Math.floor((now-at)/60000);
  return min<1?'Synced just now':min<60?'Synced '+min+' min ago':'Synced '+Math.floor(min/60)+' h ago';
}
function syncUI(){
  var q=queue().length, txt=syncText(net.offline,q,net.at,Date.now());
  document.querySelectorAll('.sync').forEach(function(b){
    b.classList.toggle('offline',net.offline); b.classList.toggle('queued',!!q);
    $('.sync-label',b).textContent=txt;
    b.title=txt+' · tap to refresh'; b.setAttribute('aria-label',b.title);
  });
  var more=$('#navMore'); if(more) more.classList.toggle('alert', net.offline||!!q);
}
window.addEventListener('offline',function(){ netSeen(false); });
// Back online is not "synced": clear the flag, and let the next answer stamp the time.
window.addEventListener('online',function(){ net.offline=false; syncUI(); });

/* ════ The add field: type to add, search or jump ════
 * parseAdd is the instant, local pass: the amount, the account (a name typed in full or
 * as a 3+ letter prefix), and the category the same description had last time
 * (getBootstrap.descCategory). Two accounts make a transfer only with "to" between
 * them, so "grab 312 gcash" stays an expense even with a GrabPay account. Gemini
 * (getParse, the bot's parser) fills what is left, ON RETURN ONLY. It used to also fire
 * 700ms after a typing pause, which billed a call per pause instead of per add — the AI
 * answer is dropped the moment the text changes (qaDraft), so every pause re-armed it. */
function parseAdd(text,ctx){
  var norm=function(s){ return String(s).toLowerCase().replace(/[^a-z0-9]/g,''); };
  var words=String(text||'').trim().split(/\s+/).filter(Boolean), out={Amount:null,Account:'',ToAccount:'',Category:'',Description:''};
  for(var i=0;i<words.length;i++){
    var m=/^([-+]?)[₱$]?(\d[\d,]*(?:\.\d+)?)(k?)$/i.exec(words[i]);
    if(m){ out.Amount=Number(m[2].replace(/,/g,''))*(m[3]?1000:1)*(m[1]==='-'?-1:1); words.splice(i,1); break; }
  }
  function acct(w){
    var n=norm(w); if(!n) return null;
    var hit=ctx.accounts.filter(function(a){ return norm(a)===n; });
    if(!hit.length&&n.length>=3) hit=ctx.accounts.filter(function(a){ return norm(a).indexOf(n)===0; })
      .sort(function(a,b){ return fuzzyScore(w,b)-fuzzyScore(w,a); });
    return hit[0]||null;
  }
  var found=[];   // [{i, n (words), name}]; a two-word name is tried first
  for(i=0;i<words.length;i++){
    var two=i+1<words.length&&acct(words[i]+words[i+1]);
    if(two&&norm(two)===norm(words[i]+words[i+1])){ found.push({i:i,n:2,name:two}); i++; continue; }
    var one=acct(words[i]); if(one) found.push({i:i,n:1,name:one});
  }
  var drop={}, to=-1, src=null, dst=null;
  words.forEach(function(w,j){ if(/^(to|->|→)$/i.test(w)) to=j; });
  if(to>=0){
    src=found.filter(function(f){ return f.i<to; }).pop(); dst=found.filter(function(f){ return f.i>to; })[0];
    if(!src||!dst||src.name===dst.name) src=dst=null;
  }
  var use=src?[src,dst]:found.length?[found[found.length-1]]:[];   // "desc amount account": the last name wins
  use.forEach(function(f){ drop[f.i]=1; if(f.n===2) drop[f.i+1]=1; });
  if(src){ drop[to]=1; out.Account=src.name; out.ToAccount=dst.name; }
  else if(use.length) out.Account=use[0].name;
  var d=words.filter(function(w,j){ return !drop[j]; }).join(' ');
  out.Description=d?d.charAt(0).toUpperCase()+d.slice(1):'';
  out.Category=out.ToAccount?'':((ctx.descCategory||{})[d.toLowerCase()]||'');
  return out;
}
function qaCtx(){
  return {accounts:acctOptions().map(function(o){ return o.value; }), descCategory:(S.boot&&S.boot.descCategory)||{}};
}
function catType(c){ var x=((S.boot&&S.boot.categories)||{})[c]; return String((x&&x.Type)||''); }

var QA={open:false, text:'', ai:null, aiFor:'', aiBusy:false, over:{}, kind:'', sel:0, rows:[]};
// The draft = the local parse, then Gemini's answer for the same text, then the owner's own picks.
function qaDraft(){
  var d=parseAdd(QA.text,qaCtx()), ai=QA.aiFor===QA.text.trim()&&QA.ai;
  if(ai){
    ['Amount','Account','ToAccount','ToAmount','Category'].forEach(function(k){ if(!d[k]&&ai[k]) d[k]=ai[k]; });
    if(ai.Description!=null) d.Description=ai.Description;
    if(ai.Date) d.Date=ai.Date;
  }
  Object.keys(QA.over).forEach(function(k){ d[k]=QA.over[k]; });
  if(!d.Account){ var la=prefGet('lastAcct'); if(la&&qaCtx().accounts.indexOf(la)>=0) d.Account=la; }
  d.Date=d.Date||newTxDate();
  var kind=QA.kind||(d.ToAccount?'xfer':catType(d.Category)==='Income'?'in':'out');
  if(kind==='xfer'){ if(catType(d.Category)!=='Transfer') d.Category=catType('Transfer: Internal')?'Transfer: Internal':''; }
  else { d.ToAccount=''; if(d.Category&&catType(d.Category)!==(kind==='in'?'Income':'Expense')) d.Category=''; }
  d.kind=kind; return d;
}
// A transfer between two currencies is complete only with the amount that ARRIVED — the
// local parse cannot know it, so it asks Gemini, then opens the full form.
function xferNeedsTo(from,to,toAmt){ return !!(from&&to&&!toAmt&&acctCurrency(from).toUpperCase()!==acctCurrency(to).toUpperCase()); }
function qaComplete(d){ return !!(d.Amount&&d.Account&&d.Category&&(d.kind!=='xfer'||(d.ToAccount&&d.ToAccount!==d.Account&&!xferNeedsTo(d.Account,d.ToAccount,d.ToAmount)))); }

// ⌘K: jump rows (screens) and the Activity search. Text with a digit is an add, not a jump.
function qaJumps(text){
  var q=text.trim(); if(!q) return [];
  var rows=[];
  if(!/\d/.test(q)) document.querySelectorAll('#nav .nav-item[data-screen]').forEach(function(b){
    var sc=fuzzyScore(q,b.title);
    if(sc>=40) rows.push({sc:sc,label:'Go to '+b.title,icon:'chevron',screen:b.dataset.screen});
  });
  rows.sort(function(a,b){ return b.sc-a.sc; });
  rows.push({label:'Search Activity for “'+q+'”',icon:'search',search:q});
  return rows;
}

function qaShow(){
  if(!$('#qa')){
    var bd=el('div','qa-bd'); bd.onclick=function(){ qaHide(); $('#addInput').blur(); }; $('#app').appendChild(bd);
    var p=el('div','qa'); p.id='qa'; $('.addbar').appendChild(p);
    // iPhone: the panel is a full-screen page, so it needs its own way out.
    var top=el('div','qa-top'), x=barBtn('Cancel','',function(){ qaHide(); $('#addInput').blur(); });
    top.appendChild(x); top.appendChild(el('div','ed-title','Add')); top.appendChild(el('span'));
    $('.addbar').appendChild(top);
    // A tap inside must not blur the field (the keyboard would drop mid-edit).
    p.addEventListener('mousedown',function(e){ if(!e.target.closest('input')) e.preventDefault(); });
  }
  QA.open=true; document.body.classList.add('qa-on'); qaDraw(); qaFit();
}
function qaHide(){ QA.open=false; document.body.classList.remove('qa-on'); var p=$('#qa'); if(p) p.innerHTML=''; qaFit(); }
function qaReset(){
  QA.text=''; QA.ai=null; QA.aiFor=''; QA.over={}; QA.kind=''; QA.sel=0;
  $('#addInput').value=''; qaHide();
}

function qaDraw(){
  var p=$('#qa'); if(!p||!QA.open) return;
  p.innerHTML='';
  var text=QA.text.trim(), d=qaDraft(), jumps=d.Amount?[]:qaJumps(text), picks=(S.boot&&S.boot.quickPicks)||[];
  var adding=!!text&&(!!d.Amount||jumps.length===1);   // no amount and no screen match: still an add, with Search under it
  QA.rows=(adding?[{save:1}]:[]).concat(jumps);
  if(QA.sel>=QA.rows.length) QA.sel=0;
  if(adding){
    var card=el('div','qa-card'+(QA.sel===0&&QA.rows.length>1?' sel':''));
    var seg=el('div','seg-toggle qa-seg');
    [['out','Spent'],['in','Earned'],['xfer','Moved']].forEach(function(k){
      var b=el('button',k[0]===d.kind?'on':'',k[1]); b.type='button'; b.setAttribute('aria-pressed',String(k[0]===d.kind));
      b.onclick=function(){ QA.kind=k[0]; qaDraw(); };
      seg.appendChild(b);
    });
    card.appendChild(seg);
    var n=Number(d.Amount)||0, sign=d.kind==='xfer'?'':(d.kind==='out')===(n>0)?'−':'+';
    card.appendChild(el('div','qa-amt '+(n?d.kind:'ph'),n?esc(sign+moneyCur(Math.abs(n),acctCurrency(d.Account))):'No amount yet'));
    card.appendChild(el('div','qa-desc',esc(d.Description||'No description')));
    var g=el('div','ed-group qa-rows');
    var want=d.kind==='xfer'?'Transfer':d.kind==='in'?'Income':'Expense';
    var cats=Object.keys(S.boot.categories||{}).filter(function(c){ return catType(c)===want; }).sort();
    qaRow(g,'Category',d.Category,catItems(cats),'Category');
    qaRow(g,d.kind==='xfer'?'From':'Account',d.Account,acctOptions(),'Account');
    if(d.kind==='xfer') qaRow(g,'To',d.ToAccount,acctOptions(),'ToAccount');
    var dr=el('label','ed-row'); dr.appendChild(el('span','ed-lab','Date'));
    var di=inputEl('date',d.Date); di.className='ed-in ed-date';
    di.onchange=function(){ QA.over.Date=di.value; }; dr.appendChild(di); g.appendChild(dr);
    card.appendChild(g);
    card.appendChild(el('div','qa-hint',QA.aiBusy?'Reading it…':qaComplete(d)?'Return saves · works offline and syncs later':'Return fills the rest, or opens the full form'));
    p.appendChild(card);
  }
  if(jumps.length){
    var list=el('div','ed-group qa-jumps');
    jumps.forEach(function(j,i){
      var k=i+(adding?1:0), b=el('button','ed-row ed-link qa-jump'+(QA.sel===k?' sel':''),icon(j.icon)+'<span class="ed-txt">'+esc(j.label)+'</span>');
      b.type='button'; b.onclick=function(){ qaRun(k); }; list.appendChild(b);
    });
    p.appendChild(list);
  }
  if(picks.length&&(!text||adding)){
    p.appendChild(el('div','qa-lab','Or repeat one'));
    var chips=el('div','qa-chips');
    picks.forEach(function(k){
      var c=el('button','qa-chip',esc(k.Description)+' <b>'+esc(moneyCur(k.Amount,acctCurrency(k.Account)))+'</b>'); c.type='button';
      c.onclick=function(){
        QA.over={Category:k.Category,Account:k.Account}; QA.kind=''; QA.sel=0;
        $('#addInput').value=QA.text=k.Description+' '+k.Amount; qaDraw();
      };
      chips.appendChild(c);
    });
    p.appendChild(chips);
  }
  if(!p.children.length){
    if(qaPhone()) p.appendChild(el('div','qa-hint qa-empty','Type what you spent, like “coffee 180 gcash”'));
    else qaHide();
  }
}
function qaRow(g,label,value,items,key){
  var b=el('button','ed-row ed-link'); b.type='button';
  b.appendChild(el('span','ed-lab',esc(label)));
  var it=items.filter(function(i){ return i.value===value; })[0];
  b.appendChild(el('span','ed-val',it?edDot(it.color)+'<span class="ed-txt">'+esc(it.label)+'</span>':'<span class="ed-ph">Choose</span>'));
  b.insertAdjacentHTML('beforeend',icon('chevron'));
  b.onclick=function(){ openPicker(label,items,value||'',function(v){ QA.over[key]=v; qaDraw(); }); };
  g.appendChild(b);
}

// Gemini, once per text. Offline or a failure keeps the local parse and the typed text.
function qaAsk(){
  var text=QA.text.trim();
  if(!text||QA.aiFor===text||net.offline) return Promise.resolve();
  QA.aiBusy=true; qaDraw();
  return gs('api_getParse',{text:text}).then(function(r){
    if(QA.text.trim()===text){ QA.aiFor=text; QA.ai=(r.items||[])[0]||null; }
  }).catch(function(){ if(QA.text.trim()===text){ QA.aiFor=text; QA.ai=null; } })
    .then(function(){ QA.aiBusy=false; qaDraw(); });
}
function qaInput(){
  QA.text=$('#addInput').value; QA.sel=0; QA.kind='';
  if(!QA.text.trim()) QA.over={};
  if(!S.boot) return withBoot(qaInput);
  if(QA.open) qaDraw(); else qaShow();
}
function qaRun(k){
  var r=QA.rows[k]; if(!r) return;
  if(r.save) return qaSave();
  qaReset(); $('#addInput').blur();
  if(r.search){ S.tx.filters={month:'',search:r.search}; S.tx.offset=0; }
  go(r.screen||'transactions');
}
// Save a whole draft. Else ask Gemini once, then fall back to the filled full form.
function qaSave(){
  if(!S.boot) return withBoot(qaSave);
  var d=qaDraft(), text=QA.text.trim();
  if(!text) return;
  if(!qaComplete(d)&&QA.aiFor!==text&&!net.offline) return qaAsk().then(function(){ if(QA.text.trim()===text) qaSave(); });
  var xfer=d.kind==='xfer', amount=Number(d.Amount);
  var payload={Date:d.Date,Category:d.Category,Account:d.Account,Amount:amount,Description:d.Description};
  if(xfer){ payload.ToAccount=d.ToAccount; if(d.ToAmount) payload.ToAmount=Number(d.ToAmount); }
  qaReset(); $('#addInput').blur();
  if(!qaComplete(d)){
    if(!amount) payload.Amount='';
    (xfer?openTransferModal:openTxModal)(payload);
    return;
  }
  if(!xfer) prefSet('lastAcct',d.Account);
  commitTx({t:null,payload:payload,isEdit:false,create:xfer?'api_createTransfer':'api_createTransaction',
            addedMsg:xfer?'Transfer added':'Added',failMsg:xfer?'Transfer failed':'Add failed',
            reopen:xfer?openTransferModal:openTxModal});
}
function qaKey(e){
  if(e.key==='Enter'){ e.preventDefault(); if(QA.text.trim()) qaRun(QA.sel); }
  else if(e.key==='Escape'){ if(QA.text) qaReset(); else qaHide(); this.blur(); }
  else if((e.key==='ArrowDown'||e.key==='ArrowUp')&&QA.open&&QA.rows.length>1){
    e.preventDefault(); var n=QA.rows.length; QA.sel=(QA.sel+(e.key==='ArrowDown'?1:n-1))%n; qaDraw();
  }
}
// iPhone: the add panel is a full-screen page sized to the VISIBLE viewport, so the
// field sits right on top of the keyboard. iOS pans the page to show a focused field;
// the visual viewport (offsetTop, height) is what is really on screen.
function qaPhone(){ return !matchMedia('(min-width:768px)').matches; }
function qaFit(){
  var bar=$('.addbar'); if(!bar) return;
  bar.style.top=bar.style.height='';
  bar.classList.toggle('kb',!!window.visualViewport&&innerHeight-visualViewport.height>120);
  if(!window.visualViewport||!QA.open||!qaPhone()) return;
  bar.style.top=Math.round(visualViewport.offsetTop)+'px';
  bar.style.height=Math.round(visualViewport.height)+'px';
}
function qaFollowKeyboard(){
  if(!window.visualViewport) return;
  visualViewport.addEventListener('resize',qaFit); visualViewport.addEventListener('scroll',qaFit);
}

function wireShell(){
  document.querySelectorAll('.theme-btn').forEach(wireThemeBtn);
  applyTheme(themePref());
  document.querySelectorAll('.sync').forEach(function(b){ b.addEventListener('click',function(){ closeSheet(); refresh(); }); });
  $('.add-kbd').textContent=MOD+' K';
  $('#addInput').placeholder=matchMedia('(min-width:768px)').matches
    ? 'Add “grab 312 gcash”, search, or jump to a screen' : 'coffee 180 gcash';
  var inp=$('#addInput');
  inp.addEventListener('keydown',qaKey);
  inp.addEventListener('input',qaInput);
  inp.addEventListener('focus',function(){ if(!QA.open) withBoot(qaShow); });
  qaFollowKeyboard();
  // The + opens the full form, carrying whatever is typed (a plain click on the field focuses it).
  $('.add-plus').addEventListener('click',function(e){
    e.preventDefault();
    withBoot(function(){
      var d=qaDraft(), x=d.kind==='xfer', f=QA.text.trim()?{Date:d.Date,Account:d.Account,ToAccount:x?d.ToAccount:'',Amount:d.Amount||'',Description:d.Description,Category:d.Category}:null;
      qaReset(); inp.blur(); (x?openTransferModal:openTxModal)(f);
    });
  });
  document.addEventListener('keydown',function(e){
    var mod=e.metaKey||e.ctrlKey;
    if($('#modalRoot').open) return;   // a modal owns the keys while it is up
    if(mod && !e.shiftKey && (e.key==='k'||e.key==='K')){ e.preventDefault(); $('#addInput').focus(); }
    else if(mod && e.shiftKey && (e.key==='l'||e.key==='L')){ e.preventDefault(); toggleTheme(); }
  });
  syncUI();
  setInterval(syncUI, 30000);   // "Synced N min ago" ages on its own
}

/* ── tooltip (ⓘ) ─────────────────────────────────────────────────────────────
 * DESIGN.md "Tooltip". tip(spec) returns the ⓘ button; the popover is built on
 * open. spec = {title, text, rows:[[label, value, bold?]], note}. Mouse: hover or
 * focus opens it. Touch: a tap on the ⓘ. Esc or a tap outside closes it, and
 * only one is open at a time. */
function tipHTML(spec){
  var h='';
  if(spec.title) h+='<div class="tip-t">'+esc(spec.title)+'</div>';
  if(spec.text) h+='<div class="tip-p">'+esc(spec.text)+'</div>';
  if(spec.rows&&spec.rows.length) h+='<div class="tip-rows">'+spec.rows.map(function(r){
    var c=r[2]?' class="b"':''; return '<span'+c+'>'+esc(r[0])+'</span><span'+c+'>'+esc(r[1])+'</span>';
  }).join('')+'</div>';
  if(spec.note) h+='<div class="tip-note">'+esc(spec.note)+'</div>';
  if(spec.link) h+='<a class="tip-a" href="'+esc(spec.link[0])+'" target="_blank" rel="noopener">'+esc(spec.link[1])+'</a>';
  return h;
}
var tipOpen=null, tipInPop=false;   // {btn, pop}; the pointer is on the popover (its link)
function tipClose(){
  tipInPop=false;
  if(!tipOpen) return;
  tipOpen.btn.setAttribute('aria-expanded','false'); tipOpen.pop.remove(); tipOpen=null;
}
function tipShow(btn, spec){
  if(tipOpen&&tipOpen.btn===btn) return;
  tipClose();
  var pop=el('div','tip',tipHTML(typeof spec==='function'?spec():spec));
  pop.setAttribute('role','tooltip'); pop.id='tip-live';
  pop.addEventListener('mouseenter',function(){ tipInPop=true; });
  pop.addEventListener('mouseleave',function(){ tipInPop=false; if(document.activeElement!==btn) tipClose(); });
  $('#app').appendChild(pop);
  btn.setAttribute('aria-expanded','true'); btn.setAttribute('aria-describedby','tip-live');
  tipOpen={btn:btn,pop:pop};
  // Above the ⓘ when it fits, else below; clamped to the viewport with a 12px margin.
  var r=btn.getBoundingClientRect(), w=pop.offsetWidth, h=pop.offsetHeight;
  var x=Math.min(Math.max(12, r.left+r.width/2-w/2), innerWidth-w-12);
  var y=r.top-h-8>=12 ? r.top-h-8 : Math.min(r.bottom+8, innerHeight-h-12);
  pop.style.left=x+'px'; pop.style.top=y+'px';
}
function tip(spec){
  var b=el('button','tip-btn',icon('info'));
  b.type='button'; b.setAttribute('aria-label',(spec.title||'What is this?')); b.setAttribute('aria-expanded','false');
  var hover=false;
  if(window.matchMedia&&matchMedia('(hover:hover) and (pointer:fine)').matches){
    b.addEventListener('mouseenter',function(){ hover=true; tipShow(b,spec); });
    // A short grace, so the pointer can cross the 8px gap to a link in the popover.
    b.addEventListener('mouseleave',function(){ hover=false;
      setTimeout(function(){ if(!hover&&!tipInPop&&document.activeElement!==b&&tipOpen&&tipOpen.btn===b) tipClose(); },150); });
  }
  b.addEventListener('focus',function(){ if(b.matches(':focus-visible')) tipShow(b,spec); });
  b.addEventListener('blur',function(){ if(!hover&&!tipInPop&&tipOpen&&tipOpen.btn===b) tipClose(); });
  // A click while hovering keeps it open; on touch it toggles.
  b.addEventListener('click',function(e){
    e.stopPropagation();
    if(tipOpen&&tipOpen.btn===b&&!hover) tipClose(); else tipShow(b,spec);
  });
  return b;
}
document.addEventListener('click',function(e){ if(tipOpen&&!tipOpen.pop.contains(e.target)) tipClose(); });
document.addEventListener('keydown',function(e){ if(e.key==='Escape') tipClose(); });
// A fixed popover would float away from its ⓘ on scroll; close it instead.
document.addEventListener('scroll',tipClose,true);

/* The screen table — the single list of what a screen name may be. Also what `go()`
 * validates against, so a retired name can't stick in the URL or in localStorage.
 * (Function declarations hoist, so naming them here at load time is safe.) */
var SCREEN_FNS={dashboard:renderDashboard,transactions:renderTransactions,accounts:renderAccounts,investments:renderInvestments,
                exchange:renderExchange,tax:renderTax,admin:renderAdmin};
var SECONDARY_SCREENS={investments:1,exchange:1,tax:1,admin:1};
/* Last screen, so a browser reload comes back where you were. The parent URL
 * (?screen=, pushed below) is the primary channel; localStorage covers reloads
 * that drop it — an iOS home-screen shortcut reopens its start_url, not the
 * current one. Best-effort: Safari can evict storage under pressure or in private
 * browsing, hence the try/catch. */
function lastScreen(){ try{ return localStorage.getItem('mm.screen')||null; }catch(e){ return null; } }
function openSheet(){ $('#sheetRoot').hidden=false; }
function closeSheet(){ $('#sheetRoot').hidden=true; }

function go(screen, fromHistory){
  // A retired screen name (a stale bookmark or a stored 'mm.screen' from before the
  // Review/Investments merge) becomes Dashboard here rather than at render time —
  // otherwise it would paint the Dashboard while leaving the nav blank and writing
  // the dead name straight back into localStorage.
  if(!SCREEN_FNS[screen]) screen='dashboard';
  S.screen=screen;
  document.querySelectorAll('.nav-item[data-screen]').forEach(function(b){b.classList.toggle('active', b.dataset.screen===screen);});
  $('#navMore').classList.toggle('active', !!SECONDARY_SCREENS[screen]);
  document.querySelectorAll('.sheet-item').forEach(function(b){b.classList.toggle('active', b.dataset.screen===screen);});
  closeSheet();
  try{ localStorage.setItem('mm.screen',screen); }catch(e){}
  if(!fromHistory) history.pushState(null,'','?screen='+encodeURIComponent(screen));
  render();
}

/* Bumped on every screen render; every async paint captures it and bails if it
 * moved (see cachedCall / needBoot). */
var screenGen=0;
/* Screens that can't paint without the bootstrap payload: show a skeleton, then
 * re-enter once it lands — unless the user has moved on. */
function needBoot(kind, fn){
  if(S.boot) return false;
  loading(kind); var gen=screenGen;
  ensureBoot().then(function(){ if(gen===screenGen) fn(); }).catch(showErr);
  return true;
}

/* ── render dispatcher ───────────────────────────────────────────────────── */
function render(){
  screenGen++;
  return (SCREEN_FNS[S.screen]||renderDashboard)();
}
// The .screen fade plays only when a DIFFERENT screen arrives. A repaint of the same
// screen (cache paint, then the revalidated data a moment later) swaps in place —
// replaying the fade there read as the page flashing twice on every launch.
function paint(node){
  var m=$('#main'), same=paint.on===S.screen, old=same?figTexts(m):null;
  if(same) node.style.animation='none';
  paint.on=S.screen; m.innerHTML=''; m.appendChild(node);
  if(old) rollFigs(figEls(node), old);
}
/* DESIGN.md "Motion": a figure that changes on a repaint (after a save, or when the
 * revalidated data lands) rolls to its new value over 400ms. Only when the text
 * around the number is the same, so "₱1,200" → "₱1,350" rolls and "—" → "₱0" snaps. */
var NUM_RE=/-?[\d,]*\d(\.\d+)?/;
function figEls(r){ return r.querySelectorAll('.fig,.fig-hero'); }
function figTexts(r){ return Array.prototype.map.call(figEls(r),function(e){ return e.textContent; }); }
function rollPlan(a,b){
  var ma=NUM_RE.exec(a), mb=NUM_RE.exec(b);
  if(a===b||!ma||!mb||a.replace(NUM_RE,'#')!==b.replace(NUM_RE,'#')) return null;
  var dec=(mb[1]||'').length?mb[1].length-1:0;
  return {from:+ma[0].replace(/,/g,''), to:+mb[0].replace(/,/g,''), dec:dec, text:function(v){
    return b.replace(NUM_RE,v.toLocaleString('en-PH',{minimumFractionDigits:dec,maximumFractionDigits:dec})); }};
}
function rollFigs(els, old){
  if(document.hidden||(window.matchMedia&&matchMedia('(prefers-reduced-motion:reduce)').matches)) return;
  Array.prototype.forEach.call(els,function(e,i){
    var p=old[i]!=null&&rollPlan(old[i],e.textContent); if(!p) return;
    var t0=performance.now(), end=e.textContent;
    // rAF stops in a hidden tab: the timer makes sure the real value always lands.
    setTimeout(function(){ e.textContent=end; },450);
    (function step(now){
      var k=Math.min(1,(now-t0)/400), ease=1-Math.pow(1-k,3);
      e.textContent=k<1?p.text(p.from+(p.to-p.from)*ease):end;
      if(k<1&&e.isConnected) requestAnimationFrame(step);
    })(t0);
  });
}

/* ── skeletons ───────────────────────────────────────────────────────────────
 * A placeholder shaped like the screen that's coming, instead of a spinner: the
 * layout doesn't jump when data lands, and the wait reads as progress. Built out
 * of the REAL .card/.stat/.grid/.litem boxes with shimmer bars inside, so the
 * shapes track the actual screens for free. */
function skBar(h,w){ return '<div class="skeleton" style="height:'+h+'px;width:'+w+'"></div>'; }
function skRows(n){
  var o='';
  for(var i=0;i<(n||5);i++) o+='<div class="litem">'+
    '<div class="skeleton" style="height:34px;width:34px;border-radius:10px;flex:none"></div>'+
    '<div class="grow">'+skBar(12,(50+(i%3)*14)+'%')+skBar(10,'30%')+'</div>'+skBar(14,'72px')+'</div>';
  return o;
}
function skTile(inner,cls){ return '<div class="tile'+(cls?' '+cls:'')+'">'+inner+'</div>'; }
function skFig(){ return skTile(skBar(11,'40%')+skBar(26,'62%')); }
var SKELS={
  dashboard:function(){ return '<div class="sum">'+skTile(skBar(11,'30%')+skBar(40,'58%')+skBar(10,'100%'),'t-nw')+
    skFig()+skFig()+skTile(skBar(11,'34%')+skBar(150,'100%'),'t-hist')+'</div>'; },
  accounts: function(){ return '<div class="sum">'+skFig()+skFig()+'</div><div style="height:12px"></div>'+skTile(skRows(4)); },
  list:     function(){ return skBar(46,'100%')+'<div style="height:12px"></div>'+skTile(skRows(7)); },
  table:    function(){ return skTile(skBar(11,'30%')+skRows(6)); }
};
function loading(kind){
  var f=SKELS[kind]||SKELS.table;
  paint.on=null;   // the real screen after a skeleton still fades in
  $('#main').innerHTML='<div class="screen">'+skBar(21,'34%')+'<div style="height:16px"></div>'+f()+'</div>';
}

/* ════════════════════════════════════════════════════════════════════════
 *  CHART HELPERS — inline SVG, no library. Specs: thin marks with a rounded
 *  data end, square baseline; hairline solid gridlines; text in ink tokens
 *  (never the series color); a legend for 2 series; hover tooltip on a hit
 *  band wider than the marks. Series colors are the validated --chart-* pair.
 * ════════════════════════════════════════════════════════════════════════ */
function svgEl(tag,attrs){
  var e=document.createElementNS('http://www.w3.org/2000/svg',tag);
  Object.keys(attrs||{}).forEach(function(k){e.setAttribute(k,attrs[k]);});
  return e;
}
// Axis labels: ₱1.2M / ₱45K / ₱450. Intl also keeps a 2500 tick as "₱2.5K"
// (the old hand-rolled rounding rendered it "₱3K").
var PHPC = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',notation:'compact',maximumFractionDigits:1});
function compactPhp(n){ return PHPC.format(Number(n)); }
// Column rounded at the top (the data end), square at the baseline.
function barPath(x,y,w,h,r){
  r=Math.min(r==null?4:r,w/2,h);
  return 'M'+x+' '+(y+h)+' V'+(y+r)+' Q'+x+' '+y+' '+(x+r)+' '+y+' H'+(x+w-r)+
         ' Q'+(x+w)+' '+y+' '+(x+w)+' '+(y+r)+' V'+(y+h)+' Z';
}
// A per-month net-worth series. Prefers the REAL monthly snapshot (`snaps[month]`,
// from nw_snapshots — captures FX/market moves); where a month has none yet it
// estimates and flags `real:false`. Live month always uses `current`.
//   roll=true  (liquid/cash): estimate a gap by rolling the value backward through
//              that month's savings (income − expense) — cash flow is what moves it.
//   roll=false (invested):    hold the nearest known value flat — the market moves
//              it, and cash flow does not, so a savings roll-back would be wrong.
function netWorthSeries(cf,current,snaps,roll){
  snaps=snaps||{}; if(roll===undefined)roll=true;
  var out=new Array(cf.length), nw=current;
  for(var i=cf.length-1;i>=0;i--){
    var real=i<cf.length-1 && snaps[cf[i].month]!=null;
    if(real) nw=snaps[cf[i].month];
    out[i]={month:cf[i].month,nw:nw,real:real||i===cf.length-1};
    if(roll) nw-=(cf[i].income-cf[i].expense);
  }
  return out;
}
// Months to skip between x-axis labels so a 24-month window does not smear them
// into each other. ~34px is a 3-letter month plus air.
function labelStep(n,pw){ return Math.ceil(n/Math.max(1,Math.floor(pw/34))); }

/* ════════════════════════════════════════════════════════════════════════
 *  SUMMARY (screen key `dashboard`) — the v3 tile grid (DESIGN.md "Layout").
 *  4 columns on PC, 2 on iPad, 1 on iPhone; the spans live in app.css (.sum).
 *  Every derived figure carries a tip() with its real formula (DESIGN.md tooltips).
 * ════════════════════════════════════════════════════════════════════════ */

/* The FI countdown, short: "10y 1m". Rounded to WHOLE MONTHS first and split after,
 * so 11.6 months reads "1y 0m" and not "0y 12m". 365.2425 is the same Gregorian
 * mean the Worker projects with. The payload keeps the exact day count. */
function yearsMonths(days){
  var mo=Math.round(days/(365.2425/12));
  if(mo<1) return 'Under a month';
  var y=Math.floor(mo/12); mo-=y*12;
  return (y?y+'y ':'')+mo+'m';
}
function monthLong(m){ var d=monthKey2date(m); return d?d.toLocaleString('en-US',{month:'long'}):String(m); }
function isoMonthLabel(iso){ return MONTHS[+iso.slice(5,7)-1]+' '+iso.slice(0,4); }   // "2036-10-04" → "Oct 2036"
var SEG_COLOR={Essentials:'var(--ess)',Rewards:'var(--rew)',Growth:'var(--gro)'};

// A tile with its label row: label, optional right-hand text, optional ⓘ.
function sumTile(cls,label,right,tipSpec){
  var t=el('section','tile '+cls), h=el('div','tile-h');
  h.appendChild(typeof label==='string'?el('span','tile-l',esc(label)):label);
  if(right) h.appendChild(el('span','tile-r',right));
  if(tipSpec) h.appendChild(tip(tipSpec));
  t.appendChild(h); return t;
}
// A 6px meter on --track: fills = [[fraction, colour]], tick = a target fraction.
function bar6(fills,tick){
  var b=el('div','bar6');
  fills.forEach(function(f){ var i=el('i'); i.style.width=Math.max(0,Math.min(100,f[0]*100))+'%'; i.style.background=f[1]; b.appendChild(i); });
  if(tick!=null){ var k=el('b'); k.style.left='calc('+(tick*100)+'% - 1px)'; b.appendChild(k); }
  return b;
}

/* The two history series (liquid, invested) that the net-worth sparkline and the
 * history tile both draw. netWorthSeries rolls the flows BACKWARD from the newest
 * month, so that month needs a real anchor: the live figures on the live month,
 * and the month's own snapshot on a past one (netWorthHistory carries every month
 * but the live one). */
function nwSeries(d,cf,isLive){
  if(cf.length<2) return null;
  var nwh=d.netWorthHistory||{}, sh=d.sharesHistory||{}, liqHist={}, lastM=cf[cf.length-1].month;
  Object.keys(nwh).forEach(function(m){ liqHist[m]=nwh[m]-(sh[m]||0); });
  var anchorNw=isLive?(d.netWorth||0):nwh[lastM], anchorSh=isLive?(d.sharesValue||0):sh[lastM];
  if(anchorNw==null) return null;
  return {liq:netWorthSeries(cf, anchorNw-(anchorSh||0), liqHist, true),
          stk:netWorthSeries(cf, anchorSh||0, sh, false)};
}

function nwTile(d,ser){
  var br=d.bridge, liabAbs=Math.abs(d.liabilities||0);
  var tipSpec=br?{
    title:'What moved your net worth',
    text:'The change since the '+monthLabel(br.from)+' close, split into what the ledger explains and what it does not.',
    rows:[['Net worth at the '+monthLabel(br.from)+' close',money(br.startNetWorth,true)],
          ['+ Saved (income − spending)',signedMoney(br.savings)],
          ['+ Market, FX and timing',signedMoney(br.residual)],
          ['= Net worth '+(br.live?'now':'at the '+monthLabel(br.month)+' close'),money(br.endNetWorth,true),true],
          ['Change',signedMoney(br.deltaNetWorth),true]],
    note:'Market, FX and timing is the rest: price and rate moves, and a flow logged in another month. If it stays negative, some spending may not be logged.'}:null;
  var t=sumTile('t-nw','Net worth','<span class="hide-phone">Assets '+money(d.assets,true)+' · Liabilities −'+money(liabAbs,true)+'</span>',tipSpec);
  t.appendChild(el('div','fig-hero',money(d.netWorth,true)));
  if(br){
    var up=br.deltaNetWorth>=0, row=el('div','nw-bridge');
    row.innerHTML='<span class="nw-chip '+(up?'pos':'neg')+'">'+(up?'▲ ':'▼ ')+money(Math.abs(br.deltaNetWorth),true)+
      (br.live?' since '+esc(monthLong(br.from)):' in '+esc(monthLong(br.month)))+'</span><span class="hide-phone">Saved '+signedMoney(br.savings)+
      ' · Market, FX and timing '+signedMoney(br.residual)+'</span>';
    t.appendChild(row);
  }
  // Sparkline: total net worth per month. preserveAspectRatio=none with a
  // non-scaling stroke, so it fills any width with no measuring and no redraw.
  if(ser){
    var v=ser.liq.map(function(p,i){ return p.nw+Math.max(0,ser.stk[i].nw); });
    var hi=Math.max.apply(null,v), lo=Math.min.apply(null,v); if(hi===lo){ hi+=1; lo-=1; }
    var n=v.length, pts=v.map(function(x,i){ return (i*350/(n-1)).toFixed(1)+','+(6+(hi-x)/(hi-lo)*44).toFixed(1); });
    var svg=svgEl('svg',{class:'nw-spark',viewBox:'0 0 350 56',preserveAspectRatio:'none','aria-hidden':'true'});
    svg.appendChild(svgEl('path',{d:'M'+pts.join(' L')+' L350,56 L0,56 Z',fill:'var(--accent)','fill-opacity':.16}));
    svg.appendChild(svgEl('path',{d:'M'+pts.join(' L'),fill:'none',stroke:'var(--accent)','stroke-width':2.2,'vector-effect':'non-scaling-stroke'}));
    t.appendChild(svg);
  } else t.classList.add('pad-b');
  return t;
}

// Days left in the month, TODAY INCLUDED: it can still be spent, so the last day is 1, not 0.
function daysLeftIn(now){ return new Date(now.getFullYear(),now.getMonth()+1,0).getDate()-now.getDate()+1; }
/* Left to spend: the Essentials + Rewards budget minus their signed spend. The
 * other segments (Growth) are money kept, not spent, so they sit below as rows. */
function leftTile(d,isLive){
  var er=d.essentialsRewards; if(!er||er.targetPhp==null) return null;
  var daysLeft=isLive?daysLeftIn(new Date()):null;
  var left=er.remainingPhp, perDay=daysLeft>0&&left>0?left/daysLeft:null;
  var inWhat=isLive?'this month':'in '+monthLabel(S.month);
  var rows=[['Essentials + Rewards budget',money(er.targetPhp,true)],['− Spent '+inWhat,money(er.actualPhp,true)],
            ['= Left to spend',money(left,true),true]];
  if(perDay!=null) rows.push(['÷ Days left',String(daysLeft)],['= A day',money(perDay,true),true]);
  var t=sumTile('t-lts','Left to spend',daysLeft!=null?daysLeft+' day'+(daysLeft===1?'':'s')+' left':esc(monthLabel(S.month)),
    {title:'What you can still spend '+inWhat,text:'Your Essentials and Rewards budgets, less what they spent.',rows:rows,
     note:'Spend is signed, so a refund nets its category down. Growth is money you keep, so it is not in this figure.'});
  var fig=el('div','fig-row');
  fig.innerHTML='<span class="fig'+(left<0?' neg':'')+'">'+(left<0?money(-left,true)+' over':money(left,true))+'</span>'+
    '<span class="fig-sub">of '+money(er.targetPhp,true)+'</span>';
  t.appendChild(fig);
  var byName={}; (d.budgets||[]).forEach(function(b){ byName[b.segment]=b; });
  t.appendChild(bar6(er.segments.map(function(s){
    return [er.targetPhp?((byName[s]||{}).actualPhp||0)/er.targetPhp:0, SEG_COLOR[s]||'var(--dim)'];
  })));
  if(perDay!=null) t.appendChild(el('div','lts-day','About <b>'+money(perDay,true)+' a day</b> keeps you on budget.'));
  var list=el('div','seg-rows');
  (d.budgets||[]).forEach(function(b){
    var cur=b.currency||'PHP', fmt=function(n){ return cur==='PHP'?money(n,true):moneyCur(n,cur); };
    var spend=er.segments.indexOf(b.segment)>=0, rem=b.remainingNative, val, cls='';
    if(rem==null) val='—';
    else if(spend){ val=rem>=0?fmt(rem)+' left':fmt(-rem)+' over'; if(rem<0) cls='neg'; }
    else { val=rem<=0?'Funded ✓':fmt(rem)+' to go'; if(rem<=0) cls='pos'; }
    var r=el('div','seg-row');
    r.innerHTML='<span class="seg-dot" style="background:'+(SEG_COLOR[b.segment]||'var(--dim)')+'"></span>'+
      '<span class="seg-name">'+esc(b.segment)+(/^month/i.test(b.period)?'':' <span class="dim">· '+esc(String(b.period).toLowerCase())+'</span>')+'</span>'+
      '<span class="seg-val '+cls+'">'+val+'</span>'+
      '<span class="seg-sub">'+fmt(b.actualNative)+' of '+(b.targetNative==null?'—':fmt(b.targetNative))+'</span>';
    list.appendChild(r);
  });
  t.appendChild(list);
  return t;
}

function twoLabels(long,short){ return el('span','tile-l','<span class="lg-long">'+long+'</span><span class="lg-short">'+short+'</span>'); }

function fireTile(f){
  var lead=f.days==null?'Not on this path':(f.days<=0?'Reached':yearsMonths(f.days));
  var when=f.date?isoMonthLabel(f.date):null;
  var t=sumTile('t-fire',twoLabels('Financially free in','Free in'),null,{
    title:'When your savings can pay for your life',
    text:'Net worth grows by your savings and a real return, until it reaches 25 times a year of spending (the '+f.withdrawalRatePct+'% rule).',
    rows:[['Average monthly spend',money(f.monthlyExpensePhp,true)],['× 12 × 25 = Target',money(f.targetPhp,true),true],
          ['Net worth at the last close, less money lent',money(f.netWorthPhp,true)],['= Progress',f.progressPct+'%',true],
          ['Average monthly savings',money(f.monthlySavingsPhp,true)],['Real return',f.realReturnPct+'% a year'],
          ['= Free in',lead+(when?' ('+when+')':''),true]],
    note:'Averages use the last 3 closed months. The date moves only at a month close, so the countdown falls by one day each day.'});
  t.appendChild(el('div','fig',esc(lead)));
  t.appendChild(bar6([[(f.progressPct||0)/100,'var(--pos)']]));
  t.appendChild(el('div','tile-foot',f.days==null
    ?'Saving '+money(f.monthlySavingsPhp,true)+' a month does not reach '+money(f.targetPhp,true)
    :'<span class="hide-phone">'+money(f.netWorthPhp,true)+' of '+compactPhp(f.targetPhp)+(when?' · ':'')+'</span>'+(when?'On track for '+when:'')));
  return t;
}

/* Emergency runway, from getInvestments (the Accounts card's payload, shared cache).
 * The meter runs to 1.5 × the target, so the target tick sits at two thirds. */
function fillRunway(t,rw){
  t.innerHTML='';
  var p=rw&&rw.parts, rows=[];
  if(p){
    rows.push(['Cash accounts',money(p.cashPhp,true)]);
    if(p.efSharesPhp) rows.push(['+ Emergency fund shares',money(p.efSharesPhp,true)]);
    rows.push(['− Credit you owe',money(-p.creditPhp,true)]);
    if(p.owedPhp) rows.push(['− Money you owe (receivable)',money(-p.owedPhp,true)]);
  }
  if(rw){
    rows.push(['= Reachable cash',money(rw.efPhp,true),true],['÷ Average monthly spend',money(rw.avgMonthlyExpensePhp,true)],
              ['= Runway',rw.months==null?'—':rw.months+' months',true]);
  }
  var h=sumTile('',twoLabels('Emergency runway','Runway'),null,rw?{title:'How long your cash lasts',
    text:'Money you can reach in a few days, divided by what you usually spend in a month.',rows:rows,
    note:'Money you lent is left out, because you cannot reach it. Money you owe through a receivable comes off. Average spend uses the last 3 closed months.'}:null).firstChild;
  t.appendChild(h);
  if(!rw||rw.months==null){ t.appendChild(el('div','fig','—')); t.appendChild(el('div','tile-foot',rw?'No spending in the last 3 closed months':'Loading…')); return; }
  var tm=rw.targetMonths, sev=rw.months>=tm?'pos':(rw.months>=tm/2?'warn':'neg');
  t.appendChild(el('div','fig',rw.months+' months'));
  t.appendChild(bar6([[rw.months/(tm*1.5),'var(--'+sev+')']],2/3));
  t.appendChild(el('div','tile-foot','<span class="hide-phone">'+money(rw.efPhp,true)+' · </span>Target '+tm+' months'));
}

/* The history tile's two charts on ONE month axis: the same x per month, so a
 * month is one column through both (DESIGN.md "Charts"). Pure of the page: it
 * returns the two SVGs and the geometry, so test.js can read it. */
function historyCharts(cf,liq,stk,isLive,W){
  // A point scale, not equal columns: the first and last months sit at the edges,
  // inset only by the width of a bar pair, so the lines use the whole tile.
  var n=cf.length, gap=n>1?W/n:W, bw=Math.min(18,gap*0.22), pad=bw+3;
  var step=n>1?(W-2*pad)/(n-1):0, cx=cf.map(function(m,i){ return n>1?pad+step*i:W/2; });
  var shr=stk.map(function(p){ return Math.max(0,p.nw); }), tot=liq.map(function(p,i){ return p.nw+shr[i]; });
  // Net worth: invested is the base band 0→shares, liquid a signed ribbon on top,
  // so the top edge is the real total. The domain keeps zero in range: a month with
  // a NEGATIVE net worth must draw below a marked zero, never read as positive.
  var H1=140, T=8, B=4, hi=Math.max.apply(null,tot.concat(shr).concat([1]))*1.08, lo=Math.min(0,Math.min.apply(null,tot));
  var y=function(v){ return T+(hi-v)/(hi-lo)*(H1-T-B); };
  var s1=svgEl('svg',{class:'hist-svg',viewBox:'0 0 '+W+' '+H1,'aria-hidden':'true'});
  cx.forEach(function(x){ s1.appendChild(svgEl('line',{x1:x,y1:0,x2:x,y2:H1,stroke:'var(--track)','stroke-width':1})); });
  var y0=y(0), fwd=function(a){ return cx.map(function(x,i){ return x+','+y(a[i]); }).join(' '); };
  s1.appendChild(svgEl('polygon',{points:cx[0]+','+y0+' '+fwd(shr)+' '+cx[n-1]+','+y0,fill:'var(--gro)','fill-opacity':.45}));
  s1.appendChild(svgEl('polygon',{points:fwd(shr)+' '+cx.slice().reverse().map(function(x,j){ return x+','+y(tot[n-1-j]); }).join(' '),
    fill:'var(--accent)','fill-opacity':.3}));
  if(lo<0) s1.appendChild(svgEl('line',{x1:0,y1:y0,x2:W,y2:y0,stroke:'var(--dim)','stroke-width':1,'stroke-dasharray':'3 3'}));
  s1.appendChild(svgEl('polyline',{points:fwd(shr),fill:'none',stroke:'var(--gro)','stroke-width':1.5,'stroke-linejoin':'round'}));
  s1.appendChild(svgEl('polyline',{points:fwd(tot),fill:'none',stroke:'var(--accent)','stroke-width':2.2,'stroke-linejoin':'round','stroke-linecap':'round'}));
  // An estimated month (no snapshot, rolled back through cash flow) is a hollow ring.
  liq.forEach(function(p,i){ if(!p.real) s1.appendChild(svgEl('circle',{cx:cx[i],cy:y(tot[i]),r:3,fill:'var(--card)',stroke:'var(--accent)','stroke-width':1.5})); });
  // Cash flow: in left, out right (position is the second channel after colour).
  var H2=110, T2=6, max=1; cf.forEach(function(m){ max=Math.max(max,m.income,m.expense); });
  var s2=svgEl('svg',{class:'hist-svg',viewBox:'0 0 '+W+' '+H2,'aria-hidden':'true'});
  cx.forEach(function(x){ s2.appendChild(svgEl('line',{x1:x,y1:0,x2:x,y2:H2,stroke:'var(--track)','stroke-width':1})); });
  cf.forEach(function(m,i){
    var op=isLive&&i===n-1?.5:1, hI=m.income/max*(H2-T2), hO=m.expense/max*(H2-T2);
    if(hI>=1) s2.appendChild(svgEl('path',{d:barPath(cx[i]-bw-2,H2-hI,bw,hI,3),fill:'var(--chart-in)','fill-opacity':op}));
    if(hO>=1) s2.appendChild(svgEl('path',{d:barPath(cx[i]+2,H2-hO,bw,hO,3),fill:'var(--chart-out)','fill-opacity':op}));
  });
  return {nw:s1, cf:s2, cx:cx, step:step, pad:pad, bw:bw, y0:y0, yTot:tot.map(y), tot:tot, shr:shr};
}

var histHide=null;   // the open inspect line: one history tile exists, so one document listener
document.addEventListener('pointerdown',function(e){ if(histHide&&!(e.target.closest&&e.target.closest('.hist-plot'))) histHide(); });

function historyTile(cf,ser,isLive){
  var n=cf.length, lbl=n===6?'Last 6 months':(n===12?'Last year':'Last '+n+' months');
  var t=sumTile('t-hist',lbl);
  var seg=el('div','seg');
  [[6,'6M'],[12,'1Y'],[24,'2Y']].forEach(function(o){
    var b=el('button',o[0]===S.cfMonths?'on':'',o[1]); b.type='button'; b.setAttribute('aria-pressed',o[0]===S.cfMonths);
    b.onclick=function(){ if(S.cfMonths===o[0]) return; S.cfMonths=o[0]; prefSet('cfMonths',o[0]); render(); };
    seg.appendChild(b);
  });
  t.firstChild.appendChild(seg);
  var key=function(c,l){ return '<span class="lg"><span class="lg-key" style="background:'+c+'"></span>'+l+'</span>'; };
  var plot=el('div','hist-plot');
  plot.appendChild(el('div','hist-lg','<b>Net worth</b>'+key('var(--accent)','Liquid')+key('var(--gro)','Invested')));
  var h1=el('div'); plot.appendChild(h1);
  plot.appendChild(el('div','hist-lg','<b>Cash flow</b>'+key('var(--chart-in)','In')+key('var(--chart-out)','Out')));
  var h2=el('div'); plot.appendChild(h2);
  var line=el('div','hist-line'), tipBox=el('div','hist-tip'), hit=el('div','hist-hit');
  line.hidden=tipBox.hidden=true;
  hit.tabIndex=0; hit.setAttribute('role','img');
  hit.setAttribute('aria-label','Net worth and cash flow by month. Use the arrow keys to read a month.');
  plot.appendChild(line); plot.appendChild(tipBox); plot.appendChild(hit);
  t.appendChild(plot);
  var labels=el('div','hist-x');
  t.appendChild(labels);
  var cur=-1, g=null;
  function show(i){
    if(!g) return;
    cur=i=Math.max(0,Math.min(n-1,i));
    var m=cf[i], L=ser.liq[i], W=plot.clientWidth, px=g.cx[i]/g.W*W;
    line.style.left=px+'px'; line.hidden=false;
    var r=function(c,k,v){ return '<span>'+(c?'<span class="lg-key" style="background:'+c+'"></span>':'')+k+'</span><b>'+v+'</b>'; };
    tipBox.innerHTML='<div class="hist-tip-t">'+esc(monthLabel(m.month))+(isLive&&i===n-1?' so far':'')+'</div><div class="hist-tip-rows">'+
      r('var(--accent)','Liquid',money(L.nw,true))+r('var(--gro)','Invested',money(g.shr[i],true))+
      r('','Net worth',money(g.tot[i],true)+(L.real?'':' <span class="est">est.</span>'))+
      r('var(--chart-in)','In',money(m.income,true))+r('var(--chart-out)','Out',money(m.expense,true))+
      r('','Saved',signedMoney(m.income-m.expense))+'</div>';
    tipBox.hidden=false;
    var tw=tipBox.offsetWidth;
    tipBox.style.left=(px-tw-12>=0?px-tw-12:Math.min(px+12,W-tw))+'px';
    histHide=hide;
  }
  function hide(){ line.hidden=tipBox.hidden=true; cur=-1; histHide=null; }
  // The nearest month to the pointer, on the chart's own point scale.
  function at(e){ if(!g) return 0; var b=hit.getBoundingClientRect(), x=(e.clientX-b.left)/b.width*g.W; return g.step?Math.round((x-g.pad)/g.step):0; }
  hit.addEventListener('pointermove',function(e){ if(e.pointerType==='mouse') show(at(e)); });
  hit.addEventListener('pointerleave',function(e){ if(e.pointerType==='mouse') hide(); });
  hit.addEventListener('click',function(e){ show(at(e)); });   // touch and pen: a tap
  hit.addEventListener('keydown',function(e){
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ e.preventDefault(); show(cur<0?n-1:cur+(e.key==='ArrowLeft'?-1:1)); }
    else if(e.key==='Escape') hide();
  });
  hit.addEventListener('blur',hide);
  // Drawn at the host's real width, after mount (the skill's rAF chart rule).
  requestAnimationFrame(function(){
    if(!plot.isConnected) return;
    var W=Math.max(240,h1.clientWidth);
    g=historyCharts(cf,ser.liq,ser.stk,isLive,W); g.W=W;
    h1.appendChild(g.nw); h2.appendChild(g.cf);
    // Labels sit on the same x as the points. The end ones align to the bar pair's
    // outer edge, so "Sep so far" never spills out of the tile.
    var ls=labelStep(n,W);
    cf.forEach(function(m,i){
      var last=i===n-1, first=i===0&&n>1;
      // A narrow step: the wide "so far" label would cover the label before it.
      if((n-1-i)%ls!==0||(isLive&&g.step<60&&i===n-1-ls)) return;
      var s=el('span',last?'on':'',esc(String(m.month).split('-')[1])+(last&&isLive?' so far':''));
      if(last&&n>1){ s.style.right=((W-g.cx[i]-g.bw-2)/W*100)+'%'; }
      else if(first){ s.style.left=((g.cx[i]-g.bw-2)/W*100)+'%'; }
      else { s.style.left=(g.cx[i]/W*100)+'%'; s.style.transform='translateX(-50%)'; }
      labels.appendChild(s);
    });
  });
  return t;
}

function catTile(d){
  var sc=d.spendByCategory||{}, total=0;
  var cats=Object.keys(sc).map(function(k){ total+=sc[k]; return [k,sc[k]]; })
    .filter(function(p){ return p[1]>0; }).sort(function(a,b){ return b[1]-a[1]; });
  if(!cats.length) return null;
  // One part-to-whole bar (HIG: bar marks for proportions, a gap between
  // adjacent colours), coloured by segment, then the rows as its legend. Top 5,
  // the tail folded into "Other", which opens in place to list what it holds.
  // A category that nets to zero or below (refunds) has no slice, but still
  // counts in the total; shares are of the positive sum, so the slices add to 100%.
  var top=cats.slice(0,5), rest=cats.slice(5), pos=0;
  cats.forEach(function(p){ pos+=p[1]; });
  if(rest.length) top.push(['Other ('+rest.length+')',rest.reduce(function(s,p){ return s+p[1]; },0),true]);
  var bc=(S.boot&&S.boot.categories)||{};
  function col(p){ return p[2]?'var(--dim)':SEG_COLOR[bc[p[0]]&&bc[p[0]].Segment]||'var(--dim)'; }
  function pct(v){ var x=v/pos*100; return (x<1?'<1':Math.round(x))+'%'; }
  function row(p,cls){
    var r=el(p[2]?'button':'div','cat-row'+(cls?' '+cls:''));
    r.innerHTML='<span class="seg-dot" style="background:'+col(p)+'"></span><span class="cat-name"><span>'+esc(p[0])+'</span>'+
      (p[2]?' '+icon('chevron'):'')+'</span><span class="cat-pct">'+pct(p[1])+'</span><span class="cat-val">'+money(p[1],true)+'</span>';
    return r;
  }
  var t=sumTile('t-cats','Spending by category','<b>'+money(total,true)+'</b>');
  var bar=bar6(top.map(function(p){ return [p[1]/pos,col(p)]; }));
  bar.classList.add('cat-bar'); bar.setAttribute('role','img');
  bar.setAttribute('aria-label',top.map(function(p){ return p[0]+' '+pct(p[1]); }).join(', '));
  t.appendChild(bar);
  top.forEach(function(p){
    var r=row(p); t.appendChild(r);
    if(!p[2]) return;
    var sub=el('div','cat-sub'); rest.forEach(function(q){ sub.appendChild(row(q)); });
    r.type='button'; t.appendChild(sub);
    function set(open){ S.catOpen=open; r.setAttribute('aria-expanded',open); sub.hidden=!open; }
    set(!!S.catOpen);
    r.onclick=function(){ set(!S.catOpen); };
  });
  return t;
}

function recentTile(d){
  var more=el('button','link-btn','See all'); more.type='button'; more.onclick=function(){ go('transactions'); };
  var t=sumTile('t-recent','Recent'); t.firstChild.appendChild(more);
  var rl=el('div','list'), rows=(d.recentTransactions||[]).slice(0,5);
  rows.forEach(function(x){ rl.appendChild(txRow(x,{clickable:true})); });
  if(!rows.length) rl.appendChild(el('div','empty','No transactions yet.'));
  t.appendChild(rl);
  return t;
}

function renderDashboard(){
  var key='dashboard|'+S.month+'|'+S.cfMonths;
  if(!S.cache[key]) loading('dashboard');
  return cachedCall(key, function(et){return gs('api_getDashboard',{month:S.month,months:S.cfMonths},et);}, function(d){
    var w=el('div','screen');
    var head=el('div','screen-head');
    head.appendChild(el('div','screen-title','Summary'));
    head.appendChild(monthPickerEl());
    w.appendChild(head);
    var g=el('div','sum'); w.appendChild(g);
    var cf=d.cashflow||[], isLive=S.month===monthKey(new Date()), ser=nwSeries(d,cf,isLive);
    g.appendChild(nwTile(d,ser));
    var lt=leftTile(d,isLive); if(lt) g.appendChild(lt);
    var pair=el('div','t-pair'), rw=el('section','tile t-rw');
    if(d.fire) pair.appendChild(fireTile(d.fire));
    pair.appendChild(rw); fillRunway(rw,null);
    g.appendChild(pair);
    if(ser) g.appendChild(historyTile(cf,ser,isLive));
    var ct=catTile(d); if(ct) g.appendChild(ct);
    g.appendChild(recentTile(d));
    paint(w);
    // Runway rides the Accounts screen's payload (no new route) and fills in when it lands.
    cachedCall('investments', function(et){return gs('api_getInvestments',null,et);}, function(inv){
      if(rw.isConnected) fillRunway(rw,inv.runway);
    }).catch(function(){ var f=rw.querySelector('.tile-foot'); if(f) f.textContent='Not available offline'; });
  }).catch(showErr);
}


/* ════════════════════════════════════════════════════════════════════════
 *  ACTIVITY (screen key `transactions`). One filter object, S.tx.filters, drawn as
 *  tokens in a search field. Browse by default; Select mode adds checkboxes, the
 *  floating bulk bar and the inline single-field editors. From 1200px: a filter
 *  pane and a table. Below: a list grouped by day and a Filters sheet.
 * ════════════════════════════════════════════════════════════════════════ */
var TX_KEYS=['month','date','type','category','segment','account','source','minAmount','maxAmount','search'];
var TOKEN_LABEL={month:'Month',date:'Date',type:'Type',category:'Category',segment:'Segment',account:'Account',
  source:'Source',minAmount:'Amount',maxAmount:'Amount',search:'Text'};
var TYPE_WORD={Expense:'Spent',Income:'Earned',Transfer:'Moved'};
var SOURCES={tg:'Telegram',gm:'Gmail',ui:'App',interest:'Interest',legacy:'Legacy'};
var SOURCE_WORDS={tg:['telegram','bot'],gm:['gmail','email','mail'],ui:['app'],interest:['interest'],legacy:['legacy','sheet']};
var WIDE_MQ=window.matchMedia?matchMedia('(min-width:1200px)'):null;
function txWide(){ return !!(WIDE_MQ&&WIDE_MQ.matches); }
if(WIDE_MQ&&WIDE_MQ.addEventListener) WIDE_MQ.addEventListener('change',function(){ if(S.screen==='transactions') renderTransactions(); });

// The tokens a filter object shows, in field order. month '' = "all months": no token.
function activeTokens(f){
  return TX_KEYS.filter(function(k){ return f[k]!=null&&f[k]!==''; }).map(function(k){ return {k:k,v:String(f[k])}; });
}
function tokenText(k,v){
  if(k==='month'){ var d=monthKey2date(v); return d?MONTHS_FULL[d.getMonth()]+' '+d.getFullYear():String(v); }
  if(k==='date') return dayMonth(v,{year:'always'});
  if(k==='type') return TYPE_WORD[v]||v;
  if(k==='source') return SOURCES[v]||v;
  if(k==='minAmount') return '≥ '+money(v,true);
  if(k==='maxAmount') return '≤ '+money(v,true);
  if(k==='search') return '“'+v+'”';
  return String(v);
}
function amountOf(s){
  var m=/^₱?\s*(\d[\d,]*\.?\d*|\.\d+)\s*(k)?$/i.exec(String(s).trim()); if(!m) return null;
  var n=parseFloat(m[1].replace(/,/g,'')); return isNaN(n)?null:(m[2]?n*1000:n);
}
// "aug", "august 2025", "2025-aug", "this month" → "2025-Aug". A bare month name is
// the latest one not in the future.
function monthFromText(lo, now){
  if(lo.length>=4&&'this month'.indexOf(lo)===0) return monthKey(now);
  if(lo.length>=4&&'last month'.indexOf(lo)===0) return monthKey(new Date(now.getFullYear(),now.getMonth()-1,1));
  var m=/^(?:(\d{4})[\s-]*)?([a-z]{3,})(?:[\s-]*(\d{4}))?$/.exec(lo); if(!m) return null;
  for(var i=0;i<12;i++) if(MONTHS_FULL[i].toLowerCase().indexOf(m[2])===0) break;
  if(i===12) return null;
  var y=+(m[1]||m[3])||(i<=now.getMonth()?now.getFullYear():now.getFullYear()-1);
  return y+'-'+MONTHS[i];
}
// "sep 17", "17 september", "sep 17 2025", "9/17", "9/17/2025" → "2026-09-17".
// No year = the latest one not in the future.
function dateFromText(lo, now){
  var m=/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(lo), mo, d, y;
  if(m){ mo=+m[1]-1; d=+m[2]; y=m[3]; }
  else {
    m=/^([a-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(lo);
    var r=/^(\d{1,2})\s+([a-z]{3,})\.?(?:,?\s+(\d{4}))?$/.exec(lo);
    if(!m&&r) m=[r[0],r[2],r[1],r[3]];
    if(!m) return null;
    for(mo=0;mo<12;mo++) if(MONTHS_FULL[mo].toLowerCase().indexOf(m[1])===0) break;
    d=+m[2]; y=m[3];
  }
  if(!(mo>=0&&mo<12)||d<1) return null;
  if(!y){ y=now.getFullYear(); if(new Date(y,mo,d)>now) y--; }
  var dt=new Date(+y,mo,d);
  return dt.getMonth()===mo?isoDate(dt):null;
}
/* The token grammar: what the typed text could mean, best guess first. The field's
 * dropdown shows these; Enter takes the first. ctx = {categories, accounts, segments, now}.
 *   "exact words" → Text only · >500 ≥500 <1k ≤300 → Amount only · 2026-09-18 → Date only
 *   sep 17, 17 sep, 9/17 → Date first, then Text
 *   otherwise any of: Month, Type (spent/earned/moved), Source (gmail, telegram…),
 *   Segment, Amount (a bare number = at least), the 3 best Category and Account
 *   matches, and always Text contains. */
function parseTokens(text, ctx){
  var q=String(text||'').trim(), lo=q.toLowerCase(), out=[];
  if(!q) return out;
  var quoted=/^"([^"]+)"?$/.exec(q);
  if(quoted) return [{k:'search',v:quoted[1]}];
  var cmp=/^(>=|<=|>|<|≥|≤)\s*(.+)$/.exec(q), n=cmp?amountOf(cmp[2]):null;
  if(n!=null) return [{k:/[>≥]/.test(cmp[1])?'minAmount':'maxAmount',v:String(n)}];
  if(/^\d{4}-\d{2}-\d{2}$/.test(q)) return [{k:'date',v:q}];
  var dd=dateFromText(lo, ctx.now||new Date()); if(dd) out.push({k:'date',v:dd});
  var mk=monthFromText(lo, ctx.now||new Date()); if(mk) out.push({k:'month',v:mk});
  function starts(words){ return lo.length>=2&&words.some(function(w){ return w.indexOf(lo)===0; }); }
  if(starts(['spent','expense','expenses'])) out.push({k:'type',v:'Expense'});
  if(starts(['earned','income'])) out.push({k:'type',v:'Income'});
  if(starts(['moved','transfer','transfers'])) out.push({k:'type',v:'Transfer'});
  Object.keys(SOURCE_WORDS).forEach(function(s){ if(starts(SOURCE_WORDS[s])) out.push({k:'source',v:s}); });
  (ctx.segments||[]).forEach(function(s){ if(starts([s.toLowerCase()])) out.push({k:'segment',v:s}); });
  n=amountOf(q); if(n!=null) out.push({k:'minAmount',v:String(n)});
  function best(k,list){
    list.map(function(s){ return {s:s,sc:fuzzyScore(q,s)}; }).filter(function(x){ return x.sc>=0; })
      .sort(function(a,b){ return b.sc-a.sc; }).slice(0,3).forEach(function(x){ out.push({k:k,v:x.s}); });
  }
  best('category',ctx.categories||[]); best('account',ctx.accounts||[]);
  out.push({k:'search',v:q});
  return out;
}
function tokenCtx(){
  var c=(S.boot&&S.boot.categories)||{}, segs={};
  Object.keys(c).forEach(function(k){ if(c[k].Segment) segs[c[k].Segment]=1; });
  return {categories:Object.keys(c).sort(), accounts:acctOptions().map(function(o){ return o.value; }),
          segments:Object.keys(segs), now:new Date()};
}

// One filter in or out. A day and a month are two ways to say one thing, so each
// clears the other (a date outside the month would return nothing).
function setTxFilter(k,v,refocus){
  var f=S.tx.filters;
  if(v===''||v==null){ if(k==='month') f.month=''; else delete f[k]; }
  else { f[k]=String(v); if(k==='date') f.month=''; if(k==='month') delete f.date; }
  S.tx.offset=0; clearSel(); renderTransactions();
  if(refocus){ var i=$('#tokInput'); if(i) i.focus(); }
}
function setTxFilters(f){ S.tx.filters=f; S.tx.offset=0; clearSel(); renderTransactions(); }

/* —— smart lists: built-in presets in code, saved ones in meta.smart_lists —— */
function builtinLists(){
  var out=[{name:'This month',filters:{month:monthKey(new Date())}},
           {name:'Big spends, ₱5,000+',filters:{type:'Expense',minAmount:'5000'}}];
  out.push({name:'From Gmail',filters:{source:'gm'}},{name:'From Telegram',filters:{source:'tg'}});
  return out;
}
function savedLists(){ return (S.boot&&S.boot.smartLists)||[]; }
// A list without a month means every month, not "the Summary's month".
function listFilters(l){ return Object.assign({month:''},l.filters); }
function filterSig(f){ return TX_KEYS.map(function(k){ return f[k]==null?'':String(f[k]); }).join('|'); }
function isListOn(l){ return filterSig(listFilters(l))===filterSig(S.tx.filters); }
function cleanFilters(f){ var o={}; TX_KEYS.forEach(function(k){ if(f[k]!=null&&f[k]!=='') o[k]=String(f[k]); }); return o; }
function putSmartLists(lists, msg){
  return gs('api_setSmartLists',{lists:lists}).then(function(res){
    if(S.boot) S.boot.smartLists=res.smartLists;
    toast(msg,'ok'); if(S.screen==='transactions') renderTransactions();
  }).catch(showErr);
}
function openSaveList(){
  if(!activeTokens(S.tx.filters).length){ toast('Add a filter first','err'); return; }
  if(savedLists().length>=20){ toast('You can keep 20 smart lists','err'); return; }
  var name=inputEl('text','','e.g. Food over ₱1,000');
  var save=el('button','btn primary','Save');
  save.onclick=function(){
    var n=name.value.trim(); if(!n){ toast('Give the list a name','err'); return; }
    closeModal();
    putSmartLists(savedLists().concat([{name:n,filters:cleanFilters(S.tx.filters)}]),'Saved “'+n+'”');
  };
  openModal(modalShell('Save as a smart list', fieldEl('Name',name,activeTokens(S.tx.filters).map(function(t){ return tokenText(t.k,t.v); }).join(' · ')), [save]));
  setTimeout(function(){ name.focus(); },50);
}
function deleteList(i){
  var l=savedLists()[i];
  putSmartLists(savedLists().filter(function(_,j){ return j!==i; }),'Removed “'+l.name+'”');
}

function renderTransactions(){
  if(needBoot('list', renderTransactions)) return;
  if(S.tx.filters.month===undefined) S.tx.filters.month=S.month;   // first open: the Summary's month
  var sel=!!S.tx.edit, wide=txWide();
  var w=el('div','screen act'+(sel?' selecting':''));
  var body=el('div','act-body'); w.appendChild(body);
  if(wide) body.appendChild(filterPane());
  var main=el('div','act-main'); body.appendChild(main);

  var head=el('div','screen-head act-head');
  head.appendChild(el('div','screen-title','Activity'));
  var tg=el('button',sel?'btn sm primary':'link-btn act-sel',sel?'Done':'Select'); tg.type='button';
  tg.onclick=function(){ S.tx.edit=!S.tx.edit; clearSel(); renderTransactions(); };
  head.appendChild(tg);
  main.appendChild(head);
  main.appendChild(tokenField());

  if(wide){
    var bar=el('div','act-bar');
    bar.appendChild(typeSeg(S.tx.filters.type,function(v){ setTxFilter('type',v); }));
    bar.appendChild(el('span','act-hint','Click a category, account or date in the list to filter by it.'));
    main.appendChild(bar);
  } else {
    var chips=el('div','chips');
    var n=activeTokens(S.tx.filters).length;
    var fb=el('button','chip dark',icon('filter')+'Filters'+(n?' · '+n:'')); fb.type='button'; fb.onclick=openFilterSheet;
    chips.appendChild(fb);
    builtinLists().concat(savedLists()).forEach(function(l){
      var on=isListOn(l), c=el('button','chip'+(on?' on':''),esc(l.name)); c.type='button';
      c.onclick=function(){ setTxFilters(on?{month:''}:listFilters(l)); };
      chips.appendChild(c);
    });
    main.appendChild(chips);
  }
  var cnt=el('div','act-count'); cnt.id='txCount'; main.appendChild(cnt);
  var list=el('div','act-list'); list.id='txListCard'; list.innerHTML=skTile(skRows(6)); main.appendChild(list);
  var bb=el('div','bulk-bar'); bb.id='bulkBar'; bb.hidden=true; main.appendChild(bb);
  paint(w);
  loadTx(w);
}

function typeSeg(cur, onPick){
  var s=el('div','seg');
  [['','All'],['Expense','Spent'],['Income','Earned'],['Transfer','Moved']].forEach(function(o){
    var b=el('button',(cur||'')===o[0]?'on':'',o[1]); b.type='button';
    b.setAttribute('aria-pressed',(cur||'')===o[0]); b.onclick=function(){ onPick(o[0]); };
    s.appendChild(b);
  });
  return s;
}

/* The search field: active filters as tokens, typed text as suggestions. */
function tokenField(){
  var wrap=el('div','tok-wrap'), box=el('label','tok-field');
  box.innerHTML=icon('search');
  activeTokens(S.tx.filters).forEach(function(t){
    var c=el('span','tok','<span class="tok-f">'+esc(TOKEN_LABEL[t.k])+'</span>'+esc(tokenText(t.k,t.v)));
    var x=el('button','tok-x',icon('close')); x.type='button'; x.setAttribute('aria-label','Remove the '+TOKEN_LABEL[t.k]+' filter');
    x.onclick=function(e){ e.preventDefault(); setTxFilter(t.k,'',true); };
    c.appendChild(x); box.appendChild(c);
  });
  var inp=el('input'); inp.id='tokInput'; inp.type='text'; inp.autocomplete='off'; inp.spellcheck=false;
  inp.placeholder='Search'; inp.setAttribute('enterkeyhint','search'); inp.setAttribute('aria-label','Search or add a filter');
  box.appendChild(inp);
  var menu=el('div','tok-menu'); menu.hidden=true; menu.setAttribute('role','listbox');
  wrap.appendChild(box); wrap.appendChild(menu);
  var sugg=[], act=0;
  function mark(){ Array.prototype.forEach.call(menu.querySelectorAll('.tok-opt'),function(o,i){ o.classList.toggle('on',i===act); }); }
  function draw(){
    sugg=parseTokens(inp.value,tokenCtx()).slice(0,7); act=0; menu.innerHTML='';
    if(!sugg.length){ menu.hidden=true; return; }
    sugg.forEach(function(s,i){
      var o=el('div','tok-opt','<span class="tok-f">'+esc(TOKEN_LABEL[s.k])+'</span><span class="tok-v">'+
        esc(s.k==='search'?'contains “'+s.v+'”':tokenText(s.k,s.v))+'</span>');
      o.setAttribute('role','option');
      o.onmousedown=function(e){ e.preventDefault(); };   // keep the focus, or the blur closes the menu first
      o.onclick=function(){ setTxFilter(s.k,s.v,true); };
      o.onmouseenter=function(){ act=i; mark(); };
      menu.appendChild(o);
    });
    menu.appendChild(el('div','tok-hint','Try: >500 · aug · transfer · gmail · "exact words"'));
    mark(); menu.hidden=false;
  }
  inp.oninput=draw;
  inp.onfocus=function(){ if(inp.value) draw(); };
  inp.onblur=function(){ setTimeout(function(){ menu.hidden=true; },120); };
  inp.onkeydown=function(e){
    if(e.key==='ArrowDown'&&!menu.hidden){ e.preventDefault(); act=Math.min(sugg.length-1,act+1); mark(); }
    else if(e.key==='ArrowUp'&&!menu.hidden){ e.preventDefault(); act=Math.max(0,act-1); mark(); }
    else if(e.key==='Enter'){ e.preventDefault(); if(sugg[act]&&!menu.hidden) setTxFilter(sugg[act].k,sugg[act].v,true); }
    else if(e.key==='Escape'&&!menu.hidden){ e.stopPropagation(); menu.hidden=true; }
    else if(e.key==='Backspace'&&!inp.value){
      var last=activeTokens(S.tx.filters).pop(); if(last) setTxFilter(last.k,'',true);
    }
  };
  return wrap;
}

/* —— PC filter pane: smart lists, then the accounts with balances —— */
function filterPane(){
  var p=el('aside','act-pane');
  p.appendChild(el('div','pane-h','Smart lists'));
  function row(label,on,fn,del){
    var r=el('div','pane-row'+(on?' on':'')), b=el('button','pane-btn',label); b.type='button'; b.onclick=fn; r.appendChild(b);
    if(del){ var x=el('button','pane-x',icon('close')); x.type='button'; x.setAttribute('aria-label','Delete this smart list'); x.onclick=del; r.appendChild(x); }
    p.appendChild(r);
  }
  var all={filters:{}};
  row('All activity',isListOn(all),function(){ setTxFilters({month:''}); });
  builtinLists().forEach(function(l){ row(esc(l.name),isListOn(l),function(){ setTxFilters(listFilters(l)); }); });
  savedLists().forEach(function(l,i){ row(esc(l.name),isListOn(l),function(){ setTxFilters(listFilters(l)); },function(){ deleteList(i); }); });
  var sv=el('button','link-btn pane-add','Save as a smart list'); sv.type='button'; sv.onclick=openSaveList;
  p.appendChild(sv);
  p.appendChild(el('div','pane-h','Accounts'));
  var host=el('div'); host.id='paneAccts'; host.innerHTML=skRows(4); p.appendChild(host);
  loadPaneAccts(host);   // the host itself: a cached answer lands before paint() attaches it
  return p;
}
function loadPaneAccts(host){
  return cachedCall('accounts', function(et){return gs('api_getAccounts',null,et);}, function(res){
    host=host||$('#paneAccts'); if(!host) return;
    host.innerHTML='';
    (res.accounts||[]).forEach(function(a){
      var on=S.tx.filters.account===a.name;
      var r=el('div','pane-row'+(on?' on':'')), b=el('button','pane-btn',
        '<span class="acct-dot" style="background:'+(isHex6(a.color)?a.color:'var(--dim)')+'"></span>'+
        '<span class="pane-n">'+esc(a.name)+'</span><span class="pane-v'+(a.isLiability?' neg':'')+'">'+esc(acctMain(a))+'</span>');
      b.type='button'; b.onclick=function(){ setTxFilter('account',on?'':a.name); };
      r.appendChild(b); host.appendChild(r);
    });
  }).catch(showErr);
}

/* —— phone/iPad Filters sheet: edits a draft, Done applies it —— */
function openFilterSheet(){
  var d=Object.assign({},S.tx.filters), node=el('div','fsheet');
  function apply(){ if(d.date) d.month=''; closeModal(); setTxFilters(d); }
  function combo(opts,key){
    var c=comboEl([{value:'',label:'Any'}].concat(opts), d[key]||'');
    c.onchange=function(){ d[key]=c.value; if(key==='month'&&c.value) delete d.date; };
    return c;
  }
  function draw(){
    node.innerHTML='<div class="sheet-grab fs-grab"></div>';
    var h=el('div','fs-h'), rs=el('button',null,'Reset'), dn=el('button','b','Done');
    rs.type=dn.type='button'; rs.onclick=function(){ d={month:''}; draw(); }; dn.onclick=apply;
    h.appendChild(rs); h.appendChild(el('b',null,'Filters')); h.appendChild(dn); node.appendChild(h);
    var b=el('div','fs-b'); node.appendChild(b);
    function sec(label,child){ var s=el('div','fs-sec'); s.appendChild(el('div','fs-l',label)); s.appendChild(child); b.appendChild(s); }
    var sl=el('div','fs-chips');
    builtinLists().concat(savedLists()).forEach(function(l){
      var on=filterSig(listFilters(l))===filterSig(d), c=el('button','chip'+(on?' on':''),esc(l.name)); c.type='button';
      c.onclick=function(){ d=on?{month:''}:listFilters(l); draw(); };
      sl.appendChild(c);
    });
    sec('Smart lists',sl);
    sec('Type',typeSeg(d.type,function(v){ d.type=v; draw(); }));
    var g=el('div','fs-group');
    function row(label,ctl){ var r=el('div','fs-row'); r.appendChild(el('span',null,label)); r.appendChild(ctl); g.appendChild(r); }
    var cats=(S.boot&&S.boot.categories)||{}, segs={};
    Object.keys(cats).forEach(function(k){ if(cats[k].Segment) segs[cats[k].Segment]=1; });
    row('Month',combo(monthOptions(),'month'));
    var di=inputEl('date',d.date||''); di.onchange=function(){ d.date=di.value; }; row('Date',di);
    row('Category',combo(Object.keys(cats).sort(),'category'));
    row('Segment',combo(Object.keys(segs),'segment'));
    row('Added from',combo(Object.keys(SOURCES).map(function(k){ return {value:k,label:SOURCES[k]}; }),'source'));
    b.appendChild(g);
    var ac=el('div','fs-chips');
    acctOptions().forEach(function(o){
      var on=d.account===o.value, c=el('button','chip'+(on?' on':''),dotHTML(o.color)+esc(o.value)); c.type='button';
      c.onclick=function(){ d.account=on?'':o.value; draw(); };
      ac.appendChild(c);
    });
    sec('Accounts',ac);
    var am=el('div','fs-amt');
    [['minAmount','At least'],['maxAmount','At most']].forEach(function(x){
      var i=inputEl('text',d[x[0]]||'','Any'); i.inputMode='decimal';
      i.onchange=function(){ var n=amountOf(i.value); d[x[0]]=n==null?'':String(n); };
      var l=el('label','fs-in'); l.appendChild(el('span',null,x[1])); l.appendChild(i); am.appendChild(l);
    });
    sec('Amount',am);
    var f=el('div','fs-f'), go=el('button','btn primary','Show results'), sv=el('button','link-btn','Save as a smart list');
    go.type=sv.type='button'; go.onclick=apply;
    sv.onclick=function(){ apply(); openSaveList(); };
    f.appendChild(go); f.appendChild(sv); node.appendChild(f);
  }
  draw();
  openModal(node, {sheet:true});
}

// silent: skip the skeleton (keep optimistic rows on screen until fresh server data
// lands, so an added/deleted row transitions smoothly instead of flashing).
function loadTx(w, silent){
  var st={filters:S.tx.filters, offset:S.tx.offset, limit:S.tx.limit};
  var key='tx|'+JSON.stringify(S.tx.filters||{})+'|'+S.tx.offset+'|'+S.tx.limit;
  var card=$('#txListCard'); if(card && !silent && !S.cache[key]) card.innerHTML=skTile(skRows(6));
  return cachedCall(key, function(et){return fetchTxPage(st,et);}, function(res){
    S.tx.total=res.total; S.tx.net=res.net; S.tx.rows=res.transactions;
    renderTxList();
  }).catch(showErr);
}

// Signed peso effect of one row: income adds, expense subtracts, a transfer moves
// money and counts 0. A refund is a negative Expense, so it ADDS back.
function txNet(t){
  var php=Number(t['Amount (PHP)'])||0;
  return String(t.Type)==='Expense'?-php:(String(t.Type)==='Income'?php:0);
}
function fmtNet(n){ n=Math.round(n*100)/100; return (n>0?'+':(n<0?'−':''))+money(Math.abs(n),true); }
// Bucket rows into day groups (display order preserved) with each day's net.
function groupByDay(rows){
  var groups=[], byDate={};
  (rows||[]).forEach(function(t){
    var d=dayMonth(t.Date,{year:'always'});
    if(!byDate[d]){ byDate[d]={label:d,rows:[],net:0,date:t.Date}; groups.push(byDate[d]); }
    byDate[d].rows.push(t);
    byDate[d].net+=txNet(t);
  });
  return groups;
}
function dayHeadEl(g){
  var dt=parseDate(g.date), iso=isoDate(g.date), on=iso&&S.tx.filters.date===iso;
  var label=dt?DAYS[dt.getDay()]+', '+dt.getDate()+' '+MONTHS_FULL[dt.getMonth()]+
    (dt.getFullYear()!==new Date().getFullYear()?' '+dt.getFullYear():''):g.label;
  var h=el('div','day-h','<button type="button" class="ld-date'+(on?' on':'')+'">'+esc(label)+'</button>'+
    (Math.round(g.net)?'<span class="'+(g.net>0?'pos':'')+'">'+fmtNet(g.net)+'</span>':''));
  var b=$('.ld-date',h);
  b.title=on?'Show every date again':'Show only this date';
  b.onclick=function(){ setTxFilter('date',on?'':iso); };
  return h;
}

/* The add field, the row modal and the Telegram deep link can all write from any screen,
 * so repaint the list only when it's actually on screen. */
function repaintTxList(){
  if(S.screen==='transactions') renderTxList();
}
function isPendingRow(t){ return !!(t._pending || (t.ID && (S.tx.pendingDeletes[t.ID] || S.tx.pendingEdits[t.ID]))); }
// Show an in-flight edit's NEW values while it's still in the air. Amount is patched
// SIGNED (a refund is negative), so only the FX ratio has to be carried over; a category
// change can flip Type, which drives the +/− and the icon.
function withPendingEdit(t){
  var p=t.ID&&S.tx.pendingEdits[t.ID]; if(!p) return t;
  var o=Object.assign({},t,p);
  if(p.Amount!=null){
    var old=Number(t.Amount)||0, php=Number(t['Amount (PHP)']), rate=old?php/old:1;
    o.Amount=Number(p.Amount);
    o['Amount (PHP)']=Number(p.Amount)*rate;
  }
  var cat=p.Category&&S.boot&&(S.boot.categories||{})[p.Category];
  if(cat&&cat.Type) o.Type=cat.Type;
  return o;
}

// A pending create only belongs on the list if the active filters would have returned
// it — otherwise adding under one account/type flashes a row that the filter excludes.
// Mirrors the server-side filter in listTransactions. A pending row is always "App".
function matchesTxFilters(t){
  var f=S.tx.filters||{}, d=parseDate(t.Date), abs=Math.abs(Number(t['Amount (PHP)'])||0);
  var cat=(S.boot&&(S.boot.categories||{})[t.Category])||{};
  if(f.account && t.Account!==f.account && t.ToAccount!==f.account) return false;
  if(f.category && t.Category!==f.category) return false;
  if(f.segment && cat.Segment!==f.segment) return false;
  if(f.source && f.source!=='ui') return false;
  // an optimistic transfer may not carry its derived Type yet
  if(f.type && (txIsXfer(t)?'Transfer':String(t.Type||''))!==f.type) return false;
  if(f.month && (t.Period||(d?monthKey(d):''))!==f.month) return false;
  if(f.date && isoDate(t.Date)!==f.date) return false;
  if(f.minAmount && abs<Number(f.minAmount)) return false;
  if(f.maxAmount && abs>Number(f.maxAmount)) return false;
  if(f.search && ((t.Description||'')+' '+(t.Category||'')).toLowerCase()
                   .indexOf(f.search.toLowerCase())<0) return false;
  return true;
}

// Repaint the list from S.tx.rows plus optimistic state (pending creates at the top,
// pending deletes in place). No server round trip, so the selection and filters stay.
function renderTxList(){
  var c=$('#txListCard'); if(!c) return;
  var sel=!!S.tx.edit, wide=txWide();
  // pending creates only make sense on the first page (they'd be the newest rows)
  var adds=(S.tx.offset<=0)?(S.tx.pendingAdds||[]).filter(matchesTxFilters):[];
  var rows=S.tx.rows||[], allRows=adds.concat(rows), total=(S.tx.total||0)+adds.length;
  var cnt=$('#txCount');
  if(cnt){
    cnt.innerHTML='<span>'+total+' result'+(total===1?'':'s')+(Math.round(S.tx.net||0)?' · '+fmtNet(S.tx.net):'')+'</span>';
    if(sel&&rows.length){
      var every=rows.every(function(t){ return S.tx.sel[t.ID]; });
      var sa=el('button','link-btn',every?'Select none':'Select all'); sa.type='button';
      sa.onclick=function(){ rows.forEach(function(t){ if(every) delete S.tx.sel[t.ID]; else S.tx.sel[t.ID]=true; }); renderTxList(); };
      cnt.appendChild(sa);
    }
  }
  c.innerHTML='';
  if(!allRows.length){ c.appendChild(el('div','tile empty',icon('search')+'No transactions match.')); }
  else if(wide){
    var tb=el('div','card tx-table'+(sel?' sel-mode':''));
    tb.appendChild(el('div','tx-tr tx-th',(sel?'<span></span>':'')+'<span>Date</span><span>Description</span><span>Category</span><span>Account</span><span class="r">Amount</span>'));
    allRows.forEach(function(t){ tb.appendChild(txTableRow(withPendingEdit(t),{edit:sel,pending:isPendingRow(t)})); });
    c.appendChild(tb);
  } else {
    groupByDay(allRows).forEach(function(g){
      var day=el('div','day'), card=el('div','day-card');
      day.appendChild(dayHeadEl(g));
      g.rows.forEach(function(t){
        var pending=isPendingRow(t);
        var r=txRow(withPendingEdit(t),{edit:sel,pending:pending,clickable:!pending,hideDate:true,tokens:!sel});
        card.appendChild(!sel&&!pending?swipeWrap(r,t):r);
      });
      day.appendChild(card); c.appendChild(day);
    });
  }
  if(S.tx.total>S.tx.limit) c.appendChild(pagerEl(S.tx.offset,S.tx.limit,S.tx.total,function(o){ S.tx.offset=o; clearSel(); loadTx(); }));
  updateBulkBar();
}

// How a row reads: which way the money ran, its sign and its tint. The category type
// says the usual direction, and a NEGATIVE amount reverses it: a refund is a negative
// Expense, so it pays money back and reads "+". Spending is plain text, never red.
function txView(t){
  var type=String(t.Type||''), isXfer=txIsXfer(t);
  var dir=isXfer?0:(type==='Expense'?-1:(type==='Income'?1:0))*(Number(t.Amount)<0?-1:1);
  var cur=t.Currency||'PHP', isForeign=cur!=='PHP', amtPhp=t['Amount (PHP)'];
  var seg=((S.boot&&(S.boot.categories||{})[t.Category])||{}).Segment;
  var tint=isXfer?'accent':(dir>0?'pos':({Essentials:'ess',Rewards:'rew',Growth:'gro'})[seg]||'');
  // Foreign-currency tx: the NATIVE amount in its own symbol, the peso figure beside it.
  var mainAmt=isForeign?moneyCur(Math.abs(Number(t.Amount)),cur):money(Math.abs(amtPhp));
  return {isXfer:isXfer, dir:dir, isForeign:isForeign, amtPhp:amtPhp, seg:seg, tint:tint,
          amt:(dir<0?'−':(dir>0?'+':''))+mainAmt, amtCls:isXfer?'xfer':(dir>0?'pos':(dir<0?'neg':''))};
}
// A category/account/date that adds itself as a filter token when clicked.
function tokLink(html,k,v){
  var s=el('span','tok-link',html); s.title='Filter by this';
  s.onclick=function(e){ e.stopPropagation(); setTxFilter(k,S.tx.filters[k]===v?'':v); };
  return s;
}
function selectClick(r,t){
  return function(e){
    if(e.target.closest('.ed,.t1-edit,.amt-edit,.ic-edit,input,.combo,.inline-edit')) return;
    var on=!S.tx.sel[t.ID]; toggleSel(t.ID,on); r.classList.toggle('sel',on);
    var chk=r.querySelector('.tx-check'); if(chk) chk.checked=on;
  };
}

/* One list row for Activity (phone, iPad) and the Summary's Recent tile. opts:
 *   edit      — Select mode: checkbox + inline single-field editors (the icon opens the modal)
 *   pending   — in-flight write: spinner glyph, nothing interactive
 *   clickable — browsing: the whole row opens the modal
 *   hideDate  — the list already groups rows under date headers
 *   tokens    — the category and account are filter links (Activity only)        */
function txRow(t,opts){
  opts=opts||{};
  var edit=!!opts.edit, pending=!!opts.pending, clickable=!!opts.clickable, v=txView(t);
  var r=el('div','litem tx'+(edit?' edit':'')+(clickable&&!edit?' click':'')+
                        (edit&&S.tx.sel[t.ID]?' sel':'')+(pending?' pending':''));
  if(pending&&edit) r.style.pointerEvents='none';
  if(edit){
    var chk=el('input','tx-check'); chk.type='checkbox'; chk.checked=!!S.tx.sel[t.ID];
    chk.setAttribute('aria-label','Select');
    chk.onclick=function(e){ e.stopPropagation(); toggleSel(t.ID, chk.checked); r.classList.toggle('sel', chk.checked); };
    r.appendChild(chk);
    r.onclick=selectClick(r,t);
  }
  var title=t.Description||t.Category||'';
  var ic=pending?el('div','ic','<span class="mini-spin"></span>')
                :el('div','ic tx-ic'+(v.tint?' s-'+v.tint:'')+(edit?' ic-edit':''), v.isXfer?'⇄':esc(title.charAt(0).toUpperCase()||'•'));
  if(edit&&!pending){ ic.title='Open details'; ic.onclick=function(e){ e.stopPropagation(); openTxModal(t); }; }
  r.appendChild(ic);

  var grow=el('div','grow'), fromC=acctColor(t.Account), toC=acctColor(t.ToAccount);
  if(edit){
    // description — inline editable; empty = no description, and the ".t1-edit:empty"
    // CSS supplies the "+ note" affordance rather than a placeholder string
    var t1=el('div','t1 t1-edit', esc(t.Description||''));
    t1.title='Edit description';
    t1.onclick=function(){ inlineInput(t1,'text', t.Description||'', function(val){ commitInline(t,'Description',val); }); };
    grow.appendChild(t1);
    var sub=el('div','t2');
    sub.appendChild(editableSpan(esc(t.Category||'(category)'), function(host){
      inlineCombo(host, catsForShape(v.isXfer), t.Category, function(val){ commitInline(t,'Category',val); });
    }));
    sub.appendChild(document.createTextNode(' · '));
    sub.appendChild(editableSpan(dotHTML(fromC)+esc(t.Account||'(account)'), function(host){
      inlineCombo(host, acctOptions(), t.Account, function(val){ commitInline(t,'Account',val); });
    }));
    if(v.isXfer) sub.appendChild(document.createTextNode(' → '+(t.ToAccount||'')));
    if(v.isForeign) sub.appendChild(document.createTextNode(' · '+money(Math.abs(v.amtPhp))));
    grow.appendChild(sub);
  } else {
    grow.appendChild(el('div','t1',esc(title)));
    var s2=el('div','t2'), tok=!!opts.tokens;
    function part(html,k,val){ s2.appendChild(tok?tokLink(html,k,val):el('span',null,html)); }
    // With no description the category is the title, so it leaves the sub line.
    if(t.Description&&t.Category){ part(esc(t.Category),'category',t.Category); s2.appendChild(document.createTextNode(' · ')); }
    part(dotHTML(fromC)+esc(t.Account||''),'account',t.Account);
    if(v.isXfer){ s2.appendChild(document.createTextNode(' → ')); part(dotHTML(toC)+esc(t.ToAccount||''),'account',t.ToAccount); }
    if(!opts.hideDate) s2.appendChild(document.createTextNode(' · '+dayMonth(t.Date,{year:'always'})));
    grow.appendChild(s2);
  }
  r.appendChild(grow);

  // amount — inline editable in Select mode (edits the native magnitude; sign derives from Type)
  var amt=el('div','amt '+(edit?'amt-edit ':'')+v.amtCls,
    v.amt+(v.isForeign&&!edit?'<span class="amt-sub">'+money(Math.abs(v.amtPhp))+'</span>':''));
  if(edit){
    amt.title='Edit amount';
    amt.onclick=function(e){ e.stopPropagation(); inlineInput(amt,'number', Number(t.Amount), function(val){ commitInline(t,'Amount',val); }); };
  }
  r.appendChild(amt);
  if(clickable&&!edit) r.onclick=function(){ if(swClose()) return; openTxModal(t); };
  return r;
}

/* One table row (1200px and wider). Browsing: the row opens the modal, and the date,
 * category and account cells add a filter token. Select mode: checkbox + the same
 * inline single-field editors as the list. */
function txTableRow(t,opts){
  var edit=!!opts.edit, pending=!!opts.pending, v=txView(t), dt=parseDate(t.Date);
  var r=el('div','tx-tr'+(edit?' edit':' click')+(edit&&S.tx.sel[t.ID]?' sel':'')+(pending?' pending':''));
  if(pending) r.style.pointerEvents='none';
  function cell(cls,html){ var c=el('span','tx-td'+(cls?' '+cls:''),html||''); r.appendChild(c); return c; }
  if(edit){
    var cb=cell('');
    var chk=el('input','tx-check'); chk.type='checkbox'; chk.checked=!!S.tx.sel[t.ID]; chk.setAttribute('aria-label','Select');
    chk.onclick=function(e){ e.stopPropagation(); toggleSel(t.ID,chk.checked); r.classList.toggle('sel',chk.checked); };
    cb.appendChild(chk);
    r.onclick=selectClick(r,t);
  }
  var dc=cell('dim'), dl=dt?dayMonth(dt,{short:1,year:'auto'}):'';
  if(edit) dc.textContent=dl; else dc.appendChild(tokLink(esc(dl),'date',isoDate(t.Date)));
  var fromC=acctColor(t.Account), toC=acctColor(t.ToAccount);
  var dsc=cell('');
  var catH='<span class="cat-dot" style="background:'+(v.seg?SEG_COLOR[v.seg]||'var(--dim)':'var(--dim)')+'"></span>'+esc(t.Category||'');
  var cc=cell(''), ac=cell('');
  var acH=dotHTML(fromC)+esc(t.Account||'')+(v.isXfer?' → '+dotHTML(toC)+esc(t.ToAccount||''):'');
  var am=cell('r amt '+v.amtCls, v.amt+(v.isForeign?'<span class="amt-sub">'+money(Math.abs(v.amtPhp))+'</span>':''));
  if(edit){
    var d1=el('span','t1-edit',esc(t.Description||'')); d1.title='Edit description'; dsc.appendChild(d1);
    d1.onclick=function(e){ e.stopPropagation(); dsc.classList.add('editing'); inlineInput(d1,'text',t.Description||'',function(val){ commitInline(t,'Description',val); }); };
    cc.appendChild(editableSpan(catH,function(host){ cc.classList.add('editing'); inlineCombo(host,catsForShape(v.isXfer),t.Category,function(val){ commitInline(t,'Category',val); }); }));
    ac.appendChild(editableSpan(acH,function(host){ ac.classList.add('editing'); inlineCombo(host,acctOptions(),t.Account,function(val){ commitInline(t,'Account',val); }); }));
    am.classList.add('amt-edit'); am.title='Edit amount';
    am.onclick=function(e){ e.stopPropagation(); am.classList.add('editing'); inlineInput(am,'number',Number(t.Amount),function(val){ commitInline(t,'Amount',val); }); };
  } else {
    dsc.textContent=t.Description||'';
    if(!t.Description) dsc.classList.add('dim');
    cc.appendChild(tokLink(catH,'category',t.Category));
    ac.appendChild(tokLink(dotHTML(fromC)+esc(t.Account||''),'account',t.Account));
    if(v.isXfer){ ac.appendChild(document.createTextNode(' → ')); ac.appendChild(tokLink(dotHTML(toC)+esc(t.ToAccount||''),'account',t.ToAccount)); }
    r.onclick=function(){ openTxModal(t); };
  }
  return r;
}

/* —— swipe: left shows Delete, right selects the row (touch only; a tap opens the
 * modal, which also has Delete, and Select mode has both) —— */
var swOpen=null;   // the one row whose Delete is showing
var SW=76;         // the width of the Delete button
function swRest(w){ w.lastChild.style.transform=''; setTimeout(function(){ if(swOpen!==w) w.classList.remove('sw-on'); },320); }
function swClose(){
  if(!swOpen) return false;
  var w=swOpen; swOpen=null; swRest(w); return true;
}
function swipeWrap(row,t){
  var w=el('div','swipe'), acts=el('div','swipe-acts');
  var sb=el('div','sw-sel',icon('check')), db=el('button','sw-del','Delete');
  db.type='button';
  db.onclick=function(){ swClose(); confirmDelete(t); };
  acts.appendChild(sb); acts.appendChild(db); w.appendChild(acts); w.appendChild(row);
  var x0=null, y0=0, dx=0, base=0, drag=false;
  row.addEventListener('touchstart',function(e){
    var p=e.touches[0]; x0=p.clientX; y0=p.clientY; dx=0; drag=false; base=swOpen===w?-SW:0;
    if(swOpen&&swOpen!==w) swClose();
  },{passive:true});
  row.addEventListener('touchmove',function(e){
    if(x0==null) return;
    var p=e.touches[0]; dx=p.clientX-x0;
    if(!drag){
      if(Math.abs(dx)<10) return;
      if(Math.abs(p.clientY-y0)>Math.abs(dx)){ x0=null; return; }   // a scroll, not a swipe
      drag=true; row.style.transition='none'; w.classList.add('sw-on');
    }
    var x=Math.max(-SW,Math.min(SW,base+dx));
    w.classList.toggle('sw-right',x>0);
    row.style.transform='translateX('+x+'px)';
  },{passive:true});
  row.addEventListener('touchend',function(){
    if(x0==null||!drag){ x0=null; return; }
    x0=null; row.style.transition='';
    if(base+dx>60){   // right: enter Select mode with this row picked
      swOpen=null; S.tx.edit=true; S.tx.sel={}; S.tx.sel[t.ID]=true; renderTransactions(); return;
    }
    var open=base+dx<-60;
    swOpen=open?w:null;
    if(open) row.style.transform='translateX(-'+SW+'px)'; else swRest(w);
  });
  return w;
}

// Parse a Date or "yyyy-MM-dd" string. ISO date strings are read as a LOCAL date
// (not UTC) so the day never shifts; other inputs fall back to native parsing.
function parseDate(d){
  if(d instanceof Date) return d;
  var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).trim());
  if(m) return new Date(+m[1], +m[2]-1, +m[3]);
  var dt=new Date(d); return isNaN(dt.getTime())?null:dt;
}
/* The one date format: DAY FIRST, as everywhere in the app. Takes a Date or anything
 * parseDate reads, and returns the input unchanged when it is not a date.
 *   o.short  'Sep' rather than 'September'
 *   o.year   'always', 'auto' (only when it is not this year), or omitted for never */
function dayMonth(v,o){
  var dt=parseDate(v);
  if(!dt||isNaN(dt.getTime())) return v==null?'':String(v);
  o=o||{};
  var yr=o.year==='always'||(o.year==='auto'&&dt.getFullYear()!==new Date().getFullYear());
  return dt.getDate()+' '+(o.short?MONTHS:MONTHS_FULL)[dt.getMonth()]+(yr?' '+dt.getFullYear():'');
}

/* ════════════════════════════════════════════════════════════════════════
 *  ACCOUNTS
 * ════════════════════════════════════════════════════════════════════════ */
function isRecv(a){ return /receivable/i.test(a.subtype||''); }
function signedPhp(n,big){ return n==null?'—':(n<0?'−':'')+money(Math.abs(n),big); }
// The initial tile. An account's own colour is only ever this tile or a dot
// (DESIGN.md), drawn as a tint so a pale colour still reads in both themes.
function acctTile(label,c){
  var s=c?' style="background:color-mix(in srgb,'+c+' 22%,transparent);color:color-mix(in srgb,'+c+' 70%,var(--text))"':'';
  return '<span class="a-ic"'+s+'>'+label+'</span>';
}
function rateText(a){
  if(!a.interestRate) return '';
  return (Math.round(a.interestRate*10000)/100).toFixed(2)+'% a year'+
    (a.interestFrequency&&a.interestFrequency!=='None'?' · '+a.interestFrequency.toLowerCase()+' interest':'');
}
function acctRow(a){
  var r=el('button','a-row'); r.type='button';
  var sub=esc(rateText(a)||a.subtype||''), subCls='', meter='';
  if(a.currency&&a.currency!=='PHP') sub+=(sub?' · ':'')+esc(a.currency);
  if(isRecv(a)) sub=a.netWorthPhp<0?'You owe them · shortens runway':'Not counted in runway';
  if(a.isLiability&&a.creditLimit>0){
    var u=(a.balancePhp||0)/a.creditLimit, full=a.availableCredit!=null&&a.availableCredit<=0;
    meter=bar6([[u,'var(--'+(full?'warn':'accent')+')']]).outerHTML;
    sub=full?'Limit reached':money(a.availableCredit)+' available of '+money(a.creditLimit);
    if(full) subCls=' warn';
  }
  var foreign=a.currency&&a.currency!=='PHP';
  r.innerHTML=acctTile(esc(String(a.name).charAt(0).toUpperCase()),isHex6(a.color)?a.color:'')+
    '<span class="a-mid"><span class="a-t">'+esc(a.name)+'</span>'+meter+'<span class="a-s'+subCls+'">'+sub+'</span></span>'+
    '<span class="a-v"><span class="'+((a.netWorthPhp||0)<0?'neg':'')+'">'+signedPhp(a.netWorthPhp)+'</span>'+
    (foreign?'<small>'+moneyCur(a.balanceNative,a.currency)+'</small>':'')+'</span>'+icon('chevron');
  r.onclick=function(){ openAccountModal(a); };
  return r;
}
// A titled group: the label outside the card on a phone, inside it from 768px.
function acctGroup(title,right,rows,cls){
  var g=el('section','a-grp'+(cls?' '+cls:''));
  g.appendChild(el('div','a-gh','<span>'+esc(title)+'</span><span>'+right+'</span>'));
  var l=el('div','a-list'); rows.forEach(function(n){ l.appendChild(n); });
  g.appendChild(l); return g;
}

function renderAccounts(){
  if(!S.cache['accounts']) loading('accounts');
  return cachedCall('accounts', function(et){return gs('api_getAccounts',null,et);}, function(res){
    var accs=res.accounts||[];
    var cash=[],credit=[],recv=[],shares=[];
    accs.forEach(function(a){ (a.isShares?shares:a.isLiability?credit:isRecv(a)?recv:cash).push(a); });
    function sum(l,f){ return l.reduce(function(s,a){ return s+(f?f(a):(a.netWorthPhp||0)); },0); }
    // Same split as netWorthTotals() in api.js: a NEGATIVE receivable is money the
    // owner owes, so it is a liability, not an asset worth less.
    var lent=sum(recv,function(a){ return Math.max(0,a.netWorthPhp||0); }), owe=sum(recv)-lent;
    var cashT=sum(cash), invT=sum(shares), assets=cashT+invT+lent, liab=sum(credit)+owe;
    var nLent=recv.filter(function(a){ return a.netWorthPhp>0; }).length;

    var w=el('div','screen');
    var head=el('div','screen-head'); head.appendChild(el('div','screen-title','Accounts')); w.appendChild(head);
    w.appendChild(el('div','screen-sub',accs.length+' accounts'+(nLent?' · '+nLent+' owe you':'')));

    var tot=el('div','a-tot');
    function cell(label,fig,cls,foot,spec){
      var t=sumTile('',label,null,spec); t.appendChild(el('div','fig'+(cls?' '+cls:''),fig));
      t.appendChild(el('div','tile-foot',foot)); tot.appendChild(t);
    }
    cell('Assets',money(assets,true),'','Cash '+money(cashT,true)+' · Invested '+money(invT,true)+(lent?' · Owed '+money(lent,true):''));
    cell(twoLabels('Liabilities','Owe'),signedPhp(liab,true),liab<0?'neg':'',
      credit.length+' credit line'+(credit.length===1?'':'s')+(owe?' · '+money(-owe,true)+' you owe':''));
    cell(twoLabels('Net worth','Net'),signedPhp(assets+liab,true),'','Assets − liabilities',{title:'What you own minus what you owe',
      text:'Every account at today\'s balance, prices and exchange rate. The same figure as Summary.',
      rows:[['Assets',money(assets,true)],['− Liabilities',money(-liab,true)],['= Net worth',signedPhp(assets+liab,true),true]],
      note:'Money you lent counts as an asset. Money you owe through a receivable counts as a liability.'});
    w.appendChild(tot);

    var body=el('div','a-body'), L=el('div','a-col'), R=el('div','a-col');
    body.appendChild(L); body.appendChild(R); w.appendChild(body);
    L.appendChild(acctGroup('Cash and banks',money(cashT,true),cash.map(acctRow)));
    if(credit.length) L.appendChild(acctGroup('Credit','<span class="neg">'+signedPhp(sum(credit),true)+'</span>',credit.map(acctRow)));
    if(shares.length){
      var ir=el('button','a-row'); ir.type='button';
      ir.innerHTML=acctTile(icon('investments'),'var(--gro)')+'<span class="a-mid"><span class="a-t">Holdings</span>'+
        '<span class="a-s">'+shares.length+' positions · average cost and gain</span></span>'+
        '<span class="a-v">'+money(invT,true)+'</span>'+icon('chevron');
      ir.onclick=function(){ go('investments'); };
      L.appendChild(acctGroup('Investments',money(invT,true),[ir]));
    }
    var rt=sum(recv)>=0&&!owe?'Owed to you':(lent?'Owed to you and by you':'You owe');
    if(recv.length) R.appendChild(acctGroup(rt,signedPhp(sum(recv),true),recv.map(acctRow)));
    var dbt=el('div'); dbt.id='debtsCard'; R.appendChild(dbt);
    var rc=recurringGroup(); if(rc) R.appendChild(rc);
    paint(w);
    loadDebts();
  }).catch(showErr);
}

// Recurring and installments, off getBootstrap (no fetch). Sorted by group; an
// installment says how many months are left.
function recurringGroup(){
  var rec=((S.boot&&S.boot.recurring)||[]).slice();
  if(!rec.length) return null;
  var fx=(S.boot&&S.boot.fxUsdPhp)||0, total=0;
  rec.sort(function(a,b){ return (a.Group||'~').localeCompare(b.Group||'~'); });
  var rows=rec.map(function(o){
    var cur=o.Currency||'PHP', amt=o.Amount, ml=o['Months Left'];
    if(amt!==''&&amt!=null) total+=cur==='PHP'?amt:(cur==='USD'?amt*fx:0);
    var r=el('div','a-row r-row');
    r.innerHTML='<span class="a-mid"><span class="a-t">'+esc(o.Description||'')+'</span></span>'+
      '<span class="a-s">'+(ml!==''&&ml!=null?esc(ml)+' months left':esc(o.Group||'Monthly'))+'</span>'+
      '<span class="a-v">'+(amt!==''&&amt!=null?(cur==='PHP'?money(amt,true):moneyCur(amt,cur)):'—')+'</span>';
    return r;
  });
  return acctGroup('Recurring and installments',money(total,true)+' a month',rows);
}

/* The iOS balance widget's accounts (meta widget_accounts, read by getWidget),
 * seeded from getBootstrap. On the Admin screen: it is setup, not a reading. A tap saves at once. */
function widgetPicker(accs){
  var g=acctGroup('iPhone balance widget','Pick up to 3',[],'a-wid');
  var box=el('div','a-chips'); $('.a-list',g).appendChild(box);
  function draw(){
    var cur=S.boot.widgetAccounts||[];
    box.innerHTML='';
    accs.forEach(function(a){
      var on=cur.indexOf(a.name)>=0, c=el('button','chip'+(on?' on':''),esc(a.name)+(on?icon('check'):''));
      c.type='button'; c.setAttribute('aria-pressed',on);
      c.onclick=function(){
        if(!on&&cur.length>=3){ toast('Pick up to 3. Remove one first.'); return; }
        var prev=cur, next=on?cur.filter(function(n){return n!==a.name;}):cur.concat([a.name]);
        S.boot.widgetAccounts=next; draw();
        gs('api_setWidgetAccounts',{names:next}).then(function(res){ S.boot.widgetAccounts=res.widgetAccounts; saveCache(); draw(); })
          .catch(function(e){ S.boot.widgetAccounts=prev; draw(); toast(e.message||String(e),'err'); });
      };
      box.appendChild(c);
    });
  }
  draw(); return g;
}

/* Open debts per receivable — the itemised balance behind each IOU account.
 *
 * getDebts derives this from the ledger (see api.js allocateDebts), so there is
 * nothing to tick off here and no write path: the card is a READING of the same
 * rows the Assets list already totals. Its own cachedCall rather than a field on
 * getBootstrap — this is one screen's card, and boot is the payload every launch
 * pays for.
 *
 * Sign follows the account, exactly as the Accounts tiles split it: positive means
 * they owe the owner, negative means the owner owes them. The two read differently
 * enough to be worth saying in words ("owes you" / "you owe"), because a minus sign
 * in front of a peso amount is the one thing people misread here.
 */
function loadDebts(){
  return cachedCall('debts', function(et){return gs('api_getDebts',null,et);}, function(res){
    var host=$('#debtsCard'); if(!host) return;
    host.innerHTML='';
    var people=(res.accounts||[]).filter(function(p){return (p.items||[]).length;});

    // One group per person, the same grouped rows as the rest of Accounts.
    people.forEach(function(p){
      var owed=p.balance>=0;
      host.appendChild(acctGroup('Open debts with '+p.account,(owed?'Owes you ':'You owe ')+'<span class="'+(owed?'pos':'neg')+'">'+money(Math.abs(p.balance))+'</span>',
        p.items.map(function(it){
          // A part-paid debt gets a meter: the only way to see an instalment burn down.
          var paid=Math.abs(it.amount)-Math.abs(it.open), frac=paid>0?paid/Math.abs(it.amount):0;
          // Short date, the year only when it is not this one: the line must fit a phone.
          var d=it.date&&parseDate(it.date);
          var when=d?dayMonth(d,{short:1,year:'auto'}):'Opening balance';
          // Direction per ITEM, not per account: a spend off the tab runs against the balance.
          var theirs=it.amount>=0;
          var r=el('div','a-row');
          r.innerHTML='<span class="a-mid"><span class="a-t">'+esc(it.description||'No description')+'</span>'+
            (frac?bar6([[frac,'var(--accent)']]).outerHTML:'')+
            '<span class="a-s">'+(theirs===owed?'':(theirs?'Owes you · ':'You owe · '))+esc(when)+
            (frac?' · '+Math.round(100*frac)+'% paid of '+money(Math.abs(it.amount),true):'')+'</span></span>'+
            '<span class="a-v"><span class="'+(theirs?'pos':'neg')+'">'+money(Math.abs(it.open))+'</span></span>';
          return r;
        })));
    });
  }).catch(showErr);
}

/* ════════════════════════════════════════════════════════════════════════
 *  INVESTMENTS (v3 Phase 5): invested with gain, the quarterly pulse,
 *  allocation, and the holdings table. One getInvestments payload — the same
 *  cache key Summary's runway tile reads.
 * ════════════════════════════════════════════════════════════════════════ */
var INV_COLORS=['var(--gro)','var(--accent)','var(--ess)','var(--rew)','var(--pos)','var(--warn)'];
// Colour per holding: its account colour, else a token slot by NAME (not rank),
// so a ticker keeps its colour across the pulse, allocation and table.
function invColors(pos){
  var names=pos.map(function(p){return p.name;}).sort(), m={};
  names.forEach(function(n,i){ m[n]=acctColor(n)||INV_COLORS[i%INV_COLORS.length]; });
  return m;
}
function gainSpec(inv){
  return {title:'Gain uses average cost',
    text:'Value today minus what the growth shares cost, at the peso rate on each buy day.',
    rows:[['Value today',money(inv.totalValuePhp,true)],['− Cost',money(inv.totalCostPhp,true)],
          ['= Gain',signedMoney(inv.totalGainPhp),true]],
    note:'A sale takes cost out in proportion, so the average cost never moves on a sale. Gain includes currency moves.'};
}
function qLabel(k){ var m=/^(\d{4})-(Q\d)$/.exec(k); return m?(m[2]+' '+m[1]):k; }

function renderInvestments(){
  if(!S.cache['investments']) loading('accounts');
  return cachedCall('investments', function(et){return gs('api_getInvestments',null,et);}, function(inv){
    var pos=inv.positions||[], col=invColors(pos);
    var w=el('div','screen');
    var head=el('div','screen-head'); head.appendChild(el('div','screen-title','Investments')); w.appendChild(head);
    var asOf=pos.reduce(function(m,p){ return p.pricedAt&&p.pricedAt>m?p.pricedAt:m; },'');
    w.appendChild(el('div','screen-sub',asOf?'Prices as of '+esc(dayMonth(asOf,{year:'always'})):'No prices yet'));
    if(!pos.length){ w.appendChild(el('div','tile','<div class="tile-foot">No holdings yet.</div>')); paint(w); return; }
    var g=el('div','sum inv'); w.appendChild(g);

    var t=sumTile('t-inv','Invested',null,gainSpec(inv)), gn=inv.totalGainPhp||0;
    t.appendChild(el('div','fig',money(inv.totalValuePhp,true)));
    if(inv.totalCostPhp) t.appendChild(el('div','inv-gain '+(gn>=0?'pos':'neg'),(gn>=0?'▲ ':'▼ ')+money(Math.abs(gn),true)+
      ' · '+pct(Math.abs(100*gn/inv.totalCostPhp))+(gn>=0?' over':' under')+' cost'));
    // EF parks are out of the figure above (see gainSpec), so the tile says so.
    var usd=usdOf(inv.totalValuePhp), ex=(inv.pulse&&inv.pulse.excluded)||[];
    var foot=[ex.length?'Growth holdings only':'',usd].filter(Boolean).join(' · ');
    if(foot) t.appendChild(el('div','tile-foot',foot));
    g.appendChild(t);
    // Stability's counterpart to Invested, and the same tile Summary shows. The EF is
    // commingled with spending cash (there is no EF account), so the runway measures it
    // and a park's share price never can. Same payload, so it costs no request.
    var rw=el('section','tile t-rw'); fillRunway(rw,inv.runway); g.appendChild(rw);
    if(inv.pulse) g.appendChild(pulseTile(inv.pulse,pos,col));
    g.appendChild(allocTile(inv,pos,col));
    g.appendChild(holdingsTile(inv,pos,col));
    paint(w);
  }).catch(showErr);
}

/* Buys per quarter into the GROWTH tickers (server-side, by account subtype; an EF
 * park like IB01 is left out). One bar per quarter on a common scale, split by
 * ticker. The bar measures money going IN, so a sale is a red line under it, and a
 * quarter with no buys is a dashed empty track. */
function pulseTile(pl,pos,col){
  var qs=pl.quarters||[], cur=qs[0]&&qs[0].quarter===pl.currentQuarter?qs[0]:null;
  var rank=pos.map(function(p){return p.name;});
  function agg(q){
    var order=[],m={},sells=[];
    q.buys.forEach(function(b){
      if(b.side==='sell'){ sells.push(b); return; }
      if(!m[b.symbol]){ m[b.symbol]={symbol:b.symbol,currency:b.currency,amount:0,quantity:0}; order.push(b.symbol); }
      m[b.symbol].amount+=b.amount||0; m[b.symbol].quantity+=b.quantity||0;
    });
    order.sort(function(a,b){ return rank.indexOf(a)-rank.indexOf(b); });
    return {buys:order.map(function(s){return m[s];}),sells:sells};
  }
  var spec=function(){
    var rows=[];
    if(cur){ var a=agg(cur);
      a.buys.forEach(function(b){ rows.push([b.symbol,moneyCur(b.amount,b.currency)]); });
      a.sells.forEach(function(b){ rows.push(['− '+b.symbol+' sold',moneyCur(b.amount,b.currency)]); }); }
    rows.push(['= '+qLabel(pl.currentQuarter),moneyCur(cur?cur.totalUsd:0,'USD'),true]);
    return {title:'Did you invest this quarter?',text:'Money moved into growth holdings each quarter, in US dollars. A sale in the quarter comes off.',
      rows:rows,note:'Buys come from transfers into the ticker accounts, not from categories.'};
  };
  var t=sumTile('t-pulse','Quarterly pulse','<b>'+qLabel(pl.currentQuarter)+'</b> · '+moneyCur(cur?cur.totalUsd:0,'USD'),spec);
  var maxT=Math.max.apply(null,[1].concat(qs.map(function(q){return q.totalUsd||0;})));
  var list=el('div','pq-list');
  function quarter(label,right){ var q=el('div','pq'); q.appendChild(el('div','pq-h','<span>'+esc(label)+'</span><b>'+right+'</b>')); list.appendChild(q); return q; }
  if(!cur) quarter(qLabel(pl.currentQuarter),'<span class="warn">Not invested yet</span>').appendChild(el('div','pq-bar empty'));
  qs.forEach(function(q){
    var a=agg(q), w=quarter(qLabel(q.quarter),moneyCur(q.totalUsd,'USD')), bar=el('div','pq-bar');
    if(!a.buys.length) bar.classList.add('empty');
    else bar.style.width=Math.max(6,Math.round(100*(q.totalUsd||0)/maxT))+'%';
    a.buys.forEach(function(b){ var i=el('i'); i.style.flex=Math.max(b.amount,1); i.style.background=col[b.symbol]||'var(--gro)';
      i.title=b.symbol+' · '+moneyCur(b.amount,b.currency)+' · '+num(b.quantity)+' shares'; bar.appendChild(i); });
    w.appendChild(bar);
    if(a.buys.length) w.appendChild(el('div','pq-d',a.buys.map(function(b){ return esc(b.symbol)+' '+moneyCur(b.amount,b.currency); }).join(' · ')));
    if(a.sells.length) w.appendChild(el('div','pq-d neg','Sold '+a.sells.map(function(b){
      return esc(b.symbol)+' '+moneyCur(b.amount,b.currency)+' ('+num(b.quantity)+' shares)'; }).join(' · ')));
  });
  t.appendChild(list);
  t.appendChild(el('div','tile-foot','Growth buys only.'));
  return t;
}

/* Growth holdings only, like the Invested tile: the mix is read against the strategy
 * targets below, and an EF park is not part of that mix. The server leaves weightPct
 * null on a park, so the bar sums to 100. */
function allocTile(inv,pos,col){
  var t=sumTile('t-alloc','Allocation');
  var ex=(inv.pulse&&inv.pulse.excluded)||[], g=pos.filter(function(p){ return ex.indexOf(p.name)<0; });
  var bar=el('div','alloc'), rows=el('div','alloc-rows');
  g.forEach(function(p){
    var i=el('i'); i.style.flex=Math.max(p.weightPct||0,.5); i.style.background=col[p.name]; i.title=p.name+' · '+pct(p.weightPct); bar.appendChild(i);
    var r=el('div','alloc-row','<i></i><span>'+esc(p.name)+'</span><b>'+pct(p.weightPct)+'</b>');
    r.firstChild.style.background=col[p.name]; rows.appendChild(r);
  });
  if(g.length){ t.appendChild(bar); t.appendChild(rows); }
  else t.appendChild(el('div','tile-foot','No growth holdings yet.'));
  // Strategy targets: reference figures from getInvestments, not computed.
  var core=inv.coreTargets||{}, seg=inv.segmentTargets||{};
  t.appendChild(el('div','tile-foot','Target: '+Object.keys(core).reverse().map(function(k){ return esc(core[k])+' '+esc(k)+'%'; }).join(' · ')+
    '<br>Segments: '+Object.keys(seg).map(function(k){ return esc(k)+' '+esc(seg[k])+'%'; }).join(' · ')));
  return t;
}

/* Average cost is the entry price a sale does NOT move, so it compares with the
 * live quote. Gain is peso gain against historical cost. A row opens the account. */
function holdingsTile(inv,pos,col){
  var t=el('section','tile t-hold');
  var hd=el('div','h-row h-head','<span class="h-name">Holding</span><span>Shares</span><span>Average cost</span><span>Price</span><span>Value</span>');
  var gh=el('span','h-gh','Gain'); gh.appendChild(tip(gainSpec(inv))); hd.appendChild(gh);
  t.appendChild(hd);
  var byName={};
  ((S.cache.accounts&&S.cache.accounts.data.accounts)||[]).forEach(function(a){ byName[a.name]=a; });
  function rows(list){ list.forEach(function(p){
    var acc=byName[p.name], r=el(acc?'button':'div','h-row');
    if(acc){ r.type='button'; r.onclick=function(){ openAccountModal(acc); }; }
    var ac=p.avgCostNative!=null?moneyCur(p.avgCostNative,p.costCurrency):'—';
    var pr=p.price!=null?moneyCur(p.price,p.priceCurrency):'—';
    var gain=p.gainPhp==null?'—':signedMoney(p.gainPhp)+(p.gainPct==null?'':' · '+pct(Math.abs(p.gainPct)));
    r.innerHTML='<span class="h-name">'+acctTile(esc(String(p.name).slice(0,4)),col[p.name])+
      '<span class="h-n"><b>'+esc(p.name)+'</b><span>'+esc(p.subtype||'')+
      '</span><span class="h-m">'+num(p.quantity)+' shares · avg '+ac+'</span></span></span>'+
      '<span class="h-sh">'+num(p.quantity)+'</span><span class="h-ac">'+ac+'</span><span class="h-pr">'+pr+'</span>'+
      '<span class="h-val">'+money(p.valuePhp,true)+'</span>'+
      '<span class="h-gain '+(p.gainPhp==null?'':p.gainPhp>=0?'pos':'neg')+'">'+gain+'</span>';
    t.appendChild(r);
  }); }
  // The table is the BROAD set — it lists a park too — so it is the one place the two
  // kinds meet. A subtotal per group is what makes it add up: the Growth line is the
  // Invested tile's figure, and the park's line is the holding the runway counts.
  var ex=(inv.pulse&&inv.pulse.excluded)||[];
  function group(label,list){
    if(!list.length) return;
    t.appendChild(el('div','h-row h-grp','<span>'+esc(label)+'</span><b>'+
      money(list.reduce(function(s2,p){ return s2+(p.valuePhp||0); },0),true)+'</b>'));
    rows(list);
  }
  if(ex.length){
    group('Growth',pos.filter(function(p){ return ex.indexOf(p.name)<0; }));
    group('Emergency fund',pos.filter(function(p){ return ex.indexOf(p.name)>=0; }));
  } else rows(pos);
  return t;
}

/* Native amount is the headline (shares qty / USD), PHP equivalent underneath —
   same main/amt-sub shape as the foreign-currency transaction rows. */
function acctMain(a){
  if(a.isShares) return num(a.balanceNative)+' shares';
  if(a.currency&&a.currency!=='PHP') return moneyCur(a.balanceNative,a.currency);
  return money(a.balancePhp);
}
/* ════════════════════════════════════════════════════════════════════════
 *  TAX / BIR (Ledger)
 * ════════════════════════════════════════════════════════════════════════ */
function renderTax(){
  var yr=S.taxYear||String(new Date().getFullYear());
  if(!S.cache['tax|'+yr]) loading('table');
  return cachedCall('tax|'+yr, function(et){return gs('api_getLedger',{year:yr},et);}, function(res){
    var rows=(res.rows||[]).slice();
    var cols=ledgerCols(res.cols||(rows[0]?Object.keys(rows[0]).filter(function(k){return k!=='__row';}):[]));
    var derived={}; (res.derived||[]).forEach(function(h){derived[h]=true;});
    // Everything the ledger writes need: the table to write to, the pk, and the map
    // from the sheet-era header this table shows to the db column behind it. The three
    // write routes are the ADMIN grid's — the ledger has none of its own (v3.2.0).
    var ctx={cols:cols, derived:derived, txIdCol:res.txIdCol,
             table:res.table, pk:res.pk, edit:res.edit||{}};
    // Newest payslip first. Dates arrive as yyyy-MM-dd, so a plain string compare
    // orders them; a row whose linked tx is gone has no date and floats to the top,
    // which is where a broken link wants to be.
    var dateCol=cols.filter(isDateCol)[0];
    if(dateCol) rows.sort(function(a,b){
      var x=String(a[dateCol]==null?'':a[dateCol]), y=String(b[dateCol]==null?'':b[dateCol]);
      return x<y?1:(x>y?-1:0);
    });

    var w=el('div','screen');
    var head=el('div','screen-head','<div class="screen-title">Tax</div>');
    var acts=el('div','btn-row');
    // BIR files per year and the payload is one year wide, so the year is a control.
    acts.appendChild(ledgerYearSelect(res.year, res.years));
    var addBtn=el('button','btn sm primary','Add row'); addBtn.type='button';
    addBtn.onclick=function(){ openLedgerAdd(ctx); };
    acts.appendChild(addBtn);
    head.appendChild(acts);
    w.appendChild(head);
    w.appendChild(el('div','screen-sub','Foreign salary for BIR, 8% of gross income · '+esc(res.year)));

    var qg=el('div','tax-q');
    taxQuarters(rows,String(res.year),isoDate(new Date())).forEach(function(q){ qg.appendChild(taxTile(q)); });
    w.appendChild(qg);
    if(res.unlinked&&res.unlinked.length) w.appendChild(unlinkedBanner(res.unlinked, ctx));

    if(!rows.length){ w.appendChild(el('div','tile','<div class="tile-foot">No salaries in the ledger for '+esc(res.year)+'.</div>')); }
    else {
      var card=el('section','tile tax-tbl'), wrap=el('div','tbl-wrap'), t=el('table','tbl');
      var htr=el('tr');
      cols.forEach(function(c){
        var th=el('th',LEDGER_NUM[c]?'num':null,esc(LEDGER_LABEL[c]||c));
        if(/rate/i.test(c)) th.appendChild(tip(BSP_TIP));
        htr.appendChild(th);
      });
      htr.appendChild(el('th'));
      var thead=el('thead'); thead.appendChild(htr); t.appendChild(thead);
      var tb=el('tbody');
      rows.forEach(function(r){ tb.appendChild(ledgerRowTr(r, ctx)); });
      t.appendChild(tb); wrap.appendChild(t); card.appendChild(wrap); w.appendChild(card);
    }
    paint(w);
  }).catch(showErr);
}

var BSP_TIP={title:'Why you type this rate',
  text:"BIR wants the central bank's reference rate on the day the money arrived. The app's live rate is a different number, so it cannot fill this in for you.",
  rows:[['PHP','USD × BSP rate'],['8% tax','PHP × 8%',true]],
  note:'Use the PHP per USD rate for the day the money arrived.',
  link:['https://www.bsp.gov.ph/statistics/external/day99_data.aspx','Open the BSP daily rates']};

/* The four BIR quarters of one year, from the ledger rows (pure, tested). A quarter
 * is filed when every salary in it has a Filed quarter. Q1–Q3 are due on the 15th
 * of the second month after; Q4 goes on the annual return, due 15 April. */
function taxQuarters(rows, year, today){
  var qs=[1,2,3,4].map(function(i){ return {q:i,n:0,filed:0,php:0,tax:0}; });
  rows.forEach(function(r){
    var d=String(r['Date Received']||'');
    if(d.slice(0,4)!==year||!/^\d{4}-\d\d/.test(d)) return;
    var o=qs[Math.floor((+d.slice(5,7)-1)/3)];
    o.n++; if(r['Filed?']) o.filed++;
    o.php+=Number(r['Total Income'])||0; o.tax+=Number(r['8% Tax'])||0;
  });
  var p2=function(n){ return (n<10?'0':'')+n; };
  qs.forEach(function(o){
    var start=year+'-'+p2(o.q*3-2)+'-01', end=o.q<4?year+'-'+p2(o.q*3+1)+'-01':(+year+1)+'-01-01';
    o.due=o.q<4?year+'-'+['05','08','11'][o.q-1]+'-15':(+year+1)+'-04-15';
    o.current=today>=start&&today<end;
    o.opens=start;
    o.state=today<start?'future':(o.n&&o.filed===o.n)?'filed':o.n?'due':'empty';
  });
  return qs;
}
function taxTile(q){
  var badge={filed:['pos','Filed'],due:['warn','Due '+dayMonth(q.due,{short:1})]}[q.state];
  var sal=q.n+' salar'+(q.n===1?'y':'ies');
  var spec=q.n?{title:'Q'+q.q+' tax',text:'Each salary at its BSP rate, then 8% of the total.',
    rows:[['Income, '+sal,money(q.php,true)],['= Tax at 8%',money(q.tax,true),true]],
    note:q.q===4?'Q4 goes on the annual return.':'Filed means every salary in the quarter has a Filed quarter.'}:null;
  var t=sumTile('tax-t'+(q.state==='due'?' ring':''),'Q'+q.q+(q.current?' so far':''),
    badge?'<span class="pill '+badge[0]+'">'+badge[1]+'</span>':null,spec);
  t.appendChild(el('div','fig',q.state==='future'?'—':money(q.php,true)));
  t.appendChild(el('div','tile-foot',q.state==='future'?'Opens '+dayMonth(q.opens):q.n?'Tax '+money(q.tax,true)+' · '+sal:'No salaries'));
  return t;
}

/* Salary transactions no ledger row points at yet. Adding one writes ONLY the link;
 * every figure on the row derives from it, so the BSP rate is all that is left to type. */
function unlinkedBanner(list, ctx){
  var n=list.length, b=el('section','tax-warn');
  var one=function(t){ return esc(moneyCur(t.Amount,t.Currency))+' on '+esc(dayMonth(String(t.Date).slice(0,10))); };
  b.innerHTML=icon('info')+'<span class="grow"><b>'+n+' salar'+(n===1?'y is':'ies are')+' not in the tax ledger.</b> '+
    (n===1?esc(list[0].Description||'Salary')+', '+one(list[0])+'.':list.map(one).join(' · '))+'</span>';
  var add=el('button','btn sm','Add to ledger'); add.type='button';
  add.onclick=function(){
    add.disabled=true; add.textContent='Adding…';
    var link=ctx.edit[ctx.txIdCol];
    list.reduce(function(p,t){ return p.then(function(){ var row={}; row[link]=t.ID;
      return gs('api_insertTableRow',{table:ctx.table, row:row}); }); },Promise.resolve())
      .then(function(){ toast(n===1?'Added to the ledger':n+' added to the ledger','ok'); })
      .catch(function(e){ toast(e.message||e,'err'); })
      .then(function(){ dropCache(); renderTax(); });
  };
  b.appendChild(add);
  return b;
}

/* Reading order for the Tax table — the sheet's own column order is the owner's
 * business, so this only reorders the display. Anything not listed (a hand-added
 * Ledger column) keeps its sheet position, after these. */
var LEDGER_COL_ORDER=['Date Received','Reporting Period','Filed?','Wise Amount',
                      'BSP Reference Rate','Total Income','8% Tax','Transaction ID'];
function ledgerCols(cols){
  var rank=function(c){ var i=LEDGER_COL_ORDER.indexOf(c); return i<0?LEDGER_COL_ORDER.length:i; };
  return cols.slice().sort(function(a,b){ return rank(a)-rank(b) || cols.indexOf(a)-cols.indexOf(b); });
}
function isFiledCol(c){ return /^filed/i.test(c); }
/* The current BIR quarter back to 2026-Q1 (the ledger starts there — nothing was
 * filed before), newest first. `keep` is the cell's existing value: an out-of-range
 * quarter (or a legacy TRUE) is prepended rather than silently dropped. */
var LEDGER_FIRST_YEAR=2026;
function quarterOptions(keep){
  var d=new Date(), y=d.getFullYear(), q=Math.floor(d.getMonth()/3)+1, out=[];
  while(y>=LEDGER_FIRST_YEAR){ out.push(y+'-Q'+q); if(--q===0){ q=4; y--; } }
  if(keep && out.indexOf(keep)<0) out.unshift(keep);
  return out;
}
/* Tax-year picker. Same native-select reasoning as quarterSelect below. */
function ledgerYearSelect(cur, years){
  var now=String(new Date().getFullYear()), list=(years||[]).slice();
  if(list.indexOf(now)<0) list.unshift(now);
  if(cur && list.indexOf(String(cur))<0) list.unshift(String(cur));
  var s=el('select','q-select');
  list.forEach(function(y){ var o=el('option',null,esc(y)); o.value=y; s.appendChild(o); });
  s.value=String(cur||now);
  s.onchange=function(){ S.taxYear=s.value; renderTax(); };
  return s;
}
/* Filed? picker — a dozen fixed options, so a native <select>, not the fuzzy combobox. */
function quarterSelect(val, onPick){
  var cur=(val==null?'':String(val)), s=el('select','q-select');
  var blank=el('option',null,'—'); blank.value=''; s.appendChild(blank);
  quarterOptions(cur).forEach(function(q){ var o=el('option',null,esc(q)); o.value=q; s.appendChild(o); });
  s.value=cur;
  if(onPick) s.onchange=function(){ onPick(s.value); };
  return s;
}
/* Date-ish column → native date picker in the add-row modal. su_dateStr_ already
 * hands dates back as yyyy-MM-dd, the same value <input type="date"> produces, and
 * Sheets parses that ISO string straight into a real date on setValue. */
function isDateCol(c){ return /date/i.test(c); }
/* Display only — the inline editor still gets the raw cell value. The rate keeps
 * its precision; Wise Amount is the payslip in dollars. */
var LEDGER_LABEL={'Date Received':'Received','Reporting Period':'Month','Filed?':'Filed in','Wise Amount':'USD',
  'BSP Reference Rate':'BSP rate','Total Income':'PHP','8% Tax':'8% tax','Transaction ID':'Transaction'};
var LEDGER_NUM={'Wise Amount':1,'BSP Reference Rate':1,'Total Income':1,'8% Tax':1};
function ledgerText(col,val){
  if(val==null||val==='') return '';
  if(typeof val==='number') return col==='Wise Amount'?moneyCur(val,'USD'):/rate/i.test(col)?String(val):money(val);
  if(col==='Date Received'&&/^\d{4}-\d\d-\d\d$/.test(val)) return dayMonth(val,{short:1,year:'auto'});
  if(col==='Reporting Period') return monthLabel(val);
  return String(val);
}
/* A Transaction ID that opens that transaction's edit modal. */
function txLinkEl(id){
  var a=el('a','tx-link',esc(id)); a.href='#'; a.title='Open transaction';
  a.onclick=function(e){ e.preventDefault(); openTxById(id); };
  return a;
}
/* One ledger <tr>. Split out of renderTax so a cell edit repaints just this row —
 * editing several cells in a row used to reload the whole screen each time.
 * ponytail: the row is rebuilt, not diffed, and rows aren't re-sorted after an
 * edit (only an empty Transaction ID can move a row; re-open the screen for that). */
function ledgerRowTr(r, ctx){
  var tr=el('tr');
  ctx.cols.forEach(function(c){
    var td=el('td'), val=r[c];
    // The link column opens the transaction instead of editing the ID; an empty
    // one stays editable so a legacy row can still be linked by hand.
    if(c===ctx.txIdCol && val!=null && val!==''){ td.appendChild(txLinkEl(String(val))); }
    else if(ctx.derived[c]){ td.textContent=ledgerText(c,val); if(LEDGER_NUM[c]) td.className='num'; if(/^⚠/.test(String(val))){ td.className='warn'; td.textContent='Transaction deleted'; } }
    else if(isFiledCol(c)){
      var q=quarterSelect(val, function(v){ ledgerSaveCell(ctx, r, c, v); });
      q.classList.add('q-pill'); if(val) q.classList.add('on');
      td.appendChild(q);
    }
    else {
      // A typed cell looks like a field, so it reads as the one thing to fill in.
      td.className='ed-cell'+(LEDGER_NUM[c]?' num':''); td.title='Tap to edit';
      td.innerHTML='<span class="typed'+(val===''||val==null?' empty':'')+'">'+esc(ledgerText(c,val)||'Type')+'</span>';
      td.onclick=function(){ ledgerCellEdit(td, tr, r, ctx, c); };
    }
    tr.appendChild(td);
  });
  var dtd=el('td'), del=el('button','icon-btn',icon('close')); del.type='button'; del.title='Delete row'; del.setAttribute('aria-label','Delete row');
  del.onclick=function(){ ledgerDeleteRow(ctx, r.__row); };
  dtd.appendChild(del); tr.appendChild(dtd);
  return tr;
}
function ledgerReplaceRow(tr, r, ctx){ tr.parentNode.replaceChild(ledgerRowTr(r,ctx), tr); }

/* Save one cell, named by the sheet-era header the table shows; ctx.edit maps it to the
 * db column. A saved cell can move the DERIVED ones with it (8% Tax follows the BSP
 * rate), so the screen is redrawn rather than the single row — getLedger is one ETag'd
 * read of a table that holds one row per payslip. */
function ledgerSaveCell(ctx, r, header, value){
  return gs('api_updateTableCell',{table:ctx.table, pk:r.__row, column:ctx.edit[header], value:value})
    .then(function(){ toast('Saved','ok'); dropCache(); renderTax(); },
          function(e){ toast(e.message||e,'err'); throw e; });
}

function ledgerCellEdit(td, tr, r, ctx, header){
  cellEdit(td, r[header], { num:!!LEDGER_NUM[header],
    restore:function(){ ledgerReplaceRow(tr,r,ctx); },
    save:function(v){ return ledgerSaveCell(ctx, r, header, v); } });
}

function openLedgerAdd(ctx){
  // A <select> reads through .value like an input, so the Filed? quarter fits the
  // same shape. Derived columns are left out — they fill themselves from the view.
  var fields=ctx.cols.filter(function(c){ return !ctx.derived[c]; }).map(function(c){
    return [c, isFiledCol(c)?quarterSelect(''):inputEl(isDateCol(c)?'date':'text','')];
  });
  gridAddRow('Add a row to the tax ledger', fields, function(obj){
    var row={};
    Object.keys(obj).forEach(function(h){ if(ctx.edit[h]) row[ctx.edit[h]]=obj[h]; });
    return gs('api_insertTableRow',{table:ctx.table, row:row});
  }, renderTax);
}

function ledgerDeleteRow(ctx, row){
  gridDeleteRow('Delete this ledger row?',
    'The row leaves the tax ledger. The salary transaction stays.',
    function(){ return gs('api_deleteTableRow',{table:ctx.table, pk:row}); }, renderTax);
}

/* ════════════════════════════════════════════════════════════════════════
 *  SWAP (screen key `exchange`, v3 Phase 6) — a fair USD↔PHP rate with a
 *  friend. Both of you would otherwise pay Wise, and the two routes carry
 *  DIFFERENT fees, so each is the amount Wise quotes (yours in $, theirs in ₱).
 *  swapCalc holds the maths. At the mid-market rate each of you keeps your own
 *  avoided fee. Defaults are a sample Wise quote ($3.68 out, ₱154.83 in).
 * ════════════════════════════════════════════════════════════════════════ */
function renderExchange(){
  if(needBoot('table', renderExchange)) return;
  var w=el('div','screen');
  w.appendChild(el('div','screen-head','<div class="screen-title">Swap</div>'));
  w.appendChild(el('div','screen-sub','A fair USD ↔ PHP rate with a friend'));
  var rate0=(S.boot.fxUsdPhp>0)?Number(S.boot.fxUsdPhp).toFixed(4):'';
  var g=el('div','sw'), inCard=el('section','tile sw-in'), out=el('div','sw-out');
  [['exAmt','Dollars you give','USD','1000'],['exRate','Mid-market rate','Live · tap to change',rate0],
   ['exFeeYou','Your Wise fee','USD → PHP, in $','3.68'],['exFeeBro','Their Wise fee','PHP → USD, in ₱','154.83']].forEach(function(f){
    var l=el('label','sw-f','<span><span class="sw-k">'+f[1]+'</span><span class="sw-s">'+f[2]+'</span></span>');
    var i=inputEl('text',f[3]); i.id=f[0]; i.inputMode='decimal'; i.autocomplete='off'; l.appendChild(i); inCard.appendChild(l);
  });
  var sp=el('div','sw-split','<div class="sw-sh"><span>Your share of the saving</span><b id="exSplitLbl">50%</b></div>'+
    '<input id="exSplit" type="range" min="0" max="100" step="5" value="50" aria-label="Your share of the saving">');
  inCard.appendChild(sp);
  g.appendChild(inCard); g.appendChild(out); w.appendChild(g);
  paint(w);
  ['exAmt','exRate','exFeeYou','exFeeBro','exSplit'].forEach(function(id){ $('#'+id).addEventListener('input', exCalc); });
  exCalc();
}

/* The pure part of the swap (tested in test.js). Wise takes its fee from the SOURCE
 * and converts the rest at mid, so your floor = (usd − feeYou) × mid and their
 * ceiling = usd × mid + feeThem. Trading direct saves both fees; `split` is your
 * share of that pot. */
function swapCalc(usd, mid, feeYouUsd, feeThemPhp, split){
  var floor=(usd-feeYouUsd)*mid, ceil=usd*mid+feeThemPhp, pot=ceil-floor, deal=floor+split/100*pot;
  return {floor:floor, ceil:ceil, pot:pot, deal:deal, rate:deal/usd, youSave:deal-floor, theySave:ceil-deal};
}
function exNum(id){ return parseFloat(String($('#'+id).value).replace(/[,\s$₱]/g,''))||0; }

function exCalc(){
  var usd=exNum('exAmt'), mid=exNum('exRate'), fy=exNum('exFeeYou'), ft=exNum('exFeeBro'), split=exNum('exSplit');
  $('#exSplitLbl').textContent=split+'%';
  $('#exSplit').style.setProperty('--v',split+'%');
  var out=$('.sw-out');
  if(!(usd>0)||!(mid>0)){ out.innerHTML='<div class="tile"><div class="tile-foot">Type the dollars and a rate.</div></div>'; return; }
  var c=swapCalc(usd,mid,fy,ft,split), span=c.ceil-c.floor;
  var at=function(v){ return span>0?Math.max(0,Math.min(100,100*(v-c.floor)/span)):50; };
  var r2=function(n){ return '₱'+num(Math.round(n/usd*100)/100); };
  out.innerHTML='';
  var h=sumTile('sw-hero','They send you',null,{title:'How the fair rate is set',
    text:'Each of you would pay Wise a fee. Trading direct saves both fees, and the slider splits that saving.',
    rows:[['Wise pays you',money(c.floor)],['Wise costs them',money(c.ceil)],['Saving (both fees)',money(c.pot)],
          ['Your share',split+'%'],['= They send you',money(c.deal),true]],
    note:'Wise takes its fee from the money it converts, then uses the mid-market rate.'});
  h.insertAdjacentHTML('beforeend','<div class="fig-row"><span class="fig-hero">'+money(c.deal)+'</span><span class="fig-sub">for '+moneyCur(usd,'USD')+'</span></div>'+
    '<div class="sw-rate">Fair rate '+r2(c.deal)+' per $1</div>'+
    '<div class="sw-range"><span class="sw-lo">Wise pays you '+r2(c.floor)+'</span><span class="sw-hi">Wise costs them '+r2(c.ceil)+'</span>'+
      '<div class="sw-bar"><i class="sw-mid" style="left:'+at(usd*mid)+'%"></i><b style="left:'+at(c.deal)+'%"></b></div>'+
      '<span class="sw-fair" style="left:'+at(c.deal)+'%">Fair '+r2(c.deal)+'</span></div>'+
    '<div class="tile-foot">Any rate inside the bar beats Wise for you both. The white mark is the mid-market rate, '+r2(usd*mid)+'.</div>');
  out.appendChild(h);
  var pair=el('div','sw-pair');
  [['You save',c.youSave,'Your '+split+'% of '+money(c.pot)],['They save',c.theySave,'Their '+(100-split)+'% of '+money(c.pot)]].forEach(function(s){
    var t=sumTile('','' +s[0]); t.appendChild(el('div','fig pos',money(s[1]))); t.appendChild(el('div','tile-foot',s[2])); pair.appendChild(t);
  });
  out.appendChild(pair);
  var rec=el('button','btn primary sw-rec','Record this swap'); rec.type='button';
  rec.onclick=function(){ openTransferModal(swapDraft(usd,c.deal)); };
  out.appendChild(rec);
}

/* The transfer the swap books: USD out of a dollar account, pesos into a peso one.
 * ToAmount/Amount is then the fair rate, and the implied-rate rule stamps it. */
function swapDraft(usd, php){
  var accs=(S.boot.accounts||[]).filter(function(a){ return !a.isShares&&!a.isLiability&&!isRecv(a); });
  var big=function(l){ return l.sort(function(a,b){ return (b.balancePhp||0)-(a.balancePhp||0); })[0]; };
  var from=big(accs.filter(function(a){ return a.currency==='USD'; }));
  var last=prefGet('lastAcct'), to=accs.filter(function(a){ return a.name===last&&(a.currency||'PHP')==='PHP'; })[0]||
    big(accs.filter(function(a){ return (a.currency||'PHP')==='PHP'; }));
  return {Date:newTxDate(), Amount:Math.round(usd*100)/100, ToAmount:Math.round(php*100)/100, Account:from?from.name:'', ToAccount:to?to.name:'', Description:'USD swap'};
}

/* ════════════════════════════════════════════════════════════════════════
 *  ADMIN — a generic CRUD grid over the server-side table whitelist.
 *
 *  The Sheet used to be the admin UI: adding a category, retiring an account,
 *  correcting a budget target or typing a BSP rate were all "open the tab and
 *  edit the cell". D1 has no such tab, so this is it. Deliberately generic and
 *  deliberately dumb — the server decides which tables exist and which columns
 *  are writable (TABLES in worker/src/api.js), and this screen just renders
 *  whatever it is told. There is no SQL console: anything this cannot express is
 *  `wrangler d1 execute` from the owner's machine.
 *
 *  `transactions` is listed but read-only apart from delete: it has real handlers
 *  with validation, FX stamping and version bumping, and this grid must not be a
 *  way around them.
 * ════════════════════════════════════════════════════════════════════════ */
/* Which tables exist is the server's fact, not ours: listTable ships `tables` (TABLES
   order) and the picker below is drawn from it, so adding one server-side makes its
   button appear and removing one takes the button with it. 'accounts' is only the
   landing table — the one name we need before we can ask the first question. */
function adminTable(){ return S.admin.table||'accounts'; }

/* One page, not the whole table. 500 rows of `transactions` was a few hundred KB down
   a phone connection to look at the first screenful, and it TRUNCATED anyway — the grid
   just said "showing the first 500". Same 50 as the Transactions screen, same pager, and
   the ✓ CSV button below pays for the full table only when you actually ask for it. */
var ADMIN_PAGE = 50;

// Picker labels. The server owns WHICH tables exist (listTable.tables); a table
// missing here shows its own name.
var ADMIN_LABEL={accounts:'Accounts',categories:'Categories',account_types:'Account types',budgets:'Budgets',
  recurring:'Recurring',ledger:'Tax ledger',prices:'Prices',nw_snapshots:'Net worth history',meta:'Settings',
  transactions:'Transactions',email_quotes:'Email quotes'};
function adminLabel(t){ return ADMIN_LABEL[t]||t; }

function renderAdmin(){
  var t=adminTable(), off=S.admin.offset||0;
  var key='table|'+t+'|'+off;
  if(!S.cache[key]) loading('table');
  return cachedCall(key, function(et){ return gs('api_listTable',{table:t,limit:ADMIN_PAGE,offset:off},et); }, function(res){
    var w=el('div','screen');
    w.appendChild(el('div','screen-head','<div class="screen-title">Admin</div>'));
    w.appendChild(el('div','screen-sub','Edit the tables behind the app'));

    var bar=el('div','adm-bar'), pick=el('div','seg adm-seg');
    (res.tables||[]).forEach(function(name){
      var b=el('button',name===t?'on':'',esc(adminLabel(name))); b.type='button'; b.setAttribute('aria-pressed',name===t);
      b.onclick=function(){ S.admin.table=name; S.admin.offset=0; try{localStorage.setItem('mm.adminTable',name);}catch(e){} render(); };
      pick.appendChild(b);
    });
    bar.appendChild(pick);
    var actions=el('div','btn-row');
    var csv=el('button','btn sm','Export CSV'); csv.type='button';
    // The visible page is 50 rows; a backup file of 50 rows would be a lie. Pull every
    // page first (listTable caps a request at 1000), so the file is the whole table.
    csv.onclick=function(){
      csv.disabled=true; csv.textContent='Exporting…';
      adminFetchAll(t).then(function(all){ downloadCsv(t+'.csv', res.cols, all); })
        .catch(function(e){ toast(e.message||e,'err'); })
        .then(function(){ csv.disabled=false; csv.textContent='Export CSV'; });
    };
    actions.appendChild(csv);
    if((res.addable||[]).length){
      var add=el('button','btn sm primary','Add row'); add.type='button';
      add.onclick=function(){ adminAddRow(res); };
      actions.appendChild(add);
    }
    bar.appendChild(actions);
    w.appendChild(bar);
    requestAnimationFrame(function(){ var on=$('.adm-seg .on'); if(on) on.scrollIntoView({block:'nearest',inline:'nearest'}); });

    var editable={}; (res.editable||[]).forEach(function(c){ editable[c]=true; });
    var money={}; (res.money||[]).forEach(function(c){ money[c]=true; });
    var ro=!(res.editable||[]).length;
    var card=el('section','tile adm-tbl');
    if(!res.rows.length){ card.appendChild(el('div','tile-foot','No rows.')); }
    else {
      var wrap=el('div','tbl-wrap'), tbl=el('table','tbl'), htr=el('tr');
      // A locked column is one the grid cannot edit on a table that is otherwise
      // editable: the key other tables point at, or a derived field.
      res.cols.forEach(function(c){
        var th=el('th',money[c]?'num':null,esc(c)+(money[c]?' <span class="dim">₱</span>':''));
        if(!ro&&!editable[c]){ th.insertAdjacentHTML('beforeend',icon('lock')); th.title='Locked'; }
        htr.appendChild(th);
      });
      htr.appendChild(el('th'));
      var thead=el('thead'); thead.appendChild(htr); tbl.appendChild(thead);
      var tb=el('tbody');
      res.rows.forEach(function(row){ tb.appendChild(adminRowTr(row,res,editable,money)); });
      tbl.appendChild(tb); wrap.appendChild(tbl); card.appendChild(wrap);
    }
    var foot=el('div','adm-foot');
    foot.appendChild(el('span',null,ro?'This table is read-only.':'Click a cell to edit it. Locked columns are keys other tables point at, or derived.'));
    foot.appendChild(pagerEl(off,ADMIN_PAGE,res.total,function(o){ S.admin.offset=o; render(); }));
    card.appendChild(foot);
    w.appendChild(card);
    if(S.boot) w.appendChild(widgetPicker(S.boot.accounts||[]));
    paint(w);
  }).catch(showErr);
}

function adminRowTr(row,res,editable,money){
  var tr=el('tr');
  res.cols.forEach(function(c){
    var td=el('td',money&&money[c]?'num':null,esc(row[c]==null?'':row[c]));
    if(editable[c]){
      td.classList.add('ed-cell');
      td.onclick=function(){ adminCellEdit(td,tr,row,res,editable,c,money); };
    } else if((res.editable||[]).length) td.classList.add('dim');
    tr.appendChild(td);
  });
  var del=el('td');
  if(res.deletable!==false){                            // read-only tables (nodelete) show no delete
    var b=el('button','icon-btn',icon('close')); b.type='button'; b.title='Delete row'; b.setAttribute('aria-label','Delete row');
    b.onclick=function(e){ e.stopPropagation(); adminDeleteRow(res,row[res.pk]); };
    del.appendChild(b);
  }
  tr.appendChild(del);
  return tr;
}

function adminCellEdit(td,tr,row,res,editable,col,money){
  function restore(){ tr.parentNode.replaceChild(adminRowTr(row,res,editable,money),tr); }
  cellEdit(td, row[col], { num:!!(money&&money[col]), restore:restore,
    save:function(v){
      return gs('api_updateTableCell',{table:res.table,pk:row[res.pk],column:col,value:v})
        .then(function(){ row[col]=v; toast('Saved','ok'); dropCache(); restore(); },
              function(e){ toast(e.message||e,'err'); throw e; });
    } });
}

function adminAddRow(res){
  gridAddRow('Add a row to '+adminLabel(res.table),
    (res.addable||[]).map(function(c){ return [c, inputEl('text','')]; }),
    function(row){ return gs('api_insertTableRow',{table:res.table, row:row}); }, render);
}

function adminDeleteRow(res,pk){
  gridDeleteRow('Delete row '+pk+' from '+adminLabel(res.table)+'?',
    'This removes the row permanently. D1 Time Travel can restore the database for 7 days.',
    function(){ return gs('api_deleteTableRow',{table:res.table, pk:pk}); }, render);
}

/* ── the shared grid ─────────────────────────────────────────────────────────
 * The Tax screen and the Admin screen are one table UI over one set of write
 * routes (updateTableCell / insertTableRow / deleteTableRow). Until v3.2.0 each
 * carried its own copy of these three, and the ledger half also had three write
 * handlers of its own in api.js — for a table the admin whitelist already held.
 * What genuinely differs is the row shape and what to repaint, so those are
 * arguments; `send` returns the gs() promise in both cases. */

/* Swap the <td> for a text input that fills the cell (.editing drops the td padding,
 * so the row does not jump on edit). `save` owns its own toast and repaint, because
 * the two screens redraw different amounts; a rejected save puts the cell back. */
function cellEdit(td, cur, o){
  var inp=el('input','ledger-edit-input'); inp.type='text';
  if(o.num) inp.inputMode='decimal';
  if(cur!=null) inp.value=String(cur);
  td.classList.add('editing'); td.textContent=''; td.appendChild(inp); inp.focus(); inp.select();
  var done=false;
  function commit(){
    if(done) return; done=true;
    if(inp.value===String(cur==null?'':cur)) return o.restore();   // no-op → put the cell back
    o.save(inp.value).catch(function(){ o.restore(); });
  }
  inp.onblur=commit;
  inp.onkeydown=function(e){
    if(e.key==='Enter'){ e.preventDefault(); commit(); }
    else if(e.key==='Escape'){ done=true; o.restore(); }
  };
}

/* The add-a-row modal. `fields` is [[label, inputNode]]; send({label: value}) writes. */
function gridAddRow(title, fields, send, after){
  var body=el('div'), inputs={};
  fields.forEach(function(f){ inputs[f[0]]=f[1]; body.appendChild(fieldEl(f[0], f[1])); });
  var save=el('button','btn primary','Add row');
  save.onclick=function(){
    var obj={}, any=false;
    Object.keys(inputs).forEach(function(c){ if(inputs[c].value!==''){ obj[c]=inputs[c].value; any=true; } });
    if(!any){ toast('Fill at least one field','err'); return; }
    save.disabled=true; save.textContent='Adding…';
    send(obj).then(function(){ closeModal(); toast('Row added','ok'); dropCache(); after(); },
                   function(e){ save.disabled=false; save.textContent='Add row'; toast(e.message||e,'err'); });
  };
  openModal(modalShell(title, body, [save]));
}

function gridDeleteRow(title, note, send, after){
  var yes=el('button','btn danger','Delete');
  yes.onclick=function(){
    yes.disabled=true; yes.textContent='Deleting…';
    send().then(function(){ closeModal(); toast('Row deleted','ok'); dropCache(); after(); },
                function(e){ yes.disabled=false; yes.textContent='Delete'; toast(e.message||e,'err'); });
  };
  var no=el('button','btn','Cancel'); no.onclick=closeModal;
  openModal(modalShell(title, el('div','dim',note), [no,yes]));
}

/* Every row of a table, one 1000-row page at a time (listTable's server-side cap).
   Only the CSV export needs this — the grid itself never holds more than one page. */
function adminFetchAll(t){
  var all=[];
  function page(off){
    return gs('api_listTable',{table:t,limit:1000,offset:off}).then(function(r){
      all=all.concat(r.rows||[]);
      return (all.length<r.total && r.rows && r.rows.length) ? page(off+r.rows.length) : all;
    });
  }
  return page(0);
}

/* Backup layer 2b: the table you are looking at, as a file. (Layer 1 is the nightly
 * Apps Script pull of getExportAll into a spreadsheet; layer 3 is D1 Time Travel.) */
function downloadCsv(name, cols, rows){
  var cell=function(v){ var s=v==null?'':String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  var out=[cols.map(cell).join(',')].concat(rows.map(function(r){
    return cols.map(function(c){ return cell(r[c]); }).join(',');
  })).join('\n');
  var url=URL.createObjectURL(new Blob([out],{type:'text/csv'}));
  var a=el('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); },1000);
}

/* One pager for Activity and Admin: "1–50 of 312", then Previous and Next. */
function pagerEl(off,size,total,go){
  var pg=el('div','pager');
  pg.appendChild(el('span',null,total?(off+1)+'–'+Math.min(off+size,total)+' of '+total:'No rows'));
  if(total>size) [['Previous',Math.max(0,off-size),off<=0],['Next',off+size,off+size>=total]].forEach(function(p){
    var b=el('button','link-btn',p[0]); b.type='button'; b.disabled=p[2]; b.onclick=function(){ go(p[1]); }; pg.appendChild(b);
  });
  return pg;
}

/* —— inline single-field edit (Category / Account / Description / Amount) —— */
// Plain text/number input editor (Description, Amount). Commits on Enter or blur,
// cancels on Escape. The `done` guard stops the blur firing a second commit after
// Enter (which reloads the list and tears the input down).
function inlineInput(host, type, value, onPick){
  host.innerHTML=''; host.onclick=null;
  var inp=el('input','inline-edit-input'); inp.type=type||'text';
  if(type==='number') inp.step='0.01';
  if(value!=null && value!=='') inp.value=value;
  var done=false;
  function commit(){ if(done) return; done=true; onPick(inp.value); }
  inp.onkeydown=function(e){
    if(e.key==='Enter'){ e.preventDefault(); commit(); }
    else if(e.key==='Escape'){ done=true; renderTxList(); }
  };
  inp.onblur=function(){ commit(); };
  host.appendChild(inp); inp.focus(); inp.select();
}
function editableSpan(html, onEdit){
  var s=el('span','ed'); s.innerHTML=html;
  s.onclick=function(e){ e.stopPropagation(); onEdit(s); };
  return s;
}
function inlineCombo(host, options, value, onPick){
  host.innerHTML=''; host.onclick=null;
  // .t2 clips with overflow:hidden — relax it so the dropdown can escape the row.
  var t2=host.parentNode; if(t2&&t2.classList&&t2.classList.contains('t2')){ t2.style.overflow='visible'; t2.style.whiteSpace='normal'; }
  var combo=comboEl(options, value||'', {placeholder:'…'});
  combo.classList.add('inline-edit');
  combo.onchange=function(){ if(combo.value) onPick(combo.value); };
  host.appendChild(combo);
  var inp=combo.querySelector('.combo-input'); if(inp){ inp.focus(); inp.select(); }
}
function commitInline(t, field, val){
  var patch={ID:t.ID};
  if(field==='Amount'){
    var n=parseFloat(val);
    if(isNaN(n)){ toast('Enter an amount','err'); renderTxList(); return; }
    if(n===Number(t.Amount)){ renderTxList(); return; }            // no-op
    patch.Amount=n;
  } else {
    var cur=(t[field]==null?'':String(t[field]));
    if(String(val)===cur){ renderTxList(); return; }           // no-op → restore the row
    patch[field]=val;
  }
  // Optimistic: the row keeps its place showing the NEW value as loading; the reload
  // that reconciles it only runs once the server has agreed.
  S.tx.pendingEdits[t.ID]=patch; renderTxList();
  gs('api_updateTransaction', patch).then(function(){
    delete S.tx.pendingEdits[t.ID]; toast(field+' updated','ok'); afterMutation();
  }).catch(function(e){
    delete S.tx.pendingEdits[t.ID]; toast(e.message||e,'err'); renderTxList();
  });
}

/* —— selection + bulk bar —— */
function toggleSel(id,on){ if(on) S.tx.sel[id]=true; else delete S.tx.sel[id]; updateBulkBar(); }
function selCount(){ return Object.keys(S.tx.sel).length; }
function bulkSelectedIds(){ return Object.keys(S.tx.sel); }
function clearSel(){ S.tx.sel={}; }

// The floating bulk bar: "N selected · net", then the actions, Delete last.
function updateBulkBar(){
  var bar=$('#bulkBar'); if(!bar) return;
  var n=selCount();
  bar.hidden=!n; bar.innerHTML=''; if(!n) return;
  // A transfer nets to 0, so it shows as its own "moved" figure instead.
  var net=0, moved=0;
  (S.tx.rows||[]).forEach(function(t){ if(!S.tx.sel[t.ID]) return; if(txIsXfer(t)) moved+=Math.abs(Number(t['Amount (PHP)'])||0); else net+=txNet(t); });
  bar.appendChild(el('span','bulk-count',n+' selected'+(Math.round(net)?' · '+fmtNet(net):'')+(Math.round(moved)?' · '+money(moved,true)+' moved':'')));
  function add(label,cls,fn){ var b=el('button',cls,label); b.type='button'; b.onclick=fn; bar.appendChild(b); return b; }
  add('Category','',openBulkRecat);
  add('Account','',openBulkReassign);
  add('Date','',openBulkDate);
  add('Delete','del',openBulkDelete);
  add(icon('close'),'x',function(){ clearSel(); renderTxList(); }).setAttribute('aria-label','Clear the selection');
}

function bulkApply(patch){
  var ids=bulkSelectedIds(); if(!ids.length) return;
  // Optimistic: every picked row shows the patched value as loading straight away.
  ids.forEach(function(id){ S.tx.pendingEdits[id]=patch; });
  closeModal(); clearSel(); renderTxList();
  function done(){ ids.forEach(function(id){ delete S.tx.pendingEdits[id]; }); }
  gs('api_bulkUpdateTransactions',{ids:ids, patch:patch}).then(function(res){
    done();
    toast('Updated '+res.updated+((res.skipped&&res.skipped.length)?(' · '+res.skipped.length+' skipped'):''),'ok');
    afterMutation();
  }).catch(function(e){ done(); toast(e.message||e,'err'); renderTxList(); });
}
function openBulkRecat(){
  withBoot(function(){
    var picked=(S.tx.rows||[]).filter(function(t){return S.tx.sel[t.ID];});
    var anyXfer=picked.some(txIsXfer), anyReg=picked.some(function(t){return !txIsXfer(t);});
    if(anyXfer&&anyReg){ // a single category can't be valid for both shapes
      openModal(modalShell('Recategorize '+selCount()+' transactions',
        el('div','dim','Selection mixes transfers and regular transactions — recategorize them separately so a Transfer category never lands on a regular row (or vice versa).'),
        []));
      return;
    }
    var c=comboEl(catsForShape(anyXfer),'',{placeholder:'Select category'});
    var save=el('button','btn primary','Apply to '+selCount());
    save.onclick=function(){ if(!c.value){toast('Pick a category','err');return;} bulkApply({Category:c.value}); };
    openModal(modalShell('Recategorize '+selCount()+' transactions', fieldEl('New category',c), [save]));
  });
}
function openBulkReassign(){
  withBoot(function(){
    var c=comboEl(acctOptions(),'',{placeholder:'Select account'});
    var save=el('button','btn primary','Apply to '+selCount());
    save.onclick=function(){ if(!c.value){toast('Pick an account','err');return;} bulkApply({Account:c.value}); };
    openModal(modalShell('Reassign '+selCount()+' transactions', fieldEl('New account',c), [save]));
  });
}
function openBulkDate(){
  var d=inputEl('date', isoDate(new Date()));
  var save=el('button','btn primary','Apply to '+selCount());
  save.onclick=function(){ if(!d.value){toast('Pick a date','err');return;} bulkApply({Date:d.value}); };
  openModal(modalShell('Set date on '+selCount()+' transactions', fieldEl('New date',d), [save]));
}
function openBulkDelete(){
  var body=el('div','dim','You cannot undo this.');
  var yes=el('button','btn danger','Delete '+selCount());
  yes.onclick=function(){
    // Optimistic: the rows stay on screen as loading until the backend confirms.
    var ids=bulkSelectedIds();
    ids.forEach(function(id){ S.tx.pendingDeletes[id]=true; });
    closeModal(); clearSel(); renderTxList();
    function done(){ ids.forEach(function(id){ delete S.tx.pendingDeletes[id]; }); }
    gs('api_bulkDeleteTransactions',{ids:ids}).then(function(res){
      done(); toast('Deleted '+res.deleted,'ok'); afterMutation();
    }).catch(function(e){ done(); toast(e.message||e,'err'); renderTxList(); });
  };
  var no=el('button','btn','Cancel'); no.onclick=closeModal;
  openModal(modalShell('Delete '+selCount()+' transactions?', body, [no,yes]));
}

/* ════════════════════════════════════════════════════════════════════════
 *  MODALS — transaction, transfer, account
 * ════════════════════════════════════════════════════════════════════════ */
// Keep #modalRoot inside the visual viewport (not the full layout viewport) so the iOS
// keyboard doesn't cover the focused field/dropdown — a fixed, centered modal can't scroll otherwise.
function fitModal(){
  var vv=window.visualViewport, root=$('#modalRoot');
  if(!vv||!root||!root.open) return;
  root.style.top=vv.offsetTop+'px'; root.style.height=vv.height+'px';
}
/* Both overlays are <dialog>s opened with showModal(), so the top layer contains focus,
 * Escape raises `cancel`, the page behind goes inert and focus is restored on close —
 * all of which this file used to do by hand, including a walk up the DOM inerting the
 * siblings at each level and a stack of remembered focus. The top layer also STACKS,
 * which is what the stack was for: the unlock dialog opens over the editor on a lapsed
 * cookie, and the editor is still trapped when that dialog closes. */

// opts.sheet: a bottom sheet on a phone (app.css), a centred card from 768px.
function openModal(node, opts){
  var root=$('#modalRoot'); var card=$('#modalCard');
  closeModal.onClose=null;
  root.classList.toggle('as-sheet', !!(opts&&opts.sheet));
  card.innerHTML=''; card.appendChild(node);
  if(!root.open) root.showModal();
  if(window.visualViewport){ visualViewport.addEventListener('resize',fitModal); visualViewport.addEventListener('scroll',fitModal); fitModal(); }
  // The dialog element IS the full-viewport host and the card is its child, so a click
  // that lands on the dialog itself is a click on the backdrop.
  root.onclick=function(e){ if(e.target===root) closeModal(); };
  // Escape. preventDefault stops the UA closing it behind our back, so the bookkeeping
  // in closeModal runs exactly once whichever way it is dismissed. An open combo eats
  // the key first (comboEl calls preventDefault while its list is up).
  root.oncancel=function(e){ e.preventDefault(); closeModal(); };
  // Enter in a plain input submits (combos handle Enter themselves to pick an option)
  card.onkeydown=function(e){
    if(e.key==='Enter' && e.target.tagName==='INPUT' && !e.target.classList.contains('combo-input')){
      e.preventDefault();
      var p=$('.modal-f .btn.primary',card); if(p && !p.disabled) p.click();
    }
  };
}
function closeModal(){
  var root=$('#modalRoot');
  if(root.open) root.close();
  root.style.top=''; root.style.height='';
  if(window.visualViewport){ visualViewport.removeEventListener('resize',fitModal); visualViewport.removeEventListener('scroll',fitModal); }
  // Dismiss hook — the login form needs to know it was cancelled by the backdrop or
  // Escape, not just by its own button, or unlock()'s promise never settles and every
  // later 401 awaits a dead one.
  var f=closeModal.onClose; closeModal.onClose=null; if(f) f();
}

function modalShell(title,bodyNode,footerNodes){
  var c=el('div');
  var h=el('div','modal-h'); h.innerHTML='<h3>'+esc(title)+'</h3>';
  var x=el('button','icon-btn',icon('close')); x.setAttribute('aria-label','Close'); x.onclick=closeModal; h.appendChild(x);
  var b=el('div','modal-b'); b.appendChild(bodyNode);
  var f=el('div','modal-f'); (footerNodes||[]).forEach(function(n){f.appendChild(n);});
  c.appendChild(h); c.appendChild(b); c.appendChild(f);
  return c;
}

function fieldEl(label,inputNode,hint){
  var f=el('div','field');
  f.appendChild(el('label',null,esc(label)));
  f.appendChild(inputNode);
  if(hint) f.appendChild(el('div','hint',esc(hint)));
  return f;
}
function inputEl(type,value,ph){var i=el('input');i.type=type||'text';if(value!=null)i.value=value;if(ph)i.placeholder=ph;return i;}

/* —— fuzzy combobox (searchable replacement for <select>) ——————————————————
 * comboEl(options, value, opts) returns a wrapper element that exposes a `.value`
 * (selected option value) and `.onchange` handler — drop-in for selectEl's API.
 * Options are strings or {value,label}. Typing fuzzy-filters; ↑/↓/Enter navigate.
 */
function fuzzyScore(q,s){              // subsequence match → score (≥0), or -1 (no match)
  q=q.toLowerCase(); s=s.toLowerCase();
  if(!q) return 0;
  var si=0, score=0, streak=0;
  for(var qi=0; qi<q.length; qi++){
    var c=q[qi], found=-1;
    for(var k=si;k<s.length;k++){ if(s[k]===c){found=k;break;} }
    if(found===-1) return -1;
    streak=(found===si)?streak+1:0;
    score += 10 + streak*5 - Math.min(found-si,8);  // reward contiguous + early hits
    si=found+1;
  }
  if(s.indexOf(q)===0) score+=30; else if(s.indexOf(q)!==-1) score+=15; // prefix/substring bonus
  return score;
}
function comboEl(options,value,opts){
  opts=opts||{};
  var items=options.map(function(o){return (typeof o==='object')?{value:String(o.value),label:String(o.label),color:o.color}:{value:String(o),label:String(o)};});
  var wrap=el('div','combo');
  var input=el('input','combo-input'); input.type='text'; input.autocomplete='off'; input.spellcheck=false;
  if(opts.placeholder) input.placeholder=opts.placeholder;
  var list=el('div','combo-list'); list.hidden=true;
  wrap.appendChild(input); wrap.appendChild(list);

  var _value='', _label='', _onchange=null, active=-1, filtered=items.slice();

  function setValue(v){
    var it=items.filter(function(i){return i.value===String(v);})[0];
    _value=it?it.value:''; _label=it?it.label:''; input.value=_label;
  }
  function renderList(q){
    list.innerHTML='';
    if(!q){ filtered=items.slice(); }
    else {
      filtered=items.map(function(it){return {it:it,sc:fuzzyScore(q,it.label)};})
        .filter(function(x){return x.sc>=0;}).sort(function(a,b){return b.sc-a.sc;})
        .map(function(x){return x.it;});
    }
    active=filtered.length?0:-1;
    if(!filtered.length){ list.appendChild(el('div','combo-empty','No match')); return; }
    filtered.forEach(function(it,idx){
      var row=el('div','combo-opt'+(idx===active?' active':'')+(it.value===_value?' sel':''));
      if(isHex6(it.color)){ var dot=el('span','acct-dot'); dot.style.background=it.color; row.appendChild(dot); }
      var lab=el('span','combo-lab'); lab.textContent=it.label; row.appendChild(lab);
      row.onmousedown=function(e){ e.preventDefault(); choose(it); };
      row.onmouseenter=function(){ active=idx; highlight(); };
      list.appendChild(row);
    });
  }
  function highlight(){ Array.prototype.forEach.call(list.children,function(c,i){ c.classList.toggle('active', i===active); }); }
  function scrollActive(){ var c=list.children[active]; if(c&&c.scrollIntoView)c.scrollIntoView({block:'nearest'}); }
  function open(){ renderList(''); list.hidden=false; wrap.classList.add('open');
    // Nudge the dropdown into view so a scrollable modal/keyboard doesn't hide the options (mobile).
    setTimeout(function(){ if(!list.hidden&&list.scrollIntoView) list.scrollIntoView({block:'nearest'}); },0); }
  function close(){ list.hidden=true; wrap.classList.remove('open'); }
  function choose(it){ _value=it.value; _label=it.label; input.value=it.label; close(); if(_onchange)_onchange(); }

  input.onfocus=function(){ input.select(); open(); };
  input.oninput=function(){ renderList(input.value.trim()); list.hidden=false; };
  input.onkeydown=function(e){
    if(e.key==='ArrowDown'){ e.preventDefault(); if(list.hidden){open();} else {active=Math.min(filtered.length-1,active+1);highlight();scrollActive();} }
    else if(e.key==='ArrowUp'){ e.preventDefault(); active=Math.max(0,active-1); highlight(); scrollActive(); }
    else if(e.key==='Enter'){ if(!list.hidden&&active>=0&&filtered[active]){ e.preventDefault(); choose(filtered[active]); } }
    // Escape dismisses the dropdown only — preventDefault is what stops the <dialog>
    // around it treating the same key as a close request. With the list already shut
    // the key is left alone and the modal closes as usual.
    else if(e.key==='Escape'){ if(!list.hidden) e.preventDefault(); close(); input.value=_label; }
  };
  // Strict picker: on blur, snap the text back to the last valid label.
  input.onblur=function(){ setTimeout(function(){ if(input.value!==_label)input.value=_label; close(); },120); };

  Object.defineProperty(wrap,'value',{get:function(){return _value;},set:function(v){setValue(v);},configurable:true});
  Object.defineProperty(wrap,'onchange',{get:function(){return _onchange;},set:function(fn){_onchange=fn;},configurable:true});

  setValue(value==null?'':value);
  return wrap;
}

/* —— remember the last-used account/category so re-entry is a couple of taps ——
 * Most transactions reuse the same handful of accounts; pre-filling the last one
 * (and autofocusing) means a new entry is usually just category + amount. */
function prefGet(k){ try{ return localStorage.getItem('mm.'+k)||''; }catch(e){ return ''; } }
function prefSet(k,v){ try{ if(v) localStorage.setItem('mm.'+k,String(v)); }catch(e){} }
// Amount for a form field: absolute value, blank when there's nothing usable
// (a carried-over draft may hold '' or a half-typed number).
/* The field shows the amount AS STORED, sign and all. It used to show the magnitude,
 * which turned every open-and-save of a refund (a negative expense) into a charge:
 * -95 rendered as 95 and 95 is what went back to the server. */
function amtField(v){ return (v===''||v==null||isNaN(v))?'':v; }

/* —— transaction ⇄ transfer switcher (new rows only) ——————————————————————
 * The add field is the only add path on most screens, so a transfer shouldn't mean a detour
 * to the Transactions screen: this swaps the modal in place, carrying the shared fields.
 * Edits are excluded — an existing row's shape is fixed. */
function typeToggleEl(mode,onSwitch){
  var seg=function(m,label){ return '<button type="button" aria-pressed="'+(m===mode)+'"'+(m===mode?' class="on"':'')+'>'+label+'</button>'; };
  var w=el('div','seg-toggle', seg('tx','Transaction')+seg('xfer','Transfer'));
  w.children[mode==='tx'?1:0].onclick=onSwitch;   // only the inactive half does anything
  return w;
}

/* Fetch one transaction by ID and open its modal — the ?tx= deep link and the
 * Tax screen's Transaction ID links both land here. */
function openTxById(id){
  return gs('api_listTransactions',{id:id,limit:1}).then(function(r){
    var t=(r.transactions||[])[0];
    if(t) openTxModal(t); else toast('That transaction no longer exists.','err');
  }).catch(function(e){ toast(e.message||e,'err'); });
}

/* The optimistic write, shared by the transaction and transfer modals — it is the
   only place money leaves this screen, so it lives once. Close the modal now and
   paint the row as pending; the request finishes in the background and afterMutation
   reloads in place. On failure the pending state is dropped and the modal REOPENS
   with the values intact, because a lost entry is the one outcome worth avoiding.
   A queued (offline) create returns early: the row is backed by the queue now, and
   afterMutation would drop the cache we are about to render it from.
   o = {t, payload, isEdit, create, addedMsg, failMsg, reopen} — the two callers
   differ in nothing else. */
function commitTx(o){
  if(o.isEdit){
    var patch=Object.assign({ID:o.t.ID},o.payload);
    S.tx.pendingEdits[o.t.ID]=patch;
    closeEditor(); toast('Updated','ok'); repaintTxList();
    gs('api_updateTransaction', patch)
      .then(function(){ delete S.tx.pendingEdits[o.t.ID]; afterMutation(); })
      .catch(function(e){ delete S.tx.pendingEdits[o.t.ID]; repaintTxList();
        toast('Update failed — reopening: '+(e.message||e),'err');
        o.reopen(Object.assign({},o.t,o.payload)); });
    return;
  }
  closeEditor(); toast(o.addedMsg,'ok');
  var tmp=pushPendingAdd(o.payload);
  gs(o.create, o.payload)
    .then(function(r){ if(r && r.status==='queued') return;
      // Advisory from the server (unresolved FX, a same-day/amount duplicate). The row
      // landed — this only tells the owner to look, so it never reopens the modal.
      if(r && r.warning) toast(r.warning,'err');
      dropPendingAdd(tmp); afterMutation(); })
    .catch(function(e){ dropPendingAdd(tmp); repaintTxList();
      toast(o.failMsg+' — reopening: '+(e.message||e),'err'); o.reopen(o.payload); });
}

/* ════ The transaction editor: a full-screen page on a phone, a form sheet from 768px ════
 * One page stack in #edRoot: the form, plus a picker page pushed over it for Category,
 * Account and Reports in. The old modal resized itself to the visual viewport while iOS
 * scrolled to the focused field, and the two fought (the modal jumped). Here nothing moves
 * for the keyboard: --kb (its height) only pads the bottom, and the text fields sit at the
 * top of the form, above where the keyboard lands. */
var ED={root:null, card:null, pages:[], t:0};
function edRoot(){
  if(ED.root) return ED.root;
  var r=el('dialog','ed-root');
  r.innerHTML='<div class="ed-card"></div>';
  // Held by reference, never found by position: toastRoot() parks #toastRoot inside
  // this dialog, and as its lastChild it once took the card's place — the next form
  // mounted in the untappable toast strip while the card still showed the last one.
  ED.card=r.firstChild;
  // The dialog is the full-viewport host; a click on it rather than on the card is a
  // click on the backdrop. Escape does the same thing the backdrop does — see popPage.
  r.onclick=function(e){ if(e.target===r) closeEditor(); };
  r.oncancel=edCancel;
  document.body.appendChild(r);
  if(window.visualViewport){
    var fit=function(){ var vv=visualViewport; r.style.setProperty('--kb',Math.max(0,Math.round(innerHeight-vv.height-vv.offsetTop))+'px'); };
    visualViewport.addEventListener('resize',fit); fit();
  }
  return ED.root=r;
}
function edOpen(){ return !!(ED.root&&ED.root.open&&ED.pages.length); }
// Show a form page. Already open (the Transaction ⇄ Transfer switch): swap in place.
function openEditor(page){
  var r=edRoot(), card=ED.card, fresh=!edOpen();
  clearTimeout(ED.t);
  card.innerHTML=''; card.appendChild(page); ED.pages=[page];
  // Only on a fresh open: the Transaction ⇄ Transfer switch re-enters here with the
  // editor already up, and showModal() on an open dialog throws.
  // Still open inside the 300ms close animation (a fast refusal reopening the form):
  // the timeout is cleared above, and showModal() on an open dialog would throw.
  if(fresh){ r.classList.remove('in','out'); if(!r.open) r.showModal(); void card.offsetWidth; r.classList.add('in'); }
}
/* The exit animation runs while the dialog is still open — close() would drop it out
 * of the top layer at once and there would be nothing left to animate. */
function closeEditor(){
  var r=ED.root; if(!edOpen()) return;
  if(document.activeElement&&r.contains(document.activeElement)) document.activeElement.blur();
  ED.pages=[]; r.classList.add('out');
  ED.t=setTimeout(function(){ r.close(); r.classList.remove('in','out'); ED.card.innerHTML=''; },300);
}
function pushPage(p){ p.classList.add('push'); ED.card.appendChild(p); ED.pages.push(p); }
function popPage(){
  if(ED.pages.length<2) return closeEditor();
  var p=ED.pages.pop(); p.classList.add('pop');
  setTimeout(function(){ p.remove(); },300);
}
/* Escape backs out one page, and closes the editor on the last one — the same thing
 * the ‹ button and a backdrop click do. preventDefault keeps the UA from closing the
 * dialog behind popPage's back, so the exit animation and ED.pages stay in step. */
function edCancel(e){ e.preventDefault(); popPage(); }

// A page: [left] title [right] in a bar, then the scroller (page.body).
function edPage(title,left,right){
  var p=el('div','ed-page'), bar=el('div','ed-bar'), sc=el('div','ed-scroll');
  bar.appendChild(left||el('span')); bar.appendChild(el('div','ed-title',esc(title))); bar.appendChild(right||el('span'));
  p.appendChild(bar); p.appendChild(sc); p.body=sc; return p;
}
function barBtn(label,cls,fn){ var b=el('button','ed-bb'+(cls?' '+cls:''),label); b.type='button'; b.onclick=fn; return b; }
function edGroup(parent,foot){
  var g=el('div','ed-group'); parent.appendChild(g);
  if(foot) parent.appendChild(el('div','ed-foot',esc(foot)));
  return g;
}
// A <label> row, so a tap anywhere on it focuses the field.
function edRow(g,label,ctrl){
  var r=el('label','ed-row'); r.appendChild(el('span','ed-lab',esc(label))); r.appendChild(ctrl); g.appendChild(r); return r;
}
function edInput(g,label,value,o){
  o=o||{};
  var i=el('input','ed-in'+(o.cls?' '+o.cls:'')); i.type='text'; i.value=value==null?'':value;
  i.placeholder=o.ph||''; i.autocomplete='off'; i.enterKeyHint='done';
  if(o.num){ i.inputMode='decimal'; i.setAttribute('autocorrect','off'); i.spellcheck=false; }
  edRow(g,label,i); return i;
}
function edNum(i){ var v=String(i.value).replace(/[,\s₱]/g,''); return v===''?NaN:Number(v); }
function edDot(c){ return c?'<span class="acct-dot" style="background:'+esc(c)+'"></span>':''; }
function edItems(options){
  return options.map(function(o){ return typeof o==='object'?{value:String(o.value),label:String(o.label),color:o.color}:{value:String(o),label:String(o)}; });
}
// A row that shows its value and pushes a picker page. Exposes .value and .onpick.
function edPickRow(g,label,options,value,ph){
  var items=edItems(options), cur='';
  var b=el('button','ed-row ed-link'); b.type='button';
  b.appendChild(el('span','ed-lab',esc(label)));
  var v=el('span','ed-val'); b.appendChild(v); b.insertAdjacentHTML('beforeend',icon('chevron'));
  function set(x){
    var it=items.filter(function(i){ return i.value===String(x==null?'':x); })[0];
    cur=it?it.value:'';
    v.innerHTML=it?edDot(it.color)+'<span class="ed-txt">'+esc(it.label)+'</span>':'<span class="ed-ph">'+esc(ph||'Choose')+'</span>';
  }
  b.onclick=function(){ openPicker(label,items,cur,function(x){ set(x); if(b.onpick) b.onpick(); }); };
  Object.defineProperty(b,'value',{get:function(){ return cur; },set:set,configurable:true});
  set(value); g.appendChild(b); return b;
}
// The picker page: a search field pinned under the bar (long lists only), then every option, the current one ticked.
function openPicker(title,items,cur,done){
  var page=edPage(title,barBtn(icon('chevron')+'Back','back',popPage));
  var q=el('input','ed-search'); q.type='search'; q.placeholder='Search'; q.autocomplete='off'; q.enterKeyHint='done';
  var list=el('div','ed-group ed-list');
  var anyC=items.some(function(i){ return i.color; });   // then every row keeps the dot's space, so the names line up
  function pick(v){ done(v); popPage(); }
  function draw(){
    var s=q.value.trim(), f=!s?items:items.map(function(it){ return {it:it,sc:fuzzyScore(s,it.label)}; })
      .filter(function(x){ return x.sc>=0; }).sort(function(a,b){ return b.sc-a.sc; }).map(function(x){ return x.it; });
    list.innerHTML='';
    if(!f.length) list.appendChild(el('div','ed-row ed-empty','No match'));
    f.forEach(function(it){
      var on=it.value===cur, r=el('button','ed-row ed-opt'+(on?' on':''),(anyC?edDot(it.color||'transparent'):'')+'<span class="ed-txt">'+esc(it.label)+'</span>'+(on?icon('check'):''));
      r.type='button'; r.onclick=function(){ pick(it.value); }; list.appendChild(r);
    });
    return f;
  }
  q.oninput=draw;
  q.onkeydown=function(e){ if(e.key==='Enter'){ e.preventDefault(); var f=draw(); if(f[0]) pick(f[0].value); } };
  if(items.length>8) page.insertBefore(q,page.body);   // outside the scroller, so it stays on top
  page.body.appendChild(list); draw();
  if(edOpen()) pushPage(page); else openEditor(page);   // the add field's chips open one alone
  var on=list.querySelector('.on'), sc=page.body;
  if(on) sc.scrollTop=on.getBoundingClientRect().top-sc.getBoundingClientRect().top-sc.clientHeight/2;
  if(items.length>8&&matchMedia('(pointer:fine)').matches) q.focus();   // a phone keeps the keyboard down
}
// The amount row: a ± key (a refund is a negative expense; the decimal pad has no minus)
// and the account's currency after the figure.
function edAmount(g,label,value,sign){
  var r=el('label','ed-row ed-amt'); r.appendChild(el('span','ed-lab',esc(label)));
  var i=el('input','ed-in'); i.type='text'; i.inputMode='decimal'; i.autocomplete='off'; i.enterKeyHint='done';
  i.placeholder='0.00'; i.value=value==null?'':value; i.spellcheck=false; i.setAttribute('autocorrect','off');
  if(sign){
    var pm=el('button','ed-pm','±'); pm.type='button'; pm.setAttribute('aria-label','Flip the sign (a refund is negative)');
    pm.onclick=function(e){ e.preventDefault(); var v=String(i.value).trim(); i.value=v.charAt(0)==='-'?v.slice(1):'-'+v; };
    r.appendChild(pm);
  }
  r.appendChild(i); var c=el('span','ed-cur'); r.appendChild(c); g.appendChild(r);
  i.cur=function(code){ c.textContent=code||''; };
  return i;
}
// The rows that are rarely touched sit behind "More" unless one of them holds a value.
function edMore(parent,open,build){
  var g=edGroup(parent);
  if(open){ build(g); return; }
  var b=el('button','ed-row ed-link ed-morebtn','<span class="ed-lab">More options</span>'+icon('chevron')); b.type='button';
  b.onclick=function(){ b.remove(); build(g); };
  g.appendChild(b);
}
// Enter saves on a keyboard; on a touch screen it only puts the keyboard away.
function edEnter(page,save){
  page.addEventListener('keydown',function(e){
    if(e.key!=='Enter'||!e.target.classList.contains('ed-in')) return;
    e.preventDefault();
    if(matchMedia('(pointer:fine)').matches) save(); else e.target.blur();
  });
}
function edDelete(page,t){
  var g=edGroup(page.body), d=el('button','ed-row ed-del','Delete transaction'); d.type='button';
  d.onclick=function(){ confirmDelete(t); }; g.appendChild(d);
}
function periodItems(){ return [{value:'',label:"The date's month"}].concat(monthOptions()); }
function catItems(cats){
  return cats.map(function(c){ var s=((S.boot.categories||{})[c]||{}).Segment; return {value:c,label:c,color:SEG_COLOR[s]}; });
}

/* —— add / edit a normal transaction —— */
function openTxModal(t){
  if(!S.boot){ withBoot(function(){ openTxModal(t); }); return; }
  var isEdit=!!(t&&t.ID);
  var isXfer = t && (String(t.Type)==='Transfer' || (t.ToAccount&&String(t.ToAccount).trim()));
  if(isXfer){ openTransferModal(t); return; }

  var cats=Object.keys(S.boot.categories||{}).filter(function(c){
    return String((S.boot.categories[c]||{}).Type)!=='Transfer';
  }).sort();
  var accs=acctOptions();
  // default account for any new tx = last one used (if it still exists); a draft carried
  // in from the transfer form may have no account yet, so this backfills that too.
  // An account filter (rail pick or combo) is explicit — it beats the last-used default.
  var wantAcc=(S.screen==='transactions'&&S.tx.filters.account)||prefGet('lastAcct');
  var defAcc=isEdit ? '' : (accs.some(function(a){return (a.value||a)===wantAcc;})?wantAcc:'');

  var save=barBtn(isEdit?'Save':'Add','primary',function(){ doSave(); });
  var page=edPage(isEdit?'Edit transaction':'Add transaction',barBtn('Cancel','',closeEditor),save), b=page.body;
  var draft={};   // what the Transaction ⇄ Transfer switch carries over
  // Category is dropped on purpose: transfer categories are a disjoint set.
  if(!isEdit) b.appendChild(typeToggleEl('tx',function(){ openTransferModal(draft()); }));
  var g1=edGroup(b);
  var fAmt=edAmount(g1,'Amount',t?amtField(t.Amount):'',true);
  var fDesc=edInput(g1,'Description',t?t.Description:'',{ph:'Optional'});
  var g2=edGroup(b);
  var fCat=edPickRow(g2,'Category',catItems(cats),t?t.Category:'','Choose');
  var fAcc=edPickRow(g2,'Account',accs,(t&&t.Account)||defAcc,'Choose');
  var fDate=inputEl('date', t?isoDate(t.Date):newTxDate()); fDate.className='ed-in ed-date';
  edRow(g2,'Date',fDate);
  var fPeriod, fFx;
  edMore(b,!!(t&&(t.Period||t.ExchangeRate)),function(g){
    fPeriod=edPickRow(g,'Reports in',periodItems(),(t&&t.Period)||'');
    fFx=edInput(g,'Exchange rate',t&&t.ExchangeRate?t.ExchangeRate:'',{num:true,ph:'Auto'});
    b.insertBefore(el('div','ed-foot','Reports in books the row into another month. Exchange rate is PHP per 1 unit; blank = auto.'),g.nextSibling);
  });
  if(isEdit) edDelete(page,t);
  // A stamped rate belongs to the old account's currency — reassigning to a different
  // currency makes it meaningless, so clear the field back to "auto" (issue #7).
  var origCur=t?(t.Currency||'PHP'):'PHP';
  fAcc.onpick=function(){ fAmt.cur(acctCurrency(fAcc.value)); if(fFx&&acctCurrency(fAcc.value)!==origCur) fFx.value=''; };
  fAmt.cur(fAcc.value?acctCurrency(fAcc.value):'');
  draft=function(){ return {Date:fDate.value,Period:fPeriod?fPeriod.value:(t&&t.Period)||'',Account:fAcc.value,Amount:fAmt.value,Description:fDesc.value,Category:''}; };

  function doSave(){
    var payload={
      Date:fDate.value, Category:fCat.value, Account:fAcc.value,
      Amount:edNum(fAmt), Description:fDesc.value
    };
    var period=fPeriod?fPeriod.value:(t&&t.Period)||'';
    if(period||isEdit) payload.Period=period; // on edit, '' clears the override
    if(fFx&&fFx.value) payload.ExchangeRate=edNum(fFx);
    else if(isEdit) payload.ExchangeRate=''; // cleared (or never set) on edit → re-resolve/clear the stamp (issue #7)
    var bad=draftError(payload,false); if(bad){ toast(bad,'err'); return; }
    prefSet('lastAcct',payload.Account);   // the next add defaults to this account
    commitTx({t:t, payload:payload, isEdit:isEdit, create:'api_createTransaction',
              addedMsg:'Added', failMsg:'Add failed', reopen:openTxModal});
  }
  edEnter(page,doSave);
  openEditor(page);
  if(!isEdit&&!fAmt.value&&matchMedia('(pointer:fine)').matches) fAmt.focus();
}

/* —— transfer —— */
function openTransferModal(t){
  if(!S.boot){ withBoot(function(){ openTransferModal(t); }); return; }
  var isEdit=!!(t&&t.ID);
  var xferCats=Object.keys(S.boot.categories||{}).filter(function(c){
    return String((S.boot.categories[c]||{}).Type)==='Transfer';
  }).sort();
  var accs=acctOptions();
  var defCat=xferCats.indexOf('Transfer: Internal')>=0?'Transfer: Internal':'';

  var save=barBtn(isEdit?'Save':'Add','primary',function(){ doSave(); });
  var page=edPage(isEdit?'Edit transfer':'Add transfer',barBtn('Cancel','',closeEditor),save), b=page.body;
  var draft;
  if(!isEdit) b.appendChild(typeToggleEl('xfer',function(){ openTxModal(draft()); }));
  var g1=edGroup(b);
  var fAmt=edAmount(g1,'Amount',t?amtField(t.Amount):'',false);
  var fDesc=edInput(g1,'Description',t?t.Description:'',{ph:'Optional'});
  var g2=edGroup(b);
  var fFrom=edPickRow(g2,'From',accs,t?t.Account:'','Choose');
  var fTo=edPickRow(g2,'To',accs,t?t.ToAccount:'','Choose');
  var fCat=edPickRow(g2,'Category',catItems(xferCats),(t&&t.Category)||defCat,'Choose');
  var fDate=inputEl('date', t?isoDate(t.Date):newTxDate()); fDate.className='ed-in ed-date';
  edRow(g2,'Date',fDate);
  // Prefilled only when it's a real cross-currency override — mirroring Amount back into
  // the field would re-send a stale ToAmount on an amount edit (server mirrors when blank).
  var toAmt=(t&&t.ToAmount!=null&&t.ToAmount!==''&&Number(t.ToAmount)!==Number(t.Amount))?amtField(t.ToAmount):'';
  var fPeriod, fToAmt;
  edMore(b,!!((t&&t.Period)||toAmt!==''),function(g){
    fPeriod=edPickRow(g,'Reports in',periodItems(),(t&&t.Period)||'');
    fToAmt=edInput(g,'To amount',toAmt,{num:true,ph:'Same as amount'});
    b.insertBefore(el('div','ed-foot','Reports in books the row into another month. To amount is for a cross-currency transfer only.'),g.nextSibling);
  });
  if(isEdit) edDelete(page,t);
  fFrom.onpick=function(){ fAmt.cur(acctCurrency(fFrom.value)); };
  fAmt.cur(fFrom.value?acctCurrency(fFrom.value):'');
  draft=function(){ return {Date:fDate.value,Period:fPeriod?fPeriod.value:(t&&t.Period)||'',Account:fFrom.value,Amount:fAmt.value,Description:fDesc.value,Category:''}; };

  function doSave(){
    var payload={Date:fDate.value,Category:fCat.value,Account:fFrom.value,
                 ToAccount:fTo.value,Amount:edNum(fAmt),Description:fDesc.value};
    var bad=draftError(payload,true); if(bad){ toast(bad,'err'); return; }
    // The server refuses this too; asking here keeps the typed form on screen.
    if(xferNeedsTo(fFrom.value,fTo.value,fToAmt&&fToAmt.value)){
      var more=page.querySelector('.ed-morebtn'); if(more) more.click();
      toast('These accounts use different currencies. Enter the To amount.','err');
      if(fToAmt) fToAmt.focus();
      return;
    }
    var period=fPeriod?fPeriod.value:(t&&t.Period)||'';
    if(period||isEdit) payload.Period=period; // on edit, '' clears the override
    if(fToAmt&&fToAmt.value) payload.ToAmount=edNum(fToAmt);
    // No prefSet here: 'lastAcct' defaults the tx modal's Account, and a transfer's
    // From is not that — it would make the next expense default to wherever you last
    // moved money out of.
    commitTx({t:t, payload:payload, isEdit:isEdit, create:'api_createTransfer',
              addedMsg:'Transfer added', failMsg:'Transfer failed', reopen:openTransferModal});
  }
  edEnter(page,doSave);
  openEditor(page);
  if(!isEdit&&!fAmt.value&&matchMedia('(pointer:fine)').matches) fAmt.focus();
}

/* What the server would refuse in a new or edited row, checked BEFORE commitTx. Online a
 * refusal just reopens the form, but offline the row is queued, the owner sees "Saved
 * offline", and the sync then drops it as a final refusal. Pure, tested in test.js. */
function draftError(p, xfer){
  if(xfer){
    if(!p.Account||!p.ToAccount) return 'Pick the From and To accounts';
    if(p.Account===p.ToAccount) return 'From and To must differ';
    if(!p.Category) return 'Pick a category';
  } else if(!p.Category||!p.Account) return 'Pick a category and an account';
  if(typeof p.Amount!=='number'||isNaN(p.Amount)) return 'Type an amount';
  if(p.Amount===0) return 'The amount cannot be zero';
  return '';
}

function confirmDelete(t){
  var body=el('div','dim','You cannot undo this.');
  var yes=el('button','btn danger','Delete');
  yes.onclick=function(){
    // Optimistic: close instantly and show the row as "loading". It's removed from
    // the list only once the backend confirms; on failure it reverts to a normal row.
    S.tx.pendingDeletes[t.ID]=true;
    closeModal(); closeEditor();
    repaintTxList();
    gs('api_deleteTransaction',{ID:t.ID}).then(function(){
      delete S.tx.pendingDeletes[t.ID]; toast('Deleted','ok'); afterMutation();
    }).catch(function(e){
      delete S.tx.pendingDeletes[t.ID]; toast(e.message||e,'err');
      if(S.screen==='transactions') repaintTxList(); else render();
    });
  };
  var no=el('button','btn','Cancel'); no.onclick=closeModal;   // the editor, if open, is still underneath
  openModal(modalShell('Delete this transaction?', body, [no,yes]));
}

/* —— edit account —— */
function openAccountModal(a){
  var body=el('div');
  var info=el('div','card'); info.style.marginBottom='14px';
  info.innerHTML='<div class="row-between"><span class="dim">Balance</span><strong>'+acctMain(a)+
      (acctMain(a)!==money(a.balancePhp)?' <span class="dim">('+money(a.balancePhp)+')</span>':'')+'</strong></div>'+
    '<div class="row-between"><span class="dim">Type</span><span>'+esc(a.type||'—')+' · '+esc(a.subtype||'—')+'</span></div>'+
    (a.currency?'<div class="row-between"><span class="dim">Currency</span><span>'+esc(a.currency)+'</span></div>':'');
  body.appendChild(info);

  var fFreq=comboEl(['','Daily','Weekly','Monthly','Quarterly','Annually','None'], a.interestFrequency||'', {placeholder:'— none —'});
  var fRate=inputEl('number', a.interestRate!=null?a.interestRate:'', 'e.g. 0.04'); fRate.step='0.0001';
  var fLimit=inputEl('number', a.creditLimit!=null?a.creditLimit:'', ''); fLimit.step='0.01';
  var fNotes=el('textarea'); fNotes.rows=2; fNotes.value=a.notes||'';

  // ── color picker ──
  var colorSet = !!(a.color && /^#[0-9a-fA-F]{6}$/i.test(a.color));
  var fColor=el('input'); fColor.type='color'; fColor.value=colorSet?a.color:'#5b8cff';
  fColor.oninput=function(){ colorSet=true; paintSwatches(); };
  var swatchRow=el('div','swatches');
  ['#5b8cff','#3ecf8e','#ff6b6b','#ffb454','#a78bfa','#f472b6','#22d3ee','#e7eaf0'].forEach(function(c){
    var s=el('button','swatch'); s.type='button'; s.style.background=c; s.title=c; s.dataset.hex=c;
    s.onclick=function(){ fColor.value=c; colorSet=true; paintSwatches(); };
    swatchRow.appendChild(s);
  });
  var noneBtn=el('button','swatch none',icon('close')); noneBtn.type='button'; noneBtn.title='No color';
  noneBtn.onclick=function(){ colorSet=false; paintSwatches(); };
  swatchRow.appendChild(noneBtn);
  function paintSwatches(){
    Array.prototype.forEach.call(swatchRow.children,function(s){
      var isNone=s.classList.contains('none');
      var on=isNone?!colorSet:(colorSet&&(s.dataset.hex||'').toLowerCase()===fColor.value.toLowerCase());
      s.classList.toggle('on', on);
    });
    fColor.style.opacity=colorSet?'1':'.45';
  }
  var colorRow=el('div','color-row'); colorRow.appendChild(fColor); colorRow.appendChild(swatchRow);

  var rowI=el('div','field-row');
  rowI.appendChild(fieldEl('Interest freq.', fFreq));
  rowI.appendChild(fieldEl('Interest rate', fRate));
  body.appendChild(rowI);
  if(a.isLiability||a.creditLimit!=null) body.appendChild(fieldEl('Credit limit', fLimit));
  body.appendChild(fieldEl('Color', colorRow));
  body.appendChild(fieldEl('Notes', fNotes));
  paintSwatches();

  var save=el('button','btn primary','Save');
  save.onclick=function(){
    var payload={Name:a.name};
    if(fFreq.value!==(a.interestFrequency||'')) payload['Interest Frequency']=fFreq.value;
    // Mirror Notes: send whenever the field changed, with '' meaning "clear the cell"
    // (server setValue('') empties it) — otherwise a rate/limit could never be removed.
    var curRate=a.interestRate!=null?String(a.interestRate):'';
    if(fRate.value!==curRate) payload['Interest Rate']=fRate.value===''?'':parseFloat(fRate.value);
    var curLimit=a.creditLimit!=null?String(a.creditLimit):'';
    if(fLimit.value!==curLimit) payload['Credit Limit']=fLimit.value===''?'':parseFloat(fLimit.value);
    if(fNotes.value!==(a.notes||'')) payload['Notes']=fNotes.value;
    var newColor = colorSet ? fColor.value : '';
    if(newColor !== (a.color||'')) payload['Color']=newColor;
    if(Object.keys(payload).length===1){toast('No changes','err');return;}
    save.disabled=true; save.textContent='Saving…';
    // The account lives in S.boot too (dots, pickers, holding colours), so re-read the
    // bootstrap: it repaints the CURRENT screen — this modal also opens from Investments.
    gs('api_updateAccount',payload).then(function(){
      closeModal(); toast('Saved','ok'); dropCache();
      revalidateBoot().catch(function(){ render(); });
    }).catch(function(e){ save.disabled=false; save.textContent='Save'; toast(e.message||e,'err'); });
  };
  openModal(modalShell(a.name, body, [save]));
}

/* ── shared ──────────────────────────────────────────────────────────────── */
// A date filter on the transactions screen is explicit — a new row defaults to that
// date, the same way an account filter beats the last-used account.
function newTxDate(){
  return (S.screen==='transactions'&&S.tx.filters.date)||isoDate(new Date());
}
function isoDate(d){
  if(!d) return '';
  var dt=parseDate(d);
  if(!dt||isNaN(dt.getTime())) return '';
  var m=String(dt.getMonth()+1).padStart(2,'0'), day=String(dt.getDate()).padStart(2,'0');
  return dt.getFullYear()+'-'+m+'-'+day;
}
function afterMutation(){
  // Each screen re-fetches its own fresh balances/budgets; account & category
  // names are unchanged by a tx write, so no need to re-hydrate getBootstrap.
  dropCache();
  // On the transactions screen do a *silent* reload: the optimistic row already
  // on screen stays put until the fresh server page lands, then swaps in place
  // (no spinner flash) — and a full render() would rebuild the filter/selection
  // DOM and flash skeletons on every write. Other screens fully re-render.
  if(S.screen==='transactions'){ loadTx(null,true); if(txWide()) loadPaneAccts(); }
  else render();
}

// Build a display-shaped row for an in-flight create so it can render immediately.
function optimisticTx(p){
  var cat=p.Category, catType=((S.boot&&S.boot.categories||{})[cat]||{}).Type||'';
  var acc=((S.boot&&S.boot.accounts)||[]).filter(function(x){return x.name===p.Account;})[0]||{};
  var cur=acc.currency||'PHP';
  // best-effort PHP; reconciled on reload. Manual rate wins; else auto-FX for USD
  // (the common case) so the pending row + day-net don't treat USD as PHP.
  var rate=p.ExchangeRate?p.ExchangeRate:(cur==='USD'&&S.boot&&S.boot.fxUsdPhp?S.boot.fxUsdPhp:(cur==='PHP'?1:null));
  var php=rate!=null?p.Amount*rate:p.Amount;
  return { _pending:true, _tmpId:'tmp'+Date.now()+'-'+Math.round(Math.random()*1e6),
    Date:p.Date, Period:p.Period||'', Category:cat, Account:p.Account, ToAccount:p.ToAccount||'',
    Amount:p.Amount, 'Amount (PHP)':php, Currency:cur,
    Type:p.ToAccount?'Transfer':catType, Description:p.Description, ExchangeRate:p.ExchangeRate };
}
function pushPendingAdd(p){ var o=optimisticTx(p); S.tx.pendingAdds.unshift(o); repaintTxList(); return o._tmpId; }
function dropPendingAdd(id){ S.tx.pendingAdds=S.tx.pendingAdds.filter(function(x){return x._tmpId!==id;}); }
function showErr(e){
  $('#main').innerHTML='<div class="empty">'+esc(e&&e.message?e.message:e)+
    '<br><button class="btn" style="margin-top:12px" onclick="render()">Retry</button></div>';
}
