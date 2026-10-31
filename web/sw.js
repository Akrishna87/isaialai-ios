// Offline app shell. Songs are never cached here: they live in the app's own
// storage (OPFS / IndexedDB) and play from blob: URLs the service worker never sees.
const VERSION = 'isaialai-v1.0.0';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/library.js',
  'js/player.js',
  'js/queue.js',
  'js/tags.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/note.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates show up), falling back to the cache when offline or slow.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return; // media requests: leave them alone
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000)),
      ]);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
