// Pattro Service Worker
const CACHE_NAME = 'pattro-v1';

// Only cache static assets — never cache app.html (always fresh)
const STATIC_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;600;700;800&display=swap',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

self.addEventListener('install', function(e) {
  self.skipWaiting();
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

  // Never intercept Supabase or API calls
  if (url.includes('supabase.co') || url.includes('/api/')) {
    return;
  }

  // For HTML pages — always network first, no cache
  if (e.request.headers.get('accept') && e.request.headers.get('accept').includes('text/html')) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // For fonts and static assets — cache first
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') || url.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(response) {
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
