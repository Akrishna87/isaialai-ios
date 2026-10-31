// Offline app shell. Songs are never cached here: they live in the app's own
// storage (OPFS / IndexedDB) and play from blob: URLs the service worker never sees.
const VERSION = 'isaialai-v1.0.1';
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

// Cover art for the lock screen: iPhone only shows artwork from a normal web
// address, so art/<key> is answered from the app's IndexedDB.
function artFromDb(key) {
  return new Promise((resolve) => {
    const open = indexedDB.open('isaialai');
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const r = db.transaction('art', 'readonly').objectStore('art').get(key);
        r.onsuccess = () => { resolve(r.result || null); db.close(); };
        r.onerror = () => { resolve(null); db.close(); };
      } catch (err) {
        db.close();
        resolve(null);
      }
    };
  });
}

const ART_PATH = new URL('art/', self.registration.scope).pathname;

// Network first (so updates show up), falling back to the cache when offline or slow.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(ART_PATH)) {
    e.respondWith((async () => {
      const blob = await artFromDb(decodeURIComponent(url.pathname.slice(ART_PATH.length)));
      if (!blob) return fetch(new URL('icons/icon-512.png', self.registration.scope));
      return new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg', 'Cache-Control': 'max-age=31536000' } });
    })());
    return;
  }
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
