/* Health Tracker — app.js
 * Bootstrap, hash router, bottom-tab state, shared DOM helpers, optional-module loader,
 * service-worker registration (http/https only), storage persistence request.
 * Classic script. Exposes window.HT.app and window.HT.state.
 *
 * Hook contract for modules owned by other builders (loaded if present, never required):
 *   js/trends.js        -> window.HT.trends       = { render(containerEl) }
 *   js/patterns.js      -> window.HT.patterns     = { render(containerEl) }
 *   js/import-health.js -> window.HT.importHealth = { render(containerEl) }  (shown in Settings)
 * A render() may return a cleanup function, called when the user leaves the screen.
 */
(function (HT) {
  'use strict';

  var OPTIONAL_SCRIPTS = ['js/import-health.js', 'js/trends.js', 'js/patterns.js'];
  var TABS = ['today', 'history', 'trends', 'patterns', 'settings'];
  var TITLES = { today: 'Today', history: 'History', trends: 'Trends', patterns: 'Patterns', settings: 'Settings' };

  HT.state = HT.state || { settings: null, dbError: null };

  // ---------- DOM helper (text only; never innerHTML with user data) ----------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') n.textContent = v;
        else if (k === 'class') n.className = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'value') n.value = v;
        else if (k === 'checked') n.checked = !!v;
        else n.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }

  var uid = 0;
  function nextId(prefix) { uid += 1; return (prefix || 'id') + '-' + uid; }

  // ---------- save status ----------
  var statusTimer = null;
  function status(msg, kind) {
    var s = document.getElementById('save-status');
    if (!s) return;
    clearTimeout(statusTimer);
    s.textContent = msg || '';
    s.className = 'save-status' + (kind ? ' ' + kind : '');
    if (kind === 'ok') statusTimer = setTimeout(function () { s.textContent = ''; s.className = 'save-status'; }, 4000);
  }
  function saveError(err) {
    var quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')));
    status(quota ? 'Not saved: device storage is full' : 'Not saved — try again', 'err');
  }

  // ---------- local preferences (small, non-health; wrapped because storage can throw) ----------
  function prefGet(k) { try { return window.localStorage.getItem('ht.' + k); } catch (e) { return null; } }
  function prefSet(k, v) { try { window.localStorage.setItem('ht.' + k, v); } catch (e) { /* ignore */ } }

  // ---------- router ----------
  var cleanup = null;
  var firstRoute = true;
  // T001-03: the local date the Today screen was rendered for (null when not on Today).
  var shownTodayDate = null;
  var newDayBanner = null;

  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var m = /^day\/(\d{4}-\d{2}-\d{2})$/.exec(h);
    if (m && HT.dates.isValidDateStr(m[1])) return { tab: 'day', date: m[1] };
    if (TABS.indexOf(h) >= 0) return { tab: h };
    return { tab: 'today' };
  }

  function setTitle(t) {
    var h = document.getElementById('screen-title');
    if (h) h.textContent = t;
    document.title = t + ' — Health Log';
  }

  function placeholder(container, name) {
    container.appendChild(el('section', { class: 'placeholder', 'aria-labelledby': 'ph-h' }, [
      el('h2', { id: 'ph-h', text: TITLES[name] + ' — coming soon' }),
      el('p', { text: name === 'trends'
        ? 'Charts of your last 7, 30 and 90 days will appear here.'
        : 'Plain-language patterns in your own data will appear here, with how many days they are based on.' })
    ]));
  }

  function route() {
    var r = parseHash();
    var main = document.getElementById('main');
    if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { /* ignore */ } }
    cleanup = null;
    main.textContent = '';
    newDayBanner = null;

    var today = HT.dates.todayLocal();
    shownTodayDate = r.tab === 'today' ? today : null;
    var activeTab = r.tab === 'day' ? (r.date === today ? 'today' : 'history') : r.tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tabbar a'), function (a) {
      if (a.getAttribute('data-tab') === activeTab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (HT.state.dbError && (r.tab === 'today' || r.tab === 'day' || r.tab === 'history')) {
      setTitle(TITLES[activeTab]);
      main.appendChild(el('div', { class: 'notice', role: 'alert' }, [
        el('p', { text: 'This browser could not open on-device storage, so entries can’t be saved here.' }),
        el('p', { text: 'Private browsing can cause this. Try a normal window, or another browser.' })
      ]));
      return;
    }

    try {
      if (r.tab === 'today' || r.tab === 'day') {
        var date = r.date || today;
        setTitle(date === today ? 'Today' : HT.dates.formatLong(date));
        cleanup = HT.today.render(main, { date: date });
      } else if (r.tab === 'history') {
        setTitle('History'); cleanup = HT.history.render(main);
      } else if (r.tab === 'settings') {
        setTitle('Settings'); cleanup = HT.settings.render(main);
      } else if (r.tab === 'trends' || r.tab === 'patterns') {
        setTitle(TITLES[r.tab]);
        var mod = r.tab === 'trends' ? HT.trends : HT.patterns;
        if (mod && typeof mod.render === 'function') cleanup = mod.render(main);
        else placeholder(main, r.tab);
      }
    } catch (e) {
      main.appendChild(el('div', { class: 'notice', role: 'alert' }, [el('p', { text: 'Something went wrong showing this screen. Try reloading.' })]));
    }

    if (!firstRoute) { try { main.focus({ preventScroll: false }); } catch (e) { main.focus(); } window.scrollTo(0, 0); }
    firstRoute = false;
  }

  function go(hash) {
    if (location.hash === hash) route(); else location.hash = hash;
  }

  // ---------- midnight rollover (T001-03) ----------
  // The Today screen captures its date when it renders. If the app was left open or
  // suspended past midnight, show the new day when the user comes back (the old screen's
  // cleanup flushes any pending edit into the day it belongs to). While the page stays
  // visible across midnight we don't switch under the user's fingers; we offer a banner.
  function dayChanged() {
    return shownTodayDate !== null && shownTodayDate !== HT.dates.todayLocal();
  }
  function onReturn() {
    if (document.visibilityState === 'hidden') return;
    if (dayChanged()) route();
  }
  function offerNewDay() {
    if (document.visibilityState === 'hidden' || !dayChanged() || newDayBanner) return;
    var main = document.getElementById('main');
    if (!main) return;
    newDayBanner = el('div', { class: 'banner', role: 'status' }, [
      el('p', { style: 'margin:0 0 6px', text: 'It\u2019s a new day. This screen still shows ' + HT.dates.formatLong(shownTodayDate) + '.' }),
      el('button', { type: 'button', class: 'primary', text: 'Go to today', onclick: function () { route(); } })
    ]);
    main.insertBefore(newDayBanner, main.firstChild);
  }
  function watchDayChange() {
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);
    window.addEventListener('focus', onReturn);
    setInterval(offerNewDay, 60000);
    // Tapping the tab you're already on re-renders it (no hashchange fires for the same
    // hash), which also moves Today to the new date.
    var bar = document.querySelector('.tabbar');
    if (bar) bar.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[data-tab]') : null;
      if (!a) return;
      var target = a.getAttribute('href');
      var current = location.hash || '#today';
      if (target === current) { ev.preventDefault(); route(); }
    });
  }

  // ---------- optional modules ----------
  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(true); };
      s.onerror = function () { s.remove(); resolve(false); }; // missing file: app runs without it
      document.body.appendChild(s);
    });
  }
  function loadOptionalModules() {
    return Promise.all(OPTIONAL_SCRIPTS.map(function (src) {
      return loadScript(src).catch(function () { return false; });
    }));
  }

  // ---------- platform features (feature-detected, silent on failure) ----------
  function isHttp() { return location.protocol === 'http:' || location.protocol === 'https:'; }

  function registerServiceWorker() {
    if (!isHttp() || !('serviceWorker' in navigator)) return;
    try { navigator.serviceWorker.register('sw.js').catch(function () {}); } catch (e) { /* silent */ }
  }

  function addManifest() {
    if (!isHttp()) return;
    var l = document.createElement('link');
    l.rel = 'manifest'; l.href = 'manifest.webmanifest';
    document.head.appendChild(l);
  }

  /** Ask the browser to keep our data (iOS 15.2+). Resolves true/false/null (unsupported). */
  function requestPersist() {
    try {
      if (!navigator.storage || typeof navigator.storage.persist !== 'function') return Promise.resolve(null);
      return navigator.storage.persisted().then(function (p) {
        return p ? true : navigator.storage.persist();
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function persistedState() {
    try {
      if (!navigator.storage || typeof navigator.storage.persisted !== 'function') return Promise.resolve(null);
      return navigator.storage.persisted().catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  // ---------- bootstrap ----------
  function boot() {
    addManifest();
    HT.db.open()
      .then(function () { return HT.db.getSettings(); })
      .then(function (s) { HT.state.settings = s; })
      .catch(function (e) {
        HT.state.dbError = e || new Error('db');
        HT.state.settings = JSON.parse(JSON.stringify(HT.db.SETTINGS_DEFAULTS));
      })
      .then(function () {
        window.addEventListener('hashchange', route);
        watchDayChange();
        route();
        // Ask once for persistent storage; the Settings screen shows the result and a retry.
        if (!HT.state.dbError && !prefGet('persistAsked') && isHttp()) {
          prefSet('persistAsked', '1');
          requestPersist();
        }
        return loadOptionalModules();
      })
      .then(function (loaded) {
        // Re-render if the current screen can now use a module that just loaded.
        var r = parseHash();
        if (loaded && loaded.some(Boolean) && (r.tab === 'trends' || r.tab === 'patterns' || r.tab === 'settings')) route();
        registerServiceWorker();
      });
  }

  HT.app = {
    el: el,
    nextId: nextId,
    status: status,
    saveError: saveError,
    prefGet: prefGet,
    prefSet: prefSet,
    go: go,
    route: route,
    isHttp: isHttp,
    requestPersist: requestPersist,
    persistedState: persistedState
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.HT = window.HT || {});
