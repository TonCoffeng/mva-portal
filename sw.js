// Minimale service worker voor installeerbaarheid (PWA).
// Bewust GEEN caching -> geen risico op vastzittende oude versies.
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ self.clients.claim(); });
self.addEventListener('fetch', function(e){ /* netwerk-passthrough */ });
