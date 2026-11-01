// Service worker: app-shell offline beschikbaar maken.
const VERSION = 'whoop-v4'; // verhoog bij elke update
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/ble.js',
  './js/demo.js',
  './js/hrv.js',
  './js/db.js',
  './js/chart.js',
  './js/metrics.js',
  './js/whoop-api.js',
  './assets/keepawake.mp4',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate voor eigen bestanden; navigaties vallen terug op index.html.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Video (bereikverzoeken) direct via het netwerk/de browsercache laten lopen
  if (req.headers.has('range') || req.url.endsWith('.mp4')) return;
  // API-verzoeken nooit cachen
  if (new URL(req.url).pathname.includes('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    const network = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => cached || Response.error());
    return cached || network;
  })());
});
