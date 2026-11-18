// ezspeak service worker — caches app shell for offline launch
const CACHE = 'ezspeak-v3';
const SHELL = [
  '/',
  '/manifest.json',
  '/style.css',
  '/favicon.png',
  '/js/shared.js',
  '/js/config.js',
  '/js/storage.js',
  '/js/audio.js',
  '/js/net.js',
  '/js/webrtc.js',
  '/js/chat.js',
  '/js/settings.js',
  '/js/ui.js',
  '/js/app.js',
  '/css/reset.css',
  '/css/landing.css',
  '/css/layout.css',
  '/css/controls.css',
  '/css/modals.css',
  '/css/chat.css',
  '/css/messages.css',
  '/css/video.css',
  '/css/responsive.css',
  '/css/settings.css',
  '/css/avatar.css',
  '/css/permissions.css',
  '/css/misc.css',
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

// Network-first: the client must always match the signaling protocol of
// the running server. The cache is only an offline fallback.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/health') return;

  e.respondWith(
    fetch(request).then((res) => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, clone));
      }
      return res;
    }).catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
