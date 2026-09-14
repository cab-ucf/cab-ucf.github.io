// irweb service worker: every fetch under x/<sid>/ becomes one HTTP exchange over iroh.
// State that must survive SW termination (sid -> seed) lives in the Cache API.
import init, { Client } from './pkg/irweb_web.js';

const BASE = new URL(self.registration.scope).pathname;           // '/' or '/irweb/'
const BUNDLE = ['', 'index.html', 'sw.js', 'pkg/irweb_web.js', 'pkg/irweb_web_bg.wasm'].map(p => BASE + p);
const REQ_SKIP = new Set(['connection', 'host', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);
const RES_SKIP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive']);

self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open('irweb-bundle');
  await c.addAll(BUNDLE.filter(p => !p.endsWith('/')).concat(BASE));
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  if (e.data?.seed) e.waitUntil(newSession(e.data, e.ports[0]));
});

async function newSession({ seed, relay }, port) {
  const sid = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => (b % 36).toString(36)).join('');
  const c = await caches.open('irweb-sites');
  await c.put(new Request(BASE + '__site/' + sid), new Response(JSON.stringify({ seed, relay })));
  port.postMessage({ sid });
}

async function site(sid) {
  const r = await (await caches.open('irweb-sites')).match(BASE + '__site/' + sid);
  return r ? r.json() : null;
}

const clients = new Map();   // seed|relay -> Promise<Client>
function client(s) {
  const k = s.seed + '|' + (s.relay || '');
  if (!clients.has(k)) {
    clients.set(k, (async () => { await init(); return Client.connect(s.seed, s.relay || undefined); })()
      .catch(err => { clients.delete(k); throw err; }));
  }
  return clients.get(k);
}

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.startsWith(BASE)) return;
  if (BUNDLE.includes(u.pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }
  e.respondWith(route(e, u).catch(err => new Response('irweb: ' + (err?.message || err), { status: 502 })));
});

async function route(e, u) {
  const rel = u.pathname.slice(BASE.length);
  let sid, path;
  const m = rel.match(/^x\/([a-z0-9]+)(\/.*)?$/);
  if (m) {
    if (!m[2]) return Response.redirect(u.pathname + '/' + u.search, 302);
    sid = m[1]; path = m[2];
  } else {
    // Absolute path (e.g. /style.css) requested by a page under x/<sid>/: resolve via the client.
    const c = await self.clients.get(e.clientId || e.resultingClientId);
    const mm = c && new URL(c.url).pathname.slice(BASE.length).match(/^x\/([a-z0-9]+)/);
    if (!mm) return fetch(e.request);
    sid = mm[1]; path = '/' + rel;
  }
  const s = await site(sid);
  if (!s) return new Response('irweb: unknown session, open the link again', { status: 404 });
  const cl = await client(s);
  const req = e.request;
  let hdr = '';
  for (const [k, v] of req.headers) if (!REQ_SKIP.has(k)) hdr += `${k}: ${v}\r\n`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(await req.arrayBuffer());
  const r = await cl.fetch(req.method, path + u.search, hdr, body);
  const lines = r.headers.split('\n'), h = new Headers();
  for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i] && !RES_SKIP.has(lines[i].toLowerCase())) h.append(lines[i], lines[i + 1]);
  const noBody = req.method === 'HEAD' || r.status === 204 || r.status === 304;
  return new Response(noBody ? null : r.body, { status: r.status, headers: h });
}
