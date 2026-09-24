/* Health Tracker — db.js
 * IndexedDB wrapper + backup export/restore.
 * Implements docs/team/analysis/A-002-shortcuts-and-ios-webapp.md §2 items 14–15:
 *   - unique keys per store (table below)
 *   - every user-editable record has updatedAt (ISO UTC); deletes leave a tombstone
 *   - merge: newer updatedAt wins; tie keeps the existing record; tombstones propagate
 *   - imported health records (steps, sleepSamples) are immutable in merge
 *   - backup file { app, schemaVersion, exportedAt, stores } with version check + migration
 *
 *  Store         keyPath   key value
 *  dailyLog      date      "YYYY-MM-DD" (local)
 *  meals         id        UUID (crypto.randomUUID, getRandomValues fallback)
 *  steps         key       date + ':' + origin           (origin: shortcut | export)
 *  sleepSamples  key       origin|stage|startMs|endMs|source   (ms = UTC epoch)
 *  settings      key       "settings" (singleton)
 *  tombstones    key       store + '|' + recordKey   { store, id, deletedAt }
 *
 * Classic script. Exposes window.HT.db. Never logs record contents.
 */
(function (HT) {
  'use strict';

  var D = HT.dates;

  var DB_NAME_DEFAULT = 'health-tracker';
  var DB_VERSION = 1;          // IndexedDB structural version
  var SCHEMA_VERSION = 1;      // backup-file / record schema version
  var APP_ID = 'health-tracker';

  var STORES = ['dailyLog', 'meals', 'steps', 'sleepSamples', 'settings', 'tombstones'];
  var DATA_STORES = ['dailyLog', 'meals', 'steps', 'sleepSamples', 'settings'];
  var EDITABLE = ['dailyLog', 'meals', 'settings'];     // last-write-wins + tombstones
  var IMPORTED = ['steps', 'sleepSamples'];              // immutable in backup merge
  var KEY_PATH = { dailyLog: 'date', meals: 'id', steps: 'key', sleepSamples: 'key', settings: 'key', tombstones: 'key' };

  var RATINGS = ['anxiety', 'mood', 'energy', 'stress'];
  var TAGS = ['sensory', 'schedule-change', 'social', 'work-school', 'caregiving', 'other'];
  var CARBS = ['low', 'med', 'high'];
  var STEP_ORIGINS = ['shortcut', 'export'];
  var SLEEP_STAGES = ['inBed', 'awake', 'asleepCore', 'asleepDeep', 'asleepREM', 'asleepUnspecified', 'unknown'];
  var EPOCH_ISO = '1970-01-01T00:00:00.000Z';

  var SETTINGS_DEFAULTS = {
    key: 'settings',
    glucoseUnit: 'mg/dL',
    rangeLowMgdl: null,    // user-set range (with their care team); blank by default
    rangeHighMgdl: null,
    updatedAt: EPOCH_ISO
  };

  // ---------- keys ----------
  var keys = {
    steps: function (date, origin) { return date + ':' + origin; },
    sleep: function (s) { return s.origin + '|' + s.stage + '|' + s.startMs + '|' + s.endMs + '|' + s.source; },
    tombstone: function (store, id) { return store + '|' + id; }
  };

  /** Random UUID v4. crypto.randomUUID needs Safari iOS 15.4+ and a secure context
   *  (not file:// in every browser), so fall back to getRandomValues. */
  function newId() {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    try { if (c && typeof c.randomUUID === 'function') return c.randomUUID(); } catch (e) { /* fall through */ }
    var b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); // last resort only
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
      h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  // ---------- IndexedDB open + migrations ----------
  // Each entry upgrades the structure FROM version (n-1) TO n. Add a new entry for every
  // schema change; never edit an old one.
  var migrations = {
    1: function (db /*, tx */) {
      db.createObjectStore('dailyLog', { keyPath: 'date' });
      var meals = db.createObjectStore('meals', { keyPath: 'id' });
      meals.createIndex('date', 'date', { unique: false });
      var steps = db.createObjectStore('steps', { keyPath: 'key' });
      steps.createIndex('date', 'date', { unique: false });
      var sleep = db.createObjectStore('sleepSamples', { keyPath: 'key' });
      sleep.createIndex('startMs', 'startMs', { unique: false });
      sleep.createIndex('origin', 'origin', { unique: false });
      db.createObjectStore('settings', { keyPath: 'key' });
      var tomb = db.createObjectStore('tombstones', { keyPath: 'key' });
      tomb.createIndex('store', 'store', { unique: false });
    }
  };

  var dbName = DB_NAME_DEFAULT;
  var dbPromise = null;

  function configure(opts) {
    if (opts && opts.name) { dbName = opts.name; dbPromise = null; }
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser.')); return; }
      var req;
      try { req = indexedDB.open(dbName, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function (ev) {
        var db = req.result, tx = req.transaction;
        for (var v = ev.oldVersion + 1; v <= DB_VERSION; v++) {
          if (migrations[v]) migrations[v](db, tx);
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('Could not open the database.')); };
      req.onblocked = function () { reject(new Error('The database is open in another tab. Close other tabs and reload.')); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function close() {
    if (!dbPromise) return Promise.resolve();
    var p = dbPromise; dbPromise = null;
    return p.then(function (db) { db.close(); }, function () {});
  }

  function deleteDatabase(name) {
    return close().then(function () {
      return new Promise(function (resolve, reject) {
        var r = indexedDB.deleteDatabase(name || dbName);
        r.onsuccess = function () { resolve(); };
        r.onerror = function () { reject(r.error); };
        r.onblocked = function () { resolve(); };
      });
    });
  }

  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  /** Run fn(tx) in a transaction; resolves with fn's return value after commit. */
  function withTx(storeNames, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, out;
        try { tx = db.transaction(storeNames, mode); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
        try {
          var r = fn(tx);
          if (r && typeof r.then === 'function') r.then(function (v) { out = v; }, function (e) { try { tx.abort(); } catch (x) {} reject(e); });
          else out = r;
        } catch (e) { try { tx.abort(); } catch (x) {} reject(e); }
      });
    });
  }

  function get(store, key) {
    return withTx([store], 'readonly', function (tx) { return reqP(tx.objectStore(store).get(key)); });
  }
  function getAll(store) {
    return withTx([store], 'readonly', function (tx) { return reqP(tx.objectStore(store).getAll()); });
  }
  function getAllByIndex(store, index, value) {
    return withTx([store], 'readonly', function (tx) { return reqP(tx.objectStore(store).index(index).getAll(value)); });
  }

  /** Save a user-editable record: stamps updatedAt and clears any tombstone for its key. */
  function putEditable(store, rec) {
    if (EDITABLE.indexOf(store) < 0) return Promise.reject(new Error('Not an editable store'));
    var copy = JSON.parse(JSON.stringify(rec));
    copy.updatedAt = D.nowIso();
    var id = copy[KEY_PATH[store]];
    return withTx([store, 'tombstones'], 'readwrite', function (tx) {
      tx.objectStore(store).put(copy);
      tx.objectStore('tombstones').delete(keys.tombstone(store, id));
      return copy;
    });
  }

  /** Delete a user-editable record and leave a tombstone so older backups can't revive it. */
  function removeEditable(store, id) {
    if (EDITABLE.indexOf(store) < 0) return Promise.reject(new Error('Not an editable store'));
    return withTx([store, 'tombstones'], 'readwrite', function (tx) {
      tx.objectStore(store).delete(id);
      tx.objectStore('tombstones').put({ key: keys.tombstone(store, id), store: store, id: id, deletedAt: D.nowIso() });
    });
  }

  /** Put records into an imported-data store (steps / sleepSamples). For importer modules. */
  function putImported(store, records) {
    if (IMPORTED.indexOf(store) < 0) return Promise.reject(new Error('Not an imported-data store'));
    return withTx([store], 'readwrite', function (tx) {
      var os = tx.objectStore(store);
      records.forEach(function (r) { os.put(r); });
      return records.length;
    });
  }

  // ---------- convenience API used by screens ----------
  function getSettings() {
    return get('settings', 'settings').then(function (s) {
      var out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
      if (s) Object.keys(s).forEach(function (k) { out[k] = s[k]; });
      return out;
    });
  }
  function saveSettings(s) { s.key = 'settings'; return putEditable('settings', s); }

  function emptyDailyLog(date) {
    return { date: date, anxiety: null, mood: null, energy: null, stress: null, hardToTell: [], tags: [], notes: '', updatedAt: EPOCH_ISO };
  }
  function getDailyLog(date) { return get('dailyLog', date); }
  function saveDailyLog(rec) { return putEditable('dailyLog', rec); }
  function getMealsForDate(date) {
    return getAllByIndex('meals', 'date', date).then(function (list) {
      return list.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
    });
  }
  function saveMeal(m) {
    if (!m.id) m.id = newId();
    if (!m.createdAt) m.createdAt = D.nowIso();
    return putEditable('meals', m);
  }
  function deleteMeal(id) { return removeEditable('meals', id); }

  // ---------- validation (used for backup import) ----------
  function isIntIn(v, lo, hi) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi; }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
  function isoOr(v, fallback) { return D.isIso(v) ? v : fallback; }

  var sanitize = {
    dailyLog: function (r) {
      if (!r || !D.isValidDateStr(r.date)) return null;
      var o = { date: r.date };
      RATINGS.forEach(function (k) { o[k] = isIntIn(r[k], 0, 10) ? r[k] : null; });
      o.hardToTell = Array.isArray(r.hardToTell) ? r.hardToTell.filter(function (k) { return RATINGS.indexOf(k) >= 0 && o[k] === null; }) : [];
      o.tags = Array.isArray(r.tags) ? r.tags.filter(function (t) { return TAGS.indexOf(t) >= 0; }) : [];
      o.notes = str(r.notes, 20000);
      o.updatedAt = isoOr(r.updatedAt, EPOCH_ISO);
      return o;
    },
    meals: function (r) {
      if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(r.id)) return null;
      if (!D.isValidDateStr(r.date) || !D.isValidTime(r.time)) return null;
      var o = { id: r.id, date: r.date, time: r.time };
      o.carb = CARBS.indexOf(r.carb) >= 0 ? r.carb : null;
      var g = r.glucose;
      if (g && HT.units.isUnit(g.unit) && typeof g.value === 'number' && isFinite(g.value) &&
          g.value >= HT.units.INPUT_LIMITS[g.unit].min && g.value <= HT.units.INPUT_LIMITS[g.unit].max) {
        o.glucose = { value: g.value, unit: g.unit };
      } else o.glucose = null;
      o.note = str(r.note, 2000);
      o.createdAt = isoOr(r.createdAt, EPOCH_ISO);
      o.updatedAt = isoOr(r.updatedAt, EPOCH_ISO);
      return o;
    },
    settings: function (r) {
      if (!r) return null;
      var o = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
      if (HT.units.isUnit(r.glucoseUnit)) o.glucoseUnit = r.glucoseUnit;
      ['rangeLowMgdl', 'rangeHighMgdl'].forEach(function (k) {
        o[k] = (typeof r[k] === 'number' && isFinite(r[k]) && r[k] > 0 && r[k] <= 1000) ? r[k] : null;
      });
      o.updatedAt = isoOr(r.updatedAt, EPOCH_ISO);
      return o;
    },
    // Imported stores: the importer modules own the extra fields; we check the key fields
    // and that the stored key matches the one derived from them.
    steps: function (r) {
      if (!r || !D.isValidDateStr(r.date) || STEP_ORIGINS.indexOf(r.origin) < 0) return null;
      if (!(r.value === null || isIntIn(r.value, 0, 1000000))) return null;
      var o = JSON.parse(JSON.stringify(r));
      o.key = keys.steps(r.date, r.origin);
      return o;
    },
    sleepSamples: function (r) {
      if (!r || STEP_ORIGINS.indexOf(r.origin) < 0 || SLEEP_STAGES.indexOf(r.stage) < 0) return null;
      if (!isIntIn(r.startMs, 0, 1e14) || !isIntIn(r.endMs, 0, 1e14) || r.endMs < r.startMs) return null;
      if (typeof r.source !== 'string') return null;
      var o = JSON.parse(JSON.stringify(r));
      o.key = keys.sleep(r);
      return o;
    },
    tombstones: function (r) {
      if (!r || EDITABLE.indexOf(r.store) < 0 || typeof r.id !== 'string' || !r.id || !D.isIso(r.deletedAt)) return null;
      return { key: keys.tombstone(r.store, r.id), store: r.store, id: r.id, deletedAt: r.deletedAt };
    }
  };

  // ---------- backup file ----------
  // Upgrades a backup object FROM schemaVersion (n-1) TO n. Add one per schema change.
  var backupMigrations = {
    // 2: function (b) { ...; return b; }
  };

  /**
   * Validate + migrate + sanitize a parsed backup object.
   * Returns { ok, error?, backup?, skipped } where backup.stores holds clean arrays.
   */
  function prepareBackup(obj) {
    if (!obj || typeof obj !== 'object' || obj.app !== APP_ID) {
      return { ok: false, error: 'This file is not a Health Tracker backup.' };
    }
    var v = obj.schemaVersion;
    if (!isIntIn(v, 1, 1000000)) return { ok: false, error: 'The backup has no valid schema version.' };
    if (v > SCHEMA_VERSION) {
      return { ok: false, error: 'This backup was made by a newer version of the app (schema ' + v + '). Update the app first.' };
    }
    if (!obj.stores || typeof obj.stores !== 'object') return { ok: false, error: 'The backup has no data section.' };
    var b = JSON.parse(JSON.stringify(obj));
    for (var n = v + 1; n <= SCHEMA_VERSION; n++) {
      if (backupMigrations[n]) b = backupMigrations[n](b);
    }
    b.schemaVersion = SCHEMA_VERSION;
    var clean = {}, skipped = 0;
    STORES.forEach(function (s) {
      var arr = Array.isArray(b.stores[s]) ? b.stores[s] : [];
      var seen = {};
      clean[s] = [];
      arr.forEach(function (r) {
        var c = sanitize[s](r);
        if (!c) { skipped++; return; }
        var k = c[KEY_PATH[s]];
        if (seen[k] !== undefined) {
          // Duplicate key inside one file: keep the newer one.
          var prev = clean[s][seen[k]];
          if (recTime(c, s) > recTime(prev, s)) clean[s][seen[k]] = c;
          skipped++;
          return;
        }
        seen[k] = clean[s].length;
        clean[s].push(c);
      });
    });
    return { ok: true, skipped: skipped, backup: { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: b.exportedAt, stores: clean } };
  }

  function recTime(r, store) {
    if (!r) return -Infinity;
    var t = D.isoToMs(store === 'tombstones' ? r.deletedAt : r.updatedAt);
    return isNaN(t) ? 0 : t;
  }

  /**
   * PURE merge planner (no IndexedDB) — unit-tested in tests/tests.js.
   * existing / incoming: { dailyLog:[], meals:[], steps:[], sleepSamples:[], settings:[], tombstones:[] }
   * Rules (A-002 §2 item 14):
   *  - editable stores: per key, the candidate with the newest time wins, where a record's
   *    time is updatedAt and a tombstone's time is deletedAt. Ties keep what already exists.
   *    If a tombstone wins, the record is deleted and the tombstone kept; if a record wins,
   *    any tombstone for that key is removed.
   *  - imported stores: add records whose key doesn't exist yet; never overwrite.
   * Returns { puts:{store:[rec]}, deletes:{store:[key]}, counts:{added,updated,deleted,unchanged} }.
   */
  function planMerge(existing, incoming) {
    var puts = {}, deletes = {};
    STORES.forEach(function (s) { puts[s] = []; deletes[s] = []; });
    var counts = { added: 0, updated: 0, deleted: 0, unchanged: 0 };

    function index(arr, kp) { var m = {}; (arr || []).forEach(function (r) { m[r[kp]] = r; }); return m; }
    var exTomb = index(existing.tombstones, 'key');
    var inTomb = index(incoming.tombstones, 'key');

    EDITABLE.forEach(function (s) {
      var kp = KEY_PATH[s];
      var exRec = index(existing[s], kp), inRec = index(incoming[s], kp);
      var allKeys = {};
      Object.keys(exRec).forEach(function (k) { allKeys[k] = 1; });
      Object.keys(inRec).forEach(function (k) { allKeys[k] = 1; });
      Object.keys(exTomb).forEach(function (tk) { if (exTomb[tk].store === s) allKeys[exTomb[tk].id] = 1; });
      Object.keys(inTomb).forEach(function (tk) { if (inTomb[tk].store === s) allKeys[inTomb[tk].id] = 1; });

      Object.keys(allKeys).forEach(function (id) {
        var tk = keys.tombstone(s, id);
        // Current state on this device (a live record and a tombstone should not coexist,
        // but if they do, the newer one is the truth; tie -> record).
        var cur = null;
        if (exRec[id]) cur = { kind: 'rec', v: exRec[id], t: recTime(exRec[id], s) };
        if (exTomb[tk]) {
          var tt = recTime(exTomb[tk], 'tombstones');
          if (!cur || tt > cur.t) cur = { kind: 'tomb', v: exTomb[tk], t: tt };
        }
        var start = cur;
        // Incoming candidates replace only when strictly newer.
        if (inRec[id]) {
          var rt = recTime(inRec[id], s);
          if (!cur || rt > cur.t) cur = { kind: 'rec', v: inRec[id], t: rt, incoming: true };
        }
        if (inTomb[tk]) {
          var it = recTime(inTomb[tk], 'tombstones');
          if (!cur || it > cur.t) cur = { kind: 'tomb', v: inTomb[tk], t: it, incoming: true };
        }
        if (!cur.incoming) { counts.unchanged++; return; }
        if (cur.kind === 'rec') {
          puts[s].push(cur.v);
          if (exTomb[tk]) deletes.tombstones.push(tk);
          if (!start || start.kind === 'tomb') counts.added++; else counts.updated++;
        } else {
          puts.tombstones.push(cur.v);
          if (exRec[id]) { deletes[s].push(id); counts.deleted++; }
          else counts.unchanged++;
        }
      });
    });

    IMPORTED.forEach(function (s) {
      var kp = KEY_PATH[s];
      var exRec = index(existing[s], kp);
      (incoming[s] || []).forEach(function (r) {
        if (exRec[r[kp]]) { counts.unchanged++; return; }
        puts[s].push(r); counts.added++;
      });
    });

    return { puts: puts, deletes: deletes, counts: counts };
  }

  function snapshot() {
    return withTx(STORES, 'readonly', function (tx) {
      var out = {};
      return Promise.all(STORES.map(function (s) {
        return reqP(tx.objectStore(s).getAll()).then(function (arr) { out[s] = arr; });
      })).then(function () { return out; });
    });
  }

  /** Build the backup object (caller turns it into a file). */
  function exportAll() {
    return snapshot().then(function (stores) {
      return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: D.nowIso(), stores: stores };
    });
  }

  function applyPlan(plan) {
    return withTx(STORES, 'readwrite', function (tx) {
      STORES.forEach(function (s) {
        var os = tx.objectStore(s);
        plan.deletes[s].forEach(function (k) { os.delete(k); });
        plan.puts[s].forEach(function (r) { os.put(r); });
      });
    });
  }

  /**
   * Restore from a parsed backup object.
   * mode 'merge' (default) or 'replace' (wipe every store, then load the backup).
   * Resolves { ok, error?, counts?, skipped? }.
   */
  function importBackup(obj, mode) {
    var prep = prepareBackup(obj);
    if (!prep.ok) return Promise.resolve(prep);
    var inc = prep.backup.stores;
    if (mode === 'replace') {
      return withTx(STORES, 'readwrite', function (tx) {
        STORES.forEach(function (s) {
          var os = tx.objectStore(s);
          os.clear();
          inc[s].forEach(function (r) { os.put(r); });
        });
      }).then(function () {
        var n = 0; DATA_STORES.forEach(function (s) { n += inc[s].length; });
        return { ok: true, mode: 'replace', counts: { added: n, updated: 0, deleted: 0, unchanged: 0 }, skipped: prep.skipped };
      });
    }
    return snapshot().then(function (ex) {
      var plan = planMerge(ex, inc);
      return applyPlan(plan).then(function () {
        return { ok: true, mode: 'merge', counts: plan.counts, skipped: prep.skipped };
      });
    });
  }

  HT.db = {
    DB_VERSION: DB_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    APP_ID: APP_ID,
    STORES: STORES,
    EDITABLE: EDITABLE,
    IMPORTED: IMPORTED,
    KEY_PATH: KEY_PATH,
    RATINGS: RATINGS,
    TAGS: TAGS,
    CARBS: CARBS,
    SLEEP_STAGES: SLEEP_STAGES,
    STEP_ORIGINS: STEP_ORIGINS,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    keys: keys,
    newId: newId,
    configure: configure,
    open: open,
    close: close,
    deleteDatabase: deleteDatabase,
    get: get,
    getAll: getAll,
    getAllByIndex: getAllByIndex,
    putEditable: putEditable,
    removeEditable: removeEditable,
    putImported: putImported,
    withTx: withTx,
    getSettings: getSettings,
    saveSettings: saveSettings,
    emptyDailyLog: emptyDailyLog,
    getDailyLog: getDailyLog,
    saveDailyLog: saveDailyLog,
    getMealsForDate: getMealsForDate,
    saveMeal: saveMeal,
    deleteMeal: deleteMeal,
    sanitize: sanitize,
    prepareBackup: prepareBackup,
    planMerge: planMerge,
    snapshot: snapshot,
    exportAll: exportAll,
    importBackup: importBackup
  };
})(window.HT = window.HT || {});
