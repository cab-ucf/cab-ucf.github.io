// irweb service worker: every fetch under x/<sid>/ becomes one HTTP exchange over iroh.
// State that must survive SW termination (sid -> server id) lives in the Cache API.
// Classic worker, not an ES module: module service workers need Firefox 147+ and
// Safari 16.4+, and students arrive on whatever browser they already have.
const BASE = new URL(self.registration.scope).pathname;           // '/' or '/irweb/'
// Stamped by web/build.sh from the wasm hash. The glue and the binary are only valid as a
// matched pair -- a stale one of either throws "__wasm_bindgen_func_elem_N is not a
// function" -- so both are fetched under this version and the cache is named after it.
const V = '6c7e1b047560';
const CACHE = 'irweb-bundle-' + V;
// Pages from before this pairing registered sw.js as a module, where importScripts
// throws. Their old worker serves that page from its cache forever, so a worker that
// only ran as classic could never replace it: run as a module too, and retire.
let classic = true;
try { importScripts(BASE + 'pkg/irweb_web.js?v=' + V); } catch { classic = false; }
const { Client, server_id } = classic ? wasm_bindgen : {};
// Once: a second instantiation racing the first would swap the memory under live objects.
let ready;
const init = () => ready ??= wasm_bindgen({ module_or_path: BASE + 'pkg/irweb_web_bg.wasm?v=' + V });
const BUNDLE = ['', 'index.html', 'sw.js', 'irweb-ws.js', 'pkg/irweb_web.js', 'pkg/irweb_web_bg.wasm'].map(p => BASE + p);
const REQ_SKIP = new Set(['connection', 'host', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);
const RES_SKIP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive']);

self.addEventListener('install', e => e.waitUntil((async () => {
  // 'reload' or a deploy can be installed straight back out of the HTTP cache.
  if (classic) await (await caches.open(CACHE)).addAll(BUNDLE.filter(p => !p.endsWith('/'))
    .concat(BASE).map(u => new Request(u, { cache: 'reload' })));
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil((async () => {
  await self.clients.claim();
  if (classic) {
    const keep = new Set([CACHE, 'irweb-sites']), c = await caches.open('irweb-sites');
    await Promise.all((await caches.keys()).filter(k => !keep.has(k)).map(k => caches.delete(k)));
    // Sessions from before only ids were stored hold seeds: forget them.
    for (const r of await c.keys()) if ((await (await c.match(r)).json()).seed)
      await Promise.all([c.delete(r), c.delete(r.url.replace('/__site/', '/__jar/'))]);
    return;
  }
  // Retiring: send each tab back to its link, to be served by the network this time.
  const to = await Promise.all((await self.clients.matchAll({ type: 'window' })).map(async c => {
    const s = await site(new URL(c.url).pathname.slice(BASE.length).match(/^x\/([a-z0-9]+)/)?.[1]);
    return [c, s ? BASE + '#' + s.seed + (s.relay ? ';r=' + s.relay : '') : c.url];
  }));
  await Promise.all((await caches.keys()).map(k => caches.delete(k)));
  await Promise.all([BASE, BASE + 'index.html'].map(u => fetch(u, { cache: 'reload' })));
  await self.registration.unregister();
  to.forEach(([c, u]) => c.navigate(u));
})()));

self.addEventListener('message', e => {
  if (e.data?.seed) e.waitUntil(newSession(e.data, e.ports[0]));
});

// Only the server's public id is kept: every site opened through this page can read
// this storage, and the seed would let any of them pose as the server. It also spares
// each wake of the worker from stretching a typed code again.
async function newSession({ seed, relay }, port) {
  try {
    await init();
    const id = server_id(seed);
    const sid = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => (b % 36).toString(36)).join('');
    const c = await caches.open('irweb-sites');
    await c.put(new Request(BASE + '__site/' + sid), new Response(JSON.stringify({ id, relay })));
    port.postMessage({ sid });
  } catch (err) { port.postMessage({ error: String(err?.message || err) }); }
}

// Cookies: a worker is never shown the Cookie header and cannot set cookies from a
// response it builds, so each session keeps its own jar here, stored beside its seed.
const jars = new Map();   // sid -> Promise<Map(name -> value)>
const jar = sid => jars.get(sid) || jars.set(sid, caches.open('irweb-sites')
  .then(c => c.match(BASE + '__jar/' + sid)).then(r => r ? r.json() : []).then(a => new Map(a))).get(sid);
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

async function site(sid) {
  const r = await (await caches.open('irweb-sites')).match(BASE + '__site/' + sid);
  return r ? r.json() : null;
}

const clients = new Map();   // id|relay -> Promise<Client>
function client(s) {
  const k = s.id + '|' + (s.relay || '');
  if (!clients.has(k)) {
    clients.set(k, (async () => { await init(); return Client.connect(s.id, s.relay || undefined); })()
      .catch(async err => {
        clients.delete(k);
        // A glue/binary mismatch means this worker is outdated: an older copy of it is
        // running against a bundle that has since been redeployed. Stand down so the next
        // load installs a matched pair instead of showing this forever.
        if (String(err?.message || err).includes('__wasm_bindgen_func_elem')) {
          await Promise.all((await caches.keys()).map(k => caches.delete(k)));
          await self.registration.unregister();
          throw new Error('page was updated; reload to continue');
        }
        throw err;
      }));
  }
  return clients.get(k);
}

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.startsWith(BASE)) return;
  e.respondWith(route(e, u).catch(err => new Response('irweb: ' + (err?.message || err), { status: 502 })));
});

/// The landing page and its wasm, served from the install-time cache.
const bundle = req => BUNDLE.includes(new URL(req.url).pathname)
  ? caches.match(req).then(r => r || fetch(req))
  : fetch(req);

async function route(e, u) {
  const rel = u.pathname.slice(BASE.length);
  if (rel === 'irweb-ws.js') return bundle(e.request);
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
    const mm = from.startsWith(self.location.origin)
      && new URL(from).pathname.slice(BASE.length).match(/^x\/([a-z0-9]+)/);
    if (!mm) return bundle(e.request);
    // Send navigations back under x/<sid>/ rather than answering at the bare path:
    // the address bar is what the next click resolves against.
    if (e.request.mode === 'navigate') {
      return Response.redirect(BASE + 'x/' + mm[1] + '/' + rel + u.search, 302);
    }
    sid = mm[1]; path = '/' + rel;
  }
  const s = await site(sid);
  if (!s) return new Response('irweb: unknown session, open the link again', { status: 404 });
  const cl = await client(s), j = await jar(sid);
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
  if (ate) caches.open('irweb-sites').then(c => c.put(new Request(BASE + '__jar/' + sid), new Response(JSON.stringify([...j]))));
  const noBody = req.method === 'HEAD' || r.status === 204 || r.status === 304;
  const html = !noBody && /^text\/html\s*(;\s*charset=utf-8\s*)?$/i.test(h.get('content-type') || '');
  return new Response(noBody ? null : html ? shim(await new Response(r.body).text()) : r.body, { status: r.status, headers: h });
}
