// Pattro Service Worker
const CACHE_NAME = 'pattro-v2';

// Static assets to pre-cache on install
// These never change between sessions — safe to cache aggressively
const STATIC_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Fragment+Mono:ital@0;1&family=Unbounded:wght@300;400;700;900&family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,700;1,9..144,300;1,9..144,700&display=swap',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

// FIX M4: actually cache assets on install (was just calling skipWaiting before)
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // cache.addAll fails if any request fails — use individual adds so one
      // bad URL doesn't break the whole install
      return Promise.allSettled(
        STATIC_ASSETS.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('[SW] Could not pre-cache:', url, err.message);
          });
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Network first — always get fresh content
// Fall back to cache only for fonts/static assets
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Never intercept Supabase or API calls — always fresh
  if (url.includes('supabase.co') || url.includes('/api/')) {
    return;
  }

  // HTML pages — network first, fall back to cache if offline
  if (e.request.headers.get('accept') && e.request.headers.get('accept').includes('text/html')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // Fonts and CDN assets — cache first (they never change)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') || url.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(response) {
          // Only cache valid responses
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
          });
          return response;
        });
      })
    );
    return;
  }
});
