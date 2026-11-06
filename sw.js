const cacheName = 'guitar-tuner-v7';
const files = ['./','./index.html','./style.css?v=7','./app.js?v=7','./pitch.js?v=7','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('guitar-tuner-') && key !== cacheName).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
const urls = new Set(files.map(file => new URL(file,self.registration.scope).href));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  if (request.mode === 'navigate' && urls.has(url.href)) {
    event.respondWith(fetch(request).catch(() => caches.open(cacheName).then(cache => cache.match('./'))));
  } else if (urls.has(request.url)) {
    event.respondWith(caches.open(cacheName).then(async cache => await cache.match(request) || fetch(request)));
  }
});
