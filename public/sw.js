// ezspeak service worker — caches app shell for offline launch
const CACHE = 'ezspeak-v2';
const SHELL = [
  '/',
  '/manifest.json',
  '/style.css',
  '/favicon.svg',
  '/web-app-manifest-192x192.png',
  '/web-app-manifest-512x512.png',
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

self.addEventListener('fetch', (e) => {
  const { request } = e;

  // Only handle GET requests for http/https
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  e.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request).then((res) => {
        // Cache successful HTML/CSS/JS responses
        if (res.ok && res.status < 400) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return res;
      }).catch(() => {
        // Network error — return cached if available, otherwise let it fail
        return cached || Response.error();
      });
      return cached || fetched;
    })
  );
});
