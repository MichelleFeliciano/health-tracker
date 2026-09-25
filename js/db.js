/* Health Tracker — db.js
 * IndexedDB wrapper + backup export/restore.
 * Implements docs/team/analysis/A-002-shortcuts-and-ios-webapp.md §2 items 14–15:
 *   - unique keys per store (table below)
 *   - every user-editable record has updatedAt (ISO UTC); deletes leave a tombstone
 *   - merge: newer updatedAt wins; tie keeps the existing record; tombstones propagate
 *   - imported health records (steps, sleepSamples) are immutable in merge
 *   - healthDays (per-day sleep from the full export) are last-write-wins by updatedAt with
 *     tombstones; merge key date + ':' + origin (Architect brief, schema v3)
 *   - backup file { app, schemaVersion, exportedAt, stores } with version check + migration
 *
 *  Store         keyPath   key value
 *  dailyLog      date      "YYYY-MM-DD" (local)
 *  meals         id        UUID (crypto.randomUUID, getRandomValues fallback)
 *  steps         key       date + ':' + origin           (origin: shortcut | export)
 *  healthDays    key       date + ':' + origin           (v3; origin: export)
 *  sleepSamples  key       origin|stage|startMs|endMs|source   (ms = UTC epoch)
 *  settings      key       "settings" (singleton)
 *  tombstones    key       store + '|' + recordKey   { store, id, deletedAt }
 *
 *  Record shapes (schema 3):
 *  meals       { id, date, time "HH:MM", carb low|med|high|null,
 *                glucose { value, unit, minutesAfter? } | null, note, createdAt, updatedAt }
 *              minutesAfter = integer 0–720: minutes from the start of the meal to the reading,
 *              as reported by the user. The key is ABSENT when unknown (never null, never
 *              guessed) — A-005 Part 2.
 *  steps       { key, date, origin, value int|null, ...importer fields }   (steps only)
 *  healthDays  { key, date, origin, kind, asleepMin, …SLEEP_DAY_FIELDS…, updatedAt }
 *  settings    { key, glucoseUnit, rangeLowMgdl, rangeHighMgdl, rangeNoticeOn,
 *                sourcePriority { steps: [{key, cls, name}] | null, sleep: … } | null,
 *                lastExportDate ISO UTC | null, updatedAt }
 *              lastExportDate = the latest <ExportDate> of any full export imported (A-006 RC-1).
 *
 *  Schema history (backup schemaVersion; IndexedDB DB_VERSION uses the same numbers):
 *  1  first release
 *  2  settings.rangeNoticeOn (T001-13)
 *  3  meals[].glucose.minutesAfter (optional int 0–720, A-005 Part 2); healthDays store
 *     (full-export per-day sleep moved out of `steps`); settings.sourcePriority (moved out of
 *     localStorage so backups include it) — decisions.md 2026-09-23 "Schema v3"
 *
 * Classic script. Exposes window.HT.db. Never logs record contents.
 */
(function (HT) {
  'use strict';

  var D = HT.dates;

  var DB_NAME_DEFAULT = 'health-tracker';
  var DB_VERSION = 3;          // IndexedDB version (2: rangeNoticeOn; 3: healthDays store — see header)
  var SCHEMA_VERSION = 3;      // backup-file / record schema version (see "Schema history" above)
  // 3: meals[].glucose.minutesAfter (optional int 0–720)
  var APP_ID = 'health-tracker';
  var MINUTES_AFTER_MAX = 720; // typo guard only (A-005 Part 2), never shown as guidance: 12 h

  var STORES = ['dailyLog', 'meals', 'steps', 'healthDays', 'sleepSamples', 'settings', 'tombstones'];
  var EDITABLE = ['dailyLog', 'meals', 'settings'];     // user-edited: putEditable / removeEditable
  var LWW = ['dailyLog', 'meals', 'settings', 'healthDays']; // last-write-wins + tombstones in merge
  var IMPORTED = ['steps', 'sleepSamples'];              // immutable in backup merge (add-only)
  var KEY_PATH = { dailyLog: 'date', meals: 'id', steps: 'key', healthDays: 'key', sleepSamples: 'key', settings: 'key', tombstones: 'key' };
  // What counts as "data" for the Replace-all guard, its confirm and its result message
  // (A-005 R1-1/R1-2): days, meals, steps and sleep records only. Settings and tombstones are
  // never counted as data. countDataRecords() is the ONE function all three use.
  var DATA_COUNT_STORES = ['dailyLog', 'meals', 'steps', 'healthDays', 'sleepSamples'];

  var RATINGS = ['anxiety', 'mood', 'energy', 'stress'];
  var TAGS = ['sensory', 'schedule-change', 'social', 'work-school', 'caregiving', 'other'];
  var CARBS = ['low', 'med', 'high'];
  var STEP_ORIGINS = ['shortcut', 'export'];
  var SLEEP_STAGES = ['inBed', 'awake', 'asleepCore', 'asleepDeep', 'asleepREM', 'asleepUnspecified', 'unknown'];
  var EPOCH_ISO = '1970-01-01T00:00:00.000Z';
  var SLEEP_KINDS = ['night', 'inBedOnly', 'napOnly'];
  // Per-day sleep fields (R-001 §6.1 SleepDay), in this order. Must match
  // HT.healthAgg.emptySleepFields() (checked in tests/import-tests.js). Grouped by type below.
  var SLEEP_DAY_FIELDS = ['kind', 'asleepMin', 'inBedMin', 'awakeMin', 'coreMin', 'deepMin', 'remMin', 'unspecifiedMin',
    'hasStages', 'sessionCount', 'sleepStart', 'sleepEnd', 'sourceUsed', 'inBedSource', 'partial', 'uncoveredMin',
    'altSource', 'altAsleepMin', 'napMin', 'napCount', 'napSources'];
  var SLEEP_NUM_ZERO = ['sessionCount', 'uncoveredMin', 'napMin', 'napCount'];   // number, default 0
  var SLEEP_BOOL = ['hasStages', 'partial'];
  var SLEEP_STR_OR_NULL = ['sourceUsed', 'inBedSource', 'altSource'];
  // every other field except kind/napSources: number or null

  var SETTINGS_DEFAULTS = {
    key: 'settings',
    glucoseUnit: 'mg/dL',
    rangeLowMgdl: null,    // user-set range (with their care team); blank by default
    rangeHighMgdl: null,
    // Out-of-range notice is OPT-IN and off by default (decisions.md 2026-09-23 amendment,
    // A-003: a user-set range lowers but does not remove FDA device-function risk).
    // Only a strict boolean true turns it on; saving a range never turns it on.
    rangeNoticeOn: false,
    // Apple Health source priority (R-001 §6.0.3 user override): { steps, sleep } lists of
    // {key, cls, name}, or null = default order. Moved here from localStorage in schema v3 so
    // backups include it (decisions.md 2026-09-23 "Schema v3").
    sourcePriority: null,
    // The latest <ExportDate> of any full export imported on this device (ISO UTC), or null.
    // An export dated strictly earlier needs an explicit confirm before it is applied, because
    // it would replace newer sleep/step data for the days it covers (A-006 RC-1; decisions.md
    // 2026-09-24 "A-006 rulings"). Added within schema 3 (v3 has not shipped): no version bump;
    // migration 3 and sanitize.settings fill it with null. Raised only by putExportDays and by
    // a merge (the later of the two); raising it never stamps updatedAt (not a user edit).
    lastExportDate: null,
    updatedAt: EPOCH_ISO
  };

  // ---------- keys ----------
  var keys = {
    steps: function (date, origin) { return date + ':' + origin; },
    healthDay: function (date, origin) { return date + ':' + origin; },
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
    },
    // v2 (T001-13): settings gain rangeNoticeOn. Existing installs get an explicit false.
    // updatedAt is left alone: this is a schema fill-in, not a user edit, so it must not
    // win a backup merge against a real change made on another device.
    2: function (db, tx) {
      var os = tx.objectStore('settings');
      var r = os.get('settings');
      r.onsuccess = function () {
        var s = r.result;
        if (s && typeof s.rangeNoticeOn !== 'boolean') { s.rangeNoticeOn = false; os.put(s); }
      };
    },
    // v3 (schema v3): new healthDays store. Full-export per-day sleep fields move out of the
    // `steps` store into it, using splitExportSteps (the same function as backupMigrations[3]).
    // No data loss: every sleep field is copied before it is removed from the step record, and
    // a step record is deleted only when it held no step count and its sleep was moved.
    // Idempotent: a record with no sleep fields left is not touched again, and puts are keyed.
    // Moved records get updatedAt = EPOCH: this is a schema move, not a new import, so it
    // never wins a merge against a real import made elsewhere (same reasoning as v2).
    // Settings get an explicit sourcePriority:null (updatedAt unchanged, as in v2); the
    // localStorage order is moved later, once, by HT.healthData (page only; js/health-agg.js).
    3: function (db, tx) {
      var hd = db.objectStoreNames.contains('healthDays') ? tx.objectStore('healthDays')
        : db.createObjectStore('healthDays', { keyPath: 'key' });
      if (!hd.indexNames.contains('date')) hd.createIndex('date', 'date', { unique: false });
      var cur = tx.objectStore('steps').openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c) return;
        var sp = splitExportSteps(c.value, EPOCH_ISO);
        if (sp.changed) {
          if (sp.healthDay) hd.put(sp.healthDay);
          if (sp.steps) c.update(sp.steps); else c.delete();
        }
        c.continue();
      };
      // Fill EVERY missing default field (not only sourcePriority): when upgrading from v1,
      // migration 2's get/put and this get run in the same transaction, and this get returns
      // the record as it was before migration 2's put, so this put must carry
      // rangeNoticeOn:false too or it would undo migration 2 (found by the LB1 v1→v2 test).
      var os = tx.objectStore('settings');
      var r = os.get('settings');
      r.onsuccess = function () {
        var s = r.result;
        if (!s) return;
        var changed = false;
        Object.keys(SETTINGS_DEFAULTS).forEach(function (k) {
          if (k === 'updatedAt' || Object.prototype.hasOwnProperty.call(s, k)) return;
          s[k] = SETTINGS_DEFAULTS[k]; changed = true;
        });
        if (typeof s.rangeNoticeOn !== 'boolean') { s.rangeNoticeOn = false; changed = true; }
        if (changed) os.put(s);
      };
    }
  };

  // ---------- healthDays records (schema v3) ----------
  function numOrNull(v) { return (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1e14) ? v : null; }

  /**
   * THE builder for a healthDays record (used by the importer, the DB/backup migrations and
   * the backup sanitizer, so all three give identical records). src = any object carrying the
   * SleepDay fields plus `date`. Returns null when src has no valid date or no sleep kind.
   */
  function makeHealthDay(src, origin, updatedAt) {
    if (!src || !D.isValidDateStr(src.date) || STEP_ORIGINS.indexOf(origin) < 0) return null;
    if (SLEEP_KINDS.indexOf(src.kind) < 0) return null;
    var o = { key: keys.healthDay(src.date, origin), date: src.date, origin: origin };
    SLEEP_DAY_FIELDS.forEach(function (k) {
      var v = src[k];
      if (k === 'kind') o.kind = v;
      else if (k === 'napSources') o.napSources = Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }).map(function (x) { return x.slice(0, 500); }) : [];
      else if (SLEEP_BOOL.indexOf(k) >= 0) o[k] = v === true;
      else if (SLEEP_STR_OR_NULL.indexOf(k) >= 0) o[k] = typeof v === 'string' ? v.slice(0, 500) : null;
      else if (SLEEP_NUM_ZERO.indexOf(k) >= 0) o[k] = numOrNull(v) === null ? 0 : v;
      else o[k] = numOrNull(v);
    });
    o.updatedAt = isoOr(updatedAt, EPOCH_ISO);
    return o;
  }

  /**
   * Split a pre-v3 `steps` record: an export-origin record that still carries the per-day
   * sleep fields gives { changed:true, steps: record without them | null, healthDay | null }.
   * steps is null (delete) only when the record had no step count AND its sleep was moved.
   * Anything else (Shortcut records, already-split records) → { changed:false }.
   */
  function splitExportSteps(rec, updatedAt) {
    if (!rec || rec.origin !== 'export') return { changed: false };
    var has = SLEEP_DAY_FIELDS.some(function (k) { return Object.prototype.hasOwnProperty.call(rec, k); });
    if (!has) return { changed: false };
    var hd = makeHealthDay(rec, 'export', updatedAt);
    var st = JSON.parse(JSON.stringify(rec));
    SLEEP_DAY_FIELDS.forEach(function (k) { delete st[k]; });
    var noSteps = st.value === null || st.value === undefined;
    return { changed: true, steps: (noSteps && hd) ? null : st, healthDay: hd };
  }

  /** Source-priority lists from settings or a backup: invalid entries dropped; empty → null. */
  function sanitizePriority(v) {
    if (!v || typeof v !== 'object') return null;
    var out = { steps: null, sleep: null }, any = false;
    ['steps', 'sleep'].forEach(function (t) {
      if (!Array.isArray(v[t])) return;
      var seen = {}, list = [];
      v[t].slice(0, 500).forEach(function (x) {
        if (!x || typeof x.key !== 'string' || !x.key || x.key.length > 1000 || seen[x.key]) return;
        if (!(typeof x.cls === 'number' && Math.floor(x.cls) === x.cls && x.cls >= 0 && x.cls <= 3)) return;
        seen[x.key] = true;
        list.push({ key: x.key, cls: x.cls, name: typeof x.name === 'string' ? x.name.slice(0, 500) : '' });
      });
      if (list.length) { out[t] = list; any = true; }
    });
    return any ? out : null;
  }

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

  /** The later of two ISO UTC strings (either may be null/invalid); null when neither is valid. */
  function laterIso(a, b) {
    var ta = D.isoToMs(a), tb = D.isoToMs(b);
    if (ta !== ta) return tb === tb ? b : null;
    if (tb !== tb) return a;
    return tb > ta ? b : a;
  }

  /**
   * Commit one full-export import in ONE transaction (nothing is written if it fails, AT-12).
   * plan = { steps: [stepRecord], healthDays: [healthDay], deleteSteps: [key], deleteHealthDays: [key],
   *          exportDate?: ISO UTC | null }
   * (built by HT.healthAgg.toExportPlan; exportDate is added by js/import-health.js). A day in
   * the file overwrites that day's export records, as before v3: a day with no step count
   * removes an old export step record, and a day with no sleep removes an old export healthDay
   * (with a tombstone, so an older backup can't bring it back — A-002 §2 item 14). New
   * healthDays clear any tombstone for their key.
   * settings.lastExportDate is raised to plan.exportDate when that is later (A-006 RC-1), in
   * the same transaction; updatedAt is kept (an import is not a settings edit).
   * Resolves { written, removedSteps, removedSleep }. removed* count only records that really
   * existed and were deleted (T004-01), so the import summary can say what was removed.
   */
  function putExportDays(plan) {
    return withTx(['steps', 'healthDays', 'tombstones', 'settings'], 'readwrite', function (tx) {
      var st = tx.objectStore('steps'), hd = tx.objectStore('healthDays'), tb = tx.objectStore('tombstones');
      var now = D.nowIso();
      var out = { written: (plan.steps || []).length + (plan.healthDays || []).length, removedSteps: 0, removedSleep: 0 };
      (plan.deleteSteps || []).forEach(function (k) {
        var g = st.get(k);
        g.onsuccess = function () {
          if (!g.result) return;
          st.delete(k);
          out.removedSteps++;
        };
      });
      (plan.steps || []).forEach(function (r) { st.put(r); });
      (plan.healthDays || []).forEach(function (r) { hd.put(r); tb.delete(keys.tombstone('healthDays', r.key)); });
      (plan.deleteHealthDays || []).forEach(function (k) {
        var g = hd.get(k);
        g.onsuccess = function () {
          if (!g.result) return;
          hd.delete(k);
          tb.put({ key: keys.tombstone('healthDays', k), store: 'healthDays', id: k, deletedAt: now });
          out.removedSleep++;
        };
      });
      if (D.isIso(plan.exportDate)) {
        var os = tx.objectStore('settings');
        var gs = os.get('settings');
        gs.onsuccess = function () {
          var cur = gs.result;
          var later = laterIso(cur ? cur.lastExportDate : null, plan.exportDate);
          if (cur && later === cur.lastExportDate) return;
          var rec = buildSettings(cur, { lastExportDate: later });
          rec.updatedAt = cur ? isoOr(cur.updatedAt, EPOCH_ISO) : EPOCH_ISO;
          os.put(rec);
        };
      }
      return out;   // the counters are filled by the callbacks above; read after commit
    });
  }

  // ---------- convenience API used by screens ----------
  /** A complete settings record: defaults, then cur, then patch; normalised fields. */
  function buildSettings(cur, patch) {
    var out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
    if (cur) Object.keys(cur).forEach(function (k) { out[k] = cur[k]; });
    if (patch) Object.keys(patch).forEach(function (k) { out[k] = patch[k]; });
    out.key = 'settings';
    // T001-13: always store the opt-in as a real boolean (strict true only), so a saved
    // record and its backup/restore copy are identical.
    out.rangeNoticeOn = out.rangeNoticeOn === true;
    out.sourcePriority = sanitizePriority(out.sourcePriority);
    out.lastExportDate = D.isIso(out.lastExportDate) ? out.lastExportDate : null;
    return JSON.parse(JSON.stringify(out));
  }
  function getSettings() {
    return get('settings', 'settings').then(function (s) {
      var out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
      if (s) Object.keys(s).forEach(function (k) { out[k] = s[k]; });
      return out;
    });
  }
  /** Save a whole settings record (normalised; stamps updatedAt). */
  function saveSettings(s) {
    return putEditable('settings', buildSettings(s, null));
  }
  /**
   * Change only some settings fields, reading the stored record in the same transaction, so
   * two screens that each hold an older copy (the range card and the source-priority editor)
   * can't overwrite each other's fields. Stamps updatedAt (a real user edit).
   */
  function patchSettings(patch) {
    return withTx(['settings', 'tombstones'], 'readwrite', function (tx) {
      var os = tx.objectStore('settings');
      return new Promise(function (resolve, reject) {
        var g = os.get('settings');
        g.onerror = function () { reject(g.error); };
        g.onsuccess = function () {
          var rec = buildSettings(g.result, patch);
          rec.updatedAt = D.nowIso();
          os.put(rec);
          tx.objectStore('tombstones').delete(keys.tombstone('settings', 'settings'));
          resolve(rec);
        };
      });
    });
  }
  /**
   * One-time move of the source-priority order from localStorage into settings (schema v3).
   * Writes only when settings have no order yet; returns true if written. updatedAt is kept
   * (EPOCH when there was no settings record): moving a stored choice is not a new edit, so it
   * must not win a merge against a real settings change made on another device (the same rule
   * as DB migration 2, A-005 1.2).
   */
  function fillSourcePriorityIfEmpty(order) {
    var clean = sanitizePriority(order);
    if (!clean) return Promise.resolve(false);
    return withTx(['settings'], 'readwrite', function (tx) {
      var os = tx.objectStore('settings');
      return new Promise(function (resolve, reject) {
        var g = os.get('settings');
        g.onerror = function () { reject(g.error); };
        g.onsuccess = function () {
          var cur = g.result;
          if (cur && sanitizePriority(cur.sourcePriority)) { resolve(false); return; }
          var rec = buildSettings(cur, { sourcePriority: clean });
          rec.updatedAt = cur ? isoOr(cur.updatedAt, EPOCH_ISO) : EPOCH_ISO;
          os.put(rec);
          resolve(true);
        };
      });
    });
  }

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
        // A-005 Part 2: optional reading time. Only an integer 0–720 is kept; anything else
        // (90.5, −1, 721, "90", null) drops the key — the meal itself is still restored.
        if (isIntIn(g.minutesAfter, 0, MINUTES_AFTER_MAX)) o.glucose.minutesAfter = g.minutesAfter;
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
      // T001-08: an inverted or empty range (low >= high) would flag every reading; drop it.
      if (o.rangeLowMgdl !== null && o.rangeHighMgdl !== null && o.rangeLowMgdl >= o.rangeHighMgdl) {
        o.rangeLowMgdl = null; o.rangeHighMgdl = null;
      }
      // T001-13: strict true only ("true", 1, etc. restore as off).
      o.rangeNoticeOn = r.rangeNoticeOn === true;
      o.sourcePriority = sanitizePriority(r.sourcePriority);
      o.lastExportDate = D.isIso(r.lastExportDate) ? r.lastExportDate : null;
      o.updatedAt = isoOr(r.updatedAt, EPOCH_ISO);
      return o;
    },
    // Per-day sleep from the full export (schema v3). Whitelisted fields only; the key is
    // recomputed from date + origin. Only origin 'export' exists in this store (A-006 RC-3):
    // a 'shortcut' healthDay would never be read and no import could ever remove it.
    healthDays: function (r) {
      if (!r || r.origin !== 'export') return null;
      return makeHealthDay(r, 'export', r.updatedAt);
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
      if (!r || LWW.indexOf(r.store) < 0 || typeof r.id !== 'string' || !r.id || !D.isIso(r.deletedAt)) return null;
      return { key: keys.tombstone(r.store, r.id), store: r.store, id: r.id, deletedAt: r.deletedAt };
    }
  };

  // ---------- backup file ----------
  // Upgrades a backup object FROM schemaVersion (n-1) TO n. Add one per schema change.
  var backupMigrations = {
    // v1 -> v2 (T001-13): v1 had no opt-in, so a v1 file always restores with the notice off,
    // even if the field was hand-added.
    2: function (b) {
      if (b.stores && Array.isArray(b.stores.settings)) {
        b.stores.settings.forEach(function (r) { if (r && typeof r === 'object') r.rangeNoticeOn = false; });
      }
      return b;
    },
    // v2 -> v3.
    // Meals: pass-through. v2 meals have no reading time; nothing is inferred (A-005 Part 2),
    //   so they stay out of P12.
    // Steps: full-export sleep fields move into healthDays with the same splitExportSteps as
    //   DB migration 3 (updatedAt EPOCH: a schema move, not a new import).
    // Settings: no sourcePriority in v2 → sanitize gives null (default order). In a Merge,
    //   planMerge keeps the device's own order when such a record wins (A-006 RC-2 / T004-02;
    //   importBackup passes legacySettings from prepareBackup's fromSchema). Replace all
    //   restores it as null.
    3: function (b) {
      if (b.stores && Array.isArray(b.stores.steps)) {
        var keep = [], moved = [];
        b.stores.steps.forEach(function (r) {
          var sp = (r && typeof r === 'object') ? splitExportSteps(r, EPOCH_ISO) : { changed: false };
          if (!sp.changed) { keep.push(r); return; }
          if (sp.steps) keep.push(sp.steps);
          if (sp.healthDay) moved.push(sp.healthDay);
        });
        b.stores.steps = keep;
        if (moved.length) b.stores.healthDays = (Array.isArray(b.stores.healthDays) ? b.stores.healthDays : []).concat(moved);
      }
      return b;
    }
  };

  /**
   * THE count for the Replace-all guard, its confirm and its result (A-005 R1-1/R1-2).
   * stores = clean store arrays. Counts days, meals, step days, full-export sleep days and
   * sleep samples; settings are reported separately and never make a file count as data;
   * tombstones are not counted at all.
   * Returns { total, byStore: { dailyLog, meals, steps, healthDays, sleepSamples }, settings }.
   */
  function countDataRecords(stores) {
    var byStore = {}, total = 0;
    DATA_COUNT_STORES.forEach(function (s) {
      var n = stores && Array.isArray(stores[s]) ? stores[s].length : 0;
      byStore[s] = n; total += n;
    });
    return { total: total, byStore: byStore, settings: stores && Array.isArray(stores.settings) ? stores.settings.length : 0 };
  }

  var COUNT_LABELS = {
    dailyLog: ['daily log', 'daily logs'],
    meals: ['meal', 'meals'],
    steps: ['day of steps', 'days of steps'],
    healthDays: ['day of sleep from the full export', 'days of sleep from the full export'],
    sleepSamples: ['sleep record from the Shortcut', 'sleep records from the Shortcut']
  };
  function fmtCount(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }
  /** Text for a countDataRecords() result, e.g. "12 daily logs, 30 meals, settings". */
  function describeRecordCounts(c) {
    var parts = [];
    DATA_COUNT_STORES.forEach(function (s) {
      var n = c.byStore[s];
      if (n) parts.push(fmtCount(n) + ' ' + COUNT_LABELS[s][n === 1 ? 0 : 1]);
    });
    if (c.settings) parts.push('settings');
    return parts.length ? parts.join(', ') : 'nothing';
  }

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
    // A-005 R1-1: "records" is the DATA count only (days, meals, steps, sleep); a file holding
    // only tombstones or only settings has records = 0 and is refused by Replace all.
    var counts = countDataRecords(clean);
    return { ok: true, skipped: skipped, records: counts.total, dataRecords: counts.total, counts: counts,
      fromSchema: v,
      backup: { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: b.exportedAt, stores: clean } };
  }

  function recTime(r, store) {
    if (!r) return -Infinity;
    var t = D.isoToMs(store === 'tombstones' ? r.deletedAt : r.updatedAt);
    return isNaN(t) ? 0 : t;
  }

  /**
   * PURE merge planner (no IndexedDB) — unit-tested in tests/tests.js.
   * existing / incoming: { dailyLog:[], meals:[], steps:[], healthDays:[], sleepSamples:[], settings:[], tombstones:[] }
   * Rules (A-002 §2 item 14):
   *  - last-write-wins stores (dailyLog, meals, settings, healthDays): per key, the candidate with the newest time wins, where a record's
   *    time is updatedAt and a tombstone's time is deletedAt. Ties keep what already exists.
   *    If a tombstone wins, the record is deleted and the tombstone kept; if a record wins,
   *    any tombstone for that key is removed.
   *  - imported stores: add records whose key doesn't exist yet; never overwrite.
   *  - settings extras: when an incoming settings record wins and opts.legacySettings is true
   *    (the file is schema 1/2, which never carried an order), the device's sourcePriority is
   *    kept (A-006 RC-2 / T004-02). lastExportDate always ends as the later of the two (A-006
   *    RC-1): it describes data the device now holds, so a merge never moves it backwards.
   * opts = { legacySettings: boolean } (optional).
   * Returns { puts:{store:[rec]}, deletes:{store:[key]}, counts:{added,updated,deleted,unchanged} }.
   */
  function planMerge(existing, incoming, opts) {
    opts = opts || {};
    var puts = {}, deletes = {};
    STORES.forEach(function (s) { puts[s] = []; deletes[s] = []; });
    var counts = { added: 0, updated: 0, deleted: 0, unchanged: 0 };

    function index(arr, kp) { var m = {}; (arr || []).forEach(function (r) { m[r[kp]] = r; }); return m; }
    var exTomb = index(existing.tombstones, 'key');
    var inTomb = index(incoming.tombstones, 'key');

    LWW.forEach(function (s) {
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
        if (s === 'settings' && cur.kind === 'rec') cur = settingsExtras(cur, exRec[id], inRec[id]);
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

    /**
     * Settings winner adjustments (rules above). Returns the winner to apply. When the device's
     * record wins but the file has a later lastExportDate, the device record (same updatedAt)
     * is rewritten with that date and counted as updated.
     */
    function settingsExtras(win, exR, inR) {
      var later = laterIso(exR ? exR.lastExportDate : null, inR ? inR.lastExportDate : null);
      var v;
      if (win.incoming) {
        v = JSON.parse(JSON.stringify(win.v));
        if (opts.legacySettings && exR) v.sourcePriority = exR.sourcePriority === undefined ? null : exR.sourcePriority;
        v.lastExportDate = later;
        return { kind: 'rec', v: v, t: win.t, incoming: true };
      }
      if ((win.v.lastExportDate || null) === later) return win;
      v = JSON.parse(JSON.stringify(win.v));
      v.lastExportDate = later;
      return { kind: 'rec', v: v, t: win.t, incoming: true };
    }

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
      // T001-01 / A-005 R1-1: never wipe the device for a file with no DATA in it (a file with
      // only tombstones or only settings counts as empty). Same count as the confirm (R1-2).
      if (!prep.counts.total) {
        return Promise.resolve({ ok: false, error: 'This backup has no readable entries, so nothing was changed.', skipped: prep.skipped });
      }
      return withTx(STORES, 'readwrite', function (tx) {
        STORES.forEach(function (s) {
          var os = tx.objectStore(s);
          os.clear();
          inc[s].forEach(function (r) { os.put(r); });
        });
      }).then(function () {
        var n = prep.counts.total;
        return { ok: true, mode: 'replace', counts: { added: n, updated: 0, deleted: 0, unchanged: 0 },
          restored: prep.counts, skipped: prep.skipped };
      });
    }
    return snapshot().then(function (ex) {
      var plan = planMerge(ex, inc, { legacySettings: prep.fromSchema < 3 });
      return applyPlan(plan).then(function () {
        return { ok: true, mode: 'merge', counts: plan.counts, skipped: prep.skipped };
      });
    });
  }

  HT.db = {
    DB_VERSION: DB_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    APP_ID: APP_ID,
    MINUTES_AFTER_MAX: MINUTES_AFTER_MAX,
    STORES: STORES,
    EDITABLE: EDITABLE,
    LWW: LWW,
    IMPORTED: IMPORTED,
    DATA_COUNT_STORES: DATA_COUNT_STORES,
    SLEEP_DAY_FIELDS: SLEEP_DAY_FIELDS,
    SLEEP_KINDS: SLEEP_KINDS,
    KEY_PATH: KEY_PATH,
    RATINGS: RATINGS,
    TAGS: TAGS,
    CARBS: CARBS,
    SLEEP_STAGES: SLEEP_STAGES,
    STEP_ORIGINS: STEP_ORIGINS,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    MIGRATIONS: migrations,   // exposed for tests (tests/tests.js builds a v1 DB with it)
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
    putExportDays: putExportDays,
    withTx: withTx,
    getSettings: getSettings,
    saveSettings: saveSettings,
    patchSettings: patchSettings,
    fillSourcePriorityIfEmpty: fillSourcePriorityIfEmpty,
    makeHealthDay: makeHealthDay,
    splitExportSteps: splitExportSteps,
    sanitizePriority: sanitizePriority,
    laterIso: laterIso,
    countDataRecords: countDataRecords,
    describeRecordCounts: describeRecordCounts,
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
