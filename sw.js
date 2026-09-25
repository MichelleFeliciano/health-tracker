/* Health Tracker — sw.js
 * Same-origin, cache-first service worker so the installed iPhone web app works offline.
 * Only ever requests this app's own static files (CLAUDE.md rule 1; decisions.md).
 * Registered by js/app.js only when served over http/https (never under file://).
 * Bump CACHE_VERSION whenever any app file changes so clients pick up the new files.
 * All GitHub Pages sites under one account share an origin, so this worker only reads,
 * writes and deletes its own caches and ignores URLs outside its scope (T-001 R-2).
 */
'use strict';

var CACHE_PREFIX = 'health-tracker-';
var CACHE_VERSION = CACHE_PREFIX + 'v6';
var LEGACY_CACHES = ['ht-v1', 'ht-v2'];   // this app's own old names; never match other apps' caches

var CORE = [
  './',
  'index.html',
  'css/app.css',
  'css/charts.css',
  'js/units.js',
  'js/dates.js',
  'js/db.js',
  'js/today.js',
  'js/history.js',
  'js/settings.js',
  'js/health-dates.js',
  'js/health-zip.js',
  'js/health-scan.js',
  'js/health-agg.js',
  'js/health-csv.js',
  'js/import-health.js',
  'js/stats.js',
  'js/trends.js',
  'js/patterns.js',
  'js/summary.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // cache:'reload' bypasses the HTTP cache so a new version never precaches stale files.
      return cache.addAll(CORE.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) {
        return n !== CACHE_VERSION && (n.indexOf(CACHE_PREFIX) === 0 || LEGACY_CACHES.indexOf(n) >= 0);
      }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // never touch other origins
  var scope = self.registration.scope;                        // e.g. https://.../health-tracker/
  if (req.url.indexOf(scope) !== 0) return;                   // other apps on this origin: not ours
  event.respondWith(caches.open(CACHE_VERSION).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') {
          var path = url.pathname, root = new URL(scope).pathname;
          // T001-09: only the app root (or index.html) is served from cache; any deeper
          // path is redirected to the root, where relative asset URLs resolve correctly.
          if (path === root || path === root + 'index.html') return cache.match('index.html');
          return Response.redirect(scope, 302);
        }
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    });
  }));
});
