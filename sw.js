/* Health Tracker — sw.js
 * Same-origin, cache-first service worker so the installed iPhone web app works offline.
 * Only ever requests this app's own static files (CLAUDE.md rule 1; decisions.md).
 * Registered by js/app.js only when served over http/https (never under file://).
 * Bump CACHE_VERSION whenever any app file changes so clients pick up the new files.
 */
'use strict';

var CACHE_VERSION = 'ht-v1';

var CORE = [
  './',
  'index.html',
  'css/app.css',
  'js/units.js',
  'js/dates.js',
  'js/db.js',
  'js/today.js',
  'js/history.js',
  'js/settings.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-maskable.svg'
];

// Owned by other builders; cached if present, skipped if missing.
var OPTIONAL = ['js/import-health.js', 'js/trends.js', 'js/patterns.js'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(CORE).then(function () {
        return Promise.all(OPTIONAL.map(function (u) {
          return fetch(u, { cache: 'no-cache' }).then(function (res) {
            if (res.ok) return cache.put(u, res);
          }).catch(function () {});
        }));
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n.indexOf('ht-') === 0 && n !== CACHE_VERSION; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch other origins
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Cache successful same-origin basic responses (e.g. a module added later).
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
