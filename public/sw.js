// Offline support: the app shell is cached, recipes you've opened stay
// readable without a connection, and saved files are cached after first view.
const SHELL = 'recipe-box-shell-v1';
const DATA = 'recipe-box-data-v1';
const SHELL_FILES = ['/', '/index.html', '/app.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/api/export') return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html')));
  } else if (url.pathname.startsWith('/files/')) {
    // Files never change once uploaded (and video uses range requests), so cache-first.
    if (req.headers.has('range')) return;
    e.respondWith(caches.open(DATA).then(async (c) => (await c.match(req)) || fetch(req).then((res) => {
      if (res.ok) c.put(req, res.clone());
      return res;
    })));
  } else if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, DATA));
  } else {
    e.respondWith(networkFirst(req, SHELL));
  }
});
