// Service Worker — instalación PWA + cache de assets, pero el HTML SIEMPRE desde la red
// (network-only para navegaciones) para no servir páginas viejas tras un deploy/edición.
const CACHE = 'ij-cache-v3';

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // borra cachés antiguas
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // no cachear POST/PUT, etc.

  const accept = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || accept.includes('text/html');

  // HTML / navegaciones: SIEMPRE red, sin caché (evita ver la página vieja).
  if (isHTML) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Resto de assets: network-first con copia para uso offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        try {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
        } catch (_) {}
        return res;
      })
      .catch(() => caches.match(req))
  );
});
