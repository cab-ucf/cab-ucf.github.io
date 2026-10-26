// irweb service worker: every fetch under x/<sid>/ becomes one HTTP exchange over iroh.
// Classic worker, not an ES module: module service workers need Firefox 147+ and
// Safari 16.4+, and students arrive on whatever browser they already have.
const BASE = new URL(self.registration.scope).pathname;           // '/' or '/irweb/'
// Stamped by web/build.sh from a hash of the whole bundle. The glue and the binary are
// only valid as a matched pair -- a stale one of either throws "__wasm_bindgen_func_elem_N
// is not a function" -- so both are fetched under this version.
const V = 'f0ed12057975';
// Pages from before this pairing registered sw.js as a module, where importScripts
// throws. Their old worker serves that page from its cache forever, so a worker that
// only ran as classic could never replace it: run as a module too, and retire.
let classic = true;
try { importScripts(BASE + 'pkg/irweb_web.js?v=' + V); } catch { classic = false; }
const { Client, public_link } = classic ? wasm_bindgen : {};
const init = () => wasm_bindgen({ module_or_path: BASE + 'pkg/irweb_web_bg.wasm?v=' + V });
const SITES = 'irweb-sessions';
const REQ_SKIP = new Set(['connection', 'host', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);
const RES_SKIP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  await self.clients.claim();
  // Earlier workers cached the bundle, which served pages could rewrite, and kept
  // seeds in the clear.
  await Promise.all((await caches.keys()).filter(k => k !== SITES).map(k => caches.delete(k)));
  if (classic) return sweep();
  // Retiring: send each tab back to the landing page, served by the network this time.
  await Promise.all([BASE, BASE + 'index.html'].map(u => fetch(u, { cache: 'reload' })));
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(BASE);
})()));

self.addEventListener('message', e => {
  if (e.data?.link && e.ports[0]) e.waitUntil(newSession(e.data.link, e.ports[0]));
});

// Served pages share this origin and can read its caches, so a session's link (only
// its public form: <id>;t=<token>, never the code) and cookie jar are sealed with
// AES-GCM under the sid, which only that session's tabs know, and filed under the
// sid's hash. A worker is never shown the Cookie header and cannot set cookies from a
// response it builds, hence the jar.
const sessions = new Map();   // sid -> Promise<{ link, jar: Map(name -> value) }>
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const key = sid => crypto.subtle.importKey('raw', new Uint8Array(sid.match(/../g).map(h => parseInt(h, 16))),
  'AES-GCM', false, ['encrypt', 'decrypt']);
const slot = async sid => BASE + '__site/' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sid)));
const sidOf = url => new URL(url).pathname.slice(BASE.length).match(/^x\/([a-z0-9]+)/)?.[1];

async function newSession(fragment, port) {
  try {
    await sweep();
    await init();
    const sid = hex(crypto.getRandomValues(new Uint8Array(16)));
    const s = { link: public_link(fragment), jar: new Map() };
    sessions.set(sid, Promise.resolve(s));
    await save(sid, s);
    port.postMessage({ sid });
  } catch (err) { port.postMessage({ err: String(err?.message || err) }); }
}

async function save(sid, s) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ link: s.link, jar: [...s.jar] }));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(sid), plain);
  await (await caches.open(SITES)).put(await slot(sid), new Response(new Blob([iv, sealed])));
}

function session(sid) {
  if (!sessions.has(sid)) sessions.set(sid, (async () => {
    const r = await (await caches.open(SITES)).match(await slot(sid));
    if (!r) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    const s = JSON.parse(new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await key(sid), b.slice(12))));
    return { link: s.link, jar: new Map(s.jar) };
  })());
  return sessions.get(sid);
}

// A session ends with its last tab, and its link and jar go with it.
async function sweep() {
  const live = new Set((await self.clients.matchAll({ type: 'window' })).map(c => sidOf(c.url)));
  for (const sid of sessions.keys()) if (!live.has(sid)) sessions.delete(sid);
  const keep = await Promise.all([...live].filter(Boolean).map(slot));
  const c = await caches.open(SITES);
  await Promise.all((await c.keys()).filter(r => !keep.includes(new URL(r.url).pathname)).map(r => c.delete(r)));
}

function eat(j, line) {
  const [nv, ...attrs] = line.split(';'), i = nv.indexOf('=');
  if (i < 1) return;
  const gone = attrs.some(a => /^\s*max-age\s*=\s*(-\d+|0+)\s*$/i.test(a)
    || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now()));
  gone ? j.delete(nv.slice(0, i).trim()) : j.set(nv.slice(0, i).trim(), nv.slice(i + 1).trim());
}
// Every page gets the WebSocket shim first, before any of its own scripts run.
const SHIM = `<script src="${BASE}irweb-ws.js"></script>`;
const shim = t => /<head\b[^>]*>/i.test(t) ? t.replace(/<head\b[^>]*>/i, m => m + SHIM) : t.replace(/^(\s*<!doctype[^>]*>)?/i, m => m + SHIM);

const conns = new Map();   // link -> Promise<Client>
function client(link) {
  if (!conns.has(link)) {
    conns.set(link, (async () => { await init(); return Client.connect(link); })()
      .catch(async err => {
        conns.delete(link);
        // A glue/binary mismatch means this worker is outdated: an older copy of it is
        // running against a bundle that has since been redeployed. Stand down so the next
        // load installs a matched pair instead of showing this forever.
        if (String(err?.message || err).includes('__wasm_bindgen_func_elem')) {
          await self.registration.unregister();
          throw new Error('page was updated; reload to continue');
        }
        throw err;
      }));
  }
  return conns.get(link);
}

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.startsWith(BASE)) return;
  e.respondWith(route(e, u).catch(err => new Response('irweb: ' + (err?.message || err), { status: 502 })));
});

async function route(e, u) {
  const rel = u.pathname.slice(BASE.length);
  if (rel === 'irweb-ws.js') return fetch(e.request);
  let sid, path;
  const m = rel.match(/^x\/([a-z0-9]+)(\/.*)?$/);
  if (m) {
    if (!m[2]) return Response.redirect(u.pathname + '/' + u.search, 302);
    sid = m[1]; path = m[2];
  } else {
    // An absolute path (/style.css, or a link in a file listing) from a page under
    // x/<sid>/. A navigation carries no usable clientId -- resultingClientId names a
    // client that does not exist yet -- so fall back to the referrer, which is why
    // clicking a link used to 404 while its stylesheets loaded.
    const c = await self.clients.get(e.clientId);
    const from = (c && c.url) || e.request.referrer || '';
    const mm = from.startsWith(self.location.origin) && sidOf(from);
    if (!mm) return fetch(e.request);
    // Send navigations back under x/<sid>/ rather than answering at the bare path:
    // the address bar is what the next click resolves against.
    if (e.request.mode === 'navigate') {
      return Response.redirect(BASE + 'x/' + mm + '/' + rel + u.search, 302);
    }
    sid = mm; path = '/' + rel;
  }
  const s = await session(sid);
  if (!s) return new Response('irweb: unknown session, open the link again', { status: 404 });
  const cl = await client(s.link), j = s.jar;
  const req = e.request;
  let hdr = j.size ? `cookie: ${[...j].map(c => c.join('=')).join('; ')}\r\n` : '';
  for (const [k, v] of req.headers) if (!REQ_SKIP.has(k)) hdr += `${k}: ${v}\r\n`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(await req.arrayBuffer());
  const r = await cl.fetch(req.method, path + u.search, hdr, body);
  const lines = r.headers.split('\n'), h = new Headers();
  let ate = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const k = lines[i].toLowerCase();
    if (k === 'set-cookie') { eat(j, lines[i + 1]); ate = true; }
    else if (k && !RES_SKIP.has(k)) h.append(lines[i], lines[i + 1]);
  }
  if (ate) save(sid, s);
  const noBody = req.method === 'HEAD' || r.status === 204 || r.status === 304;
  const html = !noBody && /^text\/html\s*(;\s*charset=utf-8\s*)?$/i.test(h.get('content-type') || '');
  return new Response(noBody ? null : html ? shim(await new Response(r.body).text()) : r.body, { status: r.status, headers: h });
}
