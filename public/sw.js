// ezspeak service worker — caches app shell for offline launch
const CACHE = 'ezspeak-v1';
const SHELL = [
  '/',
  '/manifest.json',
  '/style.css',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.svg',
  '/js/config.js',
  '/js/storage.js',
  '/js/audio.js',
  '/js/net.js',
  '/js/webrtc.js',
  '/js/chat.js',
  '/js/settings.js',
  '/js/ui.js',
  '/js/app.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first for API / WebSocket; cache-first for app shell
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, clone));
        }
        return res;
      });
      return cached || fetched;
    })
  );
});
