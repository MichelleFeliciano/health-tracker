/* Health Tracker — health-csv.js
 * Reads the daily iOS Shortcut file (health-<Day>.csv) and stores it.
 * Spec: docs/team/research/R-002-shortcuts-and-ios-webapp.md §4.1 (reading rules, meta
 * interpretation table) and §6.1–6.3 (file format); binding rules in
 * docs/team/analysis/A-002-shortcuts-and-ios-webapp.md items 12–14 and Re-review 1:
 *  - UTF-8 with/without BOM, \n or \r\n, blank lines ignored, RFC 4180 quoting, exact header;
 *  - every data row has exactly 7 fields; timestamps ISO 8601 with offset or Z only;
 *  - the meta row is validated by COUNT (exactly one), not by position;
 *  - steps: strip every non-digit; blank = missing (null); 0 with meta count 0 = "suspect";
 *  - the day comes from the content, never the file name;
 *  - re-import of day D replaces steps(D) and the Shortcut sleep samples whose start lies
 *    inside the meta window AS WRITTEN in the file (never recomputed: DST nights differ).
 * Sleep nights are never taken from the CSV `date`; they are built from the sample times
 * with R-001 §6.1 (HT.healthAgg.resolveShortcutSleep).
 * Records carry no import timestamps, so importing the same file twice gives an identical DB.
 */
(function (HT) {
  'use strict';

  var HD = HT.healthDates;
  var HEADER = ['date', 'metric', 'stage', 'start', 'end', 'value', 'source'];
  var MAX_STEPS = 1000000;

  // Expected English labels (R-002 §6.3; A6 Low until T2 records real strings), plus
  // HealthKit identifiers. Matched case-insensitively after trimming. Anything else is
  // 'unknown': kept, shown as "unrecognised stage", never counted as asleep.
  var STAGE_MAP = {
    'in bed': 'inBed', 'inbed': 'inBed',
    'awake': 'awake',
    'core': 'asleepCore', 'asleep core': 'asleepCore',
    'deep': 'asleepDeep', 'asleep deep': 'asleepDeep',
    'rem': 'asleepREM', 'asleep rem': 'asleepREM',
    'asleep': 'asleepUnspecified', 'unspecified': 'asleepUnspecified', 'asleep unspecified': 'asleepUnspecified',
    'hkcategoryvaluesleepanalysisinbed': 'inBed',
    'hkcategoryvaluesleepanalysisawake': 'awake',
    'hkcategoryvaluesleepanalysisasleepcore': 'asleepCore',
    'hkcategoryvaluesleepanalysisasleepdeep': 'asleepDeep',
    'hkcategoryvaluesleepanalysisasleeprem': 'asleepREM',
    'hkcategoryvaluesleepanalysisasleepunspecified': 'asleepUnspecified',
    'hkcategoryvaluesleepanalysisasleep': 'asleepUnspecified'
  };

  function mapStage(label) {
    var k = String(label || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(STAGE_MAP, k) ? STAGE_MAP[k] : 'unknown';
  }

  /** RFC 4180 records -> [{fields: [...], line: n}] ; throws on an unterminated quote. */
  function parseRecords(text) {
    var out = [], fields = [], f = '', i = 0, n = text.length, line = 1, recLine = 1, inQ = false, quoted = false;
    function endField() { fields.push(f); f = ''; quoted = false; }
    function endRecord() {
      endField();
      if (!(fields.length === 1 && fields[0] === '' )) out.push({ fields: fields, line: recLine });
      fields = []; recLine = line;
    }
    while (i < n) {
      var ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { f += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        if (ch === '\n') line++;
        f += ch; i++; continue;
      }
      if (ch === '"' && f === '' && !quoted) { inQ = true; quoted = true; i++; continue; }
      if (ch === ',') { endField(); i++; continue; }
      if (ch === '\r' && text.charAt(i + 1) === '\n') { i++; continue; }
      if (ch === '\n' || ch === '\r') { line++; endRecord(); recLine = line; i++; continue; }
      f += ch; i++;
    }
    if (inQ) throw HD.importError('csvQuote', 'The file looks damaged (a quoted value never ends).');
    if (f !== '' || fields.length) endRecord();
    return out;
  }

  function fail(msg) { return { ok: false, error: msg }; }

  /**
   * Parse one Shortcut file's text. Returns
   *  { ok:true, day, status, steps, stepsSuspect, meta:{startMs,endMs,startText,endText,count,generatedAt},
   *    sleep:[{stage,label,startMs,endMs,source}], unknownStages }
   * or { ok:false, error }. status: 'ok' | 'nothing' (steps empty and 0 sleep samples:
   * import nothing, R-002 §4.1.2).
   */
  function parseShortcutCsv(text) {
    if (typeof text !== 'string') return fail('The file could not be read.');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var recs;
    try { recs = parseRecords(text); } catch (e) { return fail(e.userMessage || 'The file looks damaged.'); }
    if (!recs.length) return fail('The file is empty.');
    var h = recs[0].fields;
    if (h.length !== 7 || h.join(',') !== HEADER.join(',')) {
      return fail('This isn’t a Health Shortcut file (the first line should be “' + HEADER.join(',') + '”).');
    }
    var day = null, metas = [], stepsRows = [], sleepRows = [];
    for (var i = 1; i < recs.length; i++) {
      var r = recs[i], f = r.fields;
      if (f.length !== 7) return fail('Line ' + r.line + ' has ' + f.length + ' fields instead of 7. The file is incomplete or damaged; nothing was imported.');
      if (!HD.isDateKey(f[0])) return fail('Line ' + r.line + ' has an invalid date. Nothing was imported.');
      if (day === null) day = f[0];
      else if (f[0] !== day) return fail('The file mixes different days. Nothing was imported.');
      if (f[1] === 'meta') metas.push(r);
      else if (f[1] === 'steps') stepsRows.push(r);
      else if (f[1] === 'sleep') sleepRows.push(r);
      else return fail('Line ' + r.line + ' has an unknown row type. Nothing was imported.');
    }
    if (metas.length !== 1) return fail('The file is incomplete or damaged (it needs exactly one meta row). Nothing was imported.');
    if (stepsRows.length !== 1) return fail('The file is incomplete or damaged (it needs exactly one steps row). Nothing was imported.');

    var mf = metas[0].fields;
    var ws = HD.parseIsoOffset(mf[3]), we = HD.parseIsoOffset(mf[4]), gen = HD.parseIsoOffset(mf[6]);
    if (ws !== ws || we !== we || gen !== gen) return fail('The meta row has a time that isn’t in ISO 8601 format. Nothing was imported.');
    if (!(we > ws)) return fail('The meta row’s time window is invalid. Nothing was imported.');
    if (!/^\d+$/.test(mf[5])) return fail('The meta row’s sample count is invalid. Nothing was imported.');
    var count = Number(mf[5]);
    if (count !== sleepRows.length) {
      return fail('The file says it has ' + count + ' sleep samples but contains ' + sleepRows.length + '. It is incomplete or damaged; nothing was imported.');
    }

    // Steps: strip every non-digit (A-002 item 12). Blank = missing.
    var digits = stepsRows[0].fields[5].replace(/\D/g, '');
    var steps = digits === '' ? null : Number(digits);
    if (steps !== null && (!isFinite(steps) || steps > MAX_STEPS)) return fail('The step count is not a plausible number. Nothing was imported.');

    var sleep = [], unknown = 0;
    for (var j = 0; j < sleepRows.length; j++) {
      var sf = sleepRows[j].fields;
      var s = HD.parseIsoOffset(sf[3]), e = HD.parseIsoOffset(sf[4]);
      if (s !== s || e !== e) return fail('Line ' + sleepRows[j].line + ' has a time that isn’t in ISO 8601 format. Nothing was imported.');
      if (e < s) return fail('Line ' + sleepRows[j].line + ' ends before it starts. Nothing was imported.');
      var stage = mapStage(sf[2]);
      if (stage === 'unknown') unknown++;
      sleep.push({ stage: stage, label: sf[2].slice(0, 60), startMs: s, endMs: e, source: sf[6].slice(0, 200) });
    }

    var status = (steps === null && count === 0) ? 'nothing' : 'ok';
    return {
      ok: true, day: day, status: status, steps: steps,
      stepsSuspect: steps === 0 && count === 0,
      meta: { startMs: ws, endMs: we, startText: mf[3], endText: mf[4], count: count, generatedAt: mf[6] },
      sleep: sleep, unknownStages: unknown
    };
  }

  /** IndexedDB records for a parsed file (keys from HT.db.keys). */
  function toRecords(p) {
    var K = HT.db.keys;
    var stepRec = { key: K.steps(p.day, 'shortcut'), date: p.day, origin: 'shortcut', value: p.steps,
      suspect: p.stepsSuspect, generatedAt: p.meta.generatedAt,
      windowStartMs: p.meta.startMs, windowEndMs: p.meta.endMs, sleepCount: p.meta.count };
    var seen = Object.create(null), samples = [];
    p.sleep.forEach(function (x) {
      var rec = { origin: 'shortcut', stage: x.stage, startMs: x.startMs, endMs: x.endMs, source: x.source, day: p.day };
      if (x.stage === 'unknown') rec.label = x.label;
      rec.key = K.sleep(rec);
      if (seen[rec.key]) return;       // exact duplicate row in one file
      seen[rec.key] = true;
      samples.push(rec);
    });
    return { steps: stepRec, samples: samples };
  }

  /** True when the stored Shortcut day was generated strictly later than the incoming file
   *  (T002-02). Equal times (the same file again) are not "newer", so a re-import still
   *  rewrites identically; an unreadable stored time never blocks an import. */
  function storedIsNewer(stored, p) {
    if (!stored || !stored.generatedAt) return false;
    var a = HD.parseIsoOffset(stored.generatedAt), b = HD.parseIsoOffset(p.meta.generatedAt);
    return a === a && b === b && a > b;
  }

  /**
   * Commit parsed files (status 'ok') in ONE transaction. For each file (A-002 item 13):
   * if the day already holds a Shortcut import generated LATER than this file, skip the file
   * (an older copy must not replace a newer one — R-002 T7 intent, T002-02); otherwise
   * overwrite steps(D); delete Shortcut sleep samples with start in [windowStart, windowEnd]
   * (as written in the meta row); insert the file's samples. Callback style, so the
   * transaction never goes inactive between requests.
   * Resolves { days, samples, replaced, committedDays: [D], olderSkipped: [D] }.
   */
  function commit(parsedList) {
    var files = parsedList.filter(function (p) { return p.ok && p.status === 'ok'; })
      .sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
    var stats = { days: 0, samples: 0, replaced: 0, committedDays: [], olderSkipped: [] };
    if (!files.length) return Promise.resolve(stats);
    return HT.db.withTx(['steps', 'sleepSamples'], 'readwrite', function (tx) {
      var stepsOS = tx.objectStore('steps'), sleepOS = tx.objectStore('sleepSamples');
      return new Promise(function (resolve, reject) {
        var idx = 0;
        function next() {
          if (idx >= files.length) { resolve(stats); return; }
          var p = files[idx++], recs = toRecords(p);
          var g = stepsOS.get(recs.steps.key);
          g.onerror = function () { reject(g.error); };
          g.onsuccess = function () {
            if (storedIsNewer(g.result, p)) { stats.olderSkipped.push(p.day); next(); return; }
            write(p, recs);
          };
        }
        function write(p, recs) {
          stats.days++;
          stats.committedDays.push(p.day);
          stepsOS.put(recs.steps);
          var cur = sleepOS.index('startMs').openCursor(IDBKeyRange.bound(p.meta.startMs, p.meta.endMs));
          cur.onerror = function () { reject(cur.error); };
          cur.onsuccess = function () {
            var c = cur.result;
            if (c) {
              if (c.value.origin === 'shortcut') { c.delete(); stats.replaced++; }
              c.continue();
              return;
            }
            recs.samples.forEach(function (s) { sleepOS.put(s); });
            stats.samples += recs.samples.length;
            next();
          };
        }
        next();
      });
    });
  }

  HT.healthCsv = {
    HEADER: HEADER,
    STAGE_MAP: STAGE_MAP,
    mapStage: mapStage,
    parseRecords: parseRecords,
    parseShortcutCsv: parseShortcutCsv,
    toRecords: toRecords,
    commit: commit
  };
})(self.HT = self.HT || {});
