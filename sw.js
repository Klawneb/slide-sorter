// Network first so updates show up straight away, but if the network is
// slow or missing the cached copy is used, so the app always opens.
const CACHE = 'slide-sorter-v8';
const NETWORK_WAIT_MS = 3000;
const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/exif.js',
  'js/tags.js',
  'js/zip.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;

  const fromNetwork = fetch(e.request).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  });
  e.waitUntil(fromNetwork.catch(() => {}));

  e.respondWith((async () => {
    const slow = new Promise(resolve => setTimeout(resolve, NETWORK_WAIT_MS));
    const res = await Promise.race([fromNetwork.catch(() => null), slow]);
    if (res) return res;
    // Offline or slow: use the cached copy if there is one.
    return (await caches.match(e.request, { ignoreSearch: true })) || fromNetwork;
  })());
});
