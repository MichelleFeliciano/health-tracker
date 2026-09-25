/* Health Tracker — health-scan.js
 * Streaming scanner for Apple Health export.xml + the full-export import pipeline.
 * Spec: docs/team/research/R-001-apple-health-export.md (Rev. 2)
 *   §6.0.3 source keys (with the hardware token, RR-3) and classes,
 *   §6.0.4 compact column storage (chunks of 65,536 rows; nothing resolved while streaming),
 *   §6.2 step 1 strict step-value regex (RR-9), §6.3 C.9–C.14 chunk scanner (1 MiB carry cap).
 *
 * Memory: the file is never held whole. Text arrives in chunks; only the partial element
 * at a chunk boundary is carried. Kept records cost 18 B (steps) / 11 B (sleep) each.
 * Privacy: never logs anything; diagnostics are counts only (plus source names and the
 * sleep "value" enum strings that were not recognised).
 *
 * Classic script. In a page it attaches to window.HT. Loaded as a Worker script
 * (new Worker('js/health-scan.js')) it imports its sibling modules and runs the
 * pipeline off the main thread (R-001 §6.3 "Run the scan in a Worker").
 */
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope && typeof importScripts === 'function') {
  importScripts('health-dates.js', 'health-zip.js', 'health-agg.js');
}
(function (HT) {
  'use strict';

  var HD = HT.healthDates;
  var err = HD.importError;

  var CHUNK = 65536;
  var END_ROOT = '</HealthData>';
  var MSG_INCOMPLETE_XML = 'This export file is incomplete — it may have been cut off while copying. Nothing was changed. Try exporting again.';
  var CARRY_CAP = 1048576;                 // 1 MiB (R-001 §6.3 step 10)
  var MAX_SAMPLE_MS = 24 * 3600000;        // MAX_STEP_SAMPLE_MS = MAX_SLEEP_SAMPLE_MS = 24 h
  var STEP_VALUE_RE = /^\d+(\.\d+)?$/;     // RR-9: '', '12abc', '-5', '1e3', '.5' are rejected
  var T_STEP = 'type="HKQuantityTypeIdentifierStepCount"';
  var T_SLEEP = 'type="HKCategoryTypeIdentifierSleepAnalysis"';
  var TYPE_STEP = 'HKQuantityTypeIdentifierStepCount';
  var TYPE_SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';

  // R-001 §6.0.4 sleep value codes. ASLEEP = 2..6 (Apple's allAsleepValues).
  var SLEEP_CODES = {
    HKCategoryValueSleepAnalysisInBed: 0,
    HKCategoryValueSleepAnalysisAwake: 1,
    HKCategoryValueSleepAnalysisAsleepCore: 2,
    HKCategoryValueSleepAnalysisAsleepDeep: 3,
    HKCategoryValueSleepAnalysisAsleepREM: 4,
    HKCategoryValueSleepAnalysisAsleepUnspecified: 5,
    HKCategoryValueSleepAnalysisAsleep: 6
  };
  var CLASS = { MANUAL: 0, WATCH: 1, IPHONE: 2, OTHER: 3 };

  // ---------- compact column stores (R-001 §6.0.4) ----------
  function ColumnStore(kind) {
    this.kind = kind;            // 'steps' | 'sleep'
    this.length = 0;
    this.chunks = [];
  }
  ColumnStore.prototype._chunk = function () {
    var c = this.kind === 'steps'
      ? { startS: new Uint32Array(CHUNK), endS: new Uint32Array(CHUNK), value: new Float64Array(CHUNK), src: new Uint16Array(CHUNK) }
      : { startS: new Uint32Array(CHUNK), endS: new Uint32Array(CHUNK), code: new Uint8Array(CHUNK), src: new Uint16Array(CHUNK) };
    this.chunks.push(c);
    return c;
  };
  /** v = step value (steps) or sleep code (sleep). */
  ColumnStore.prototype.push = function (startS, endS, v, src) {
    var i = this.length, ci = i >>> 16, o = i & 0xffff;
    var c = this.chunks[ci] || this._chunk();
    c.startS[o] = startS; c.endS[o] = endS; c.src[o] = src;
    if (this.kind === 'steps') c.value[o] = v; else c.code[o] = v;
    this.length = i + 1;
  };
  ColumnStore.prototype.startMs = function (i) { return this.chunks[i >>> 16].startS[i & 0xffff] * 1000; };
  ColumnStore.prototype.endMs = function (i) { return this.chunks[i >>> 16].endS[i & 0xffff] * 1000; };
  ColumnStore.prototype.src = function (i) { return this.chunks[i >>> 16].src[i & 0xffff]; };
  ColumnStore.prototype.value = function (i) { return this.chunks[i >>> 16].value[i & 0xffff]; };
  ColumnStore.prototype.code = function (i) { return this.chunks[i >>> 16].code[i & 0xffff]; };

  // ---------- sources (R-001 §6.0.3) ----------
  var HW_RE = /hardware:(.+?)(?:, [A-Za-z]+:|>|$)/;

  function hardwareOf(device) {
    if (!device) return '';
    var m = HW_RE.exec(device);
    return m ? m[1].trim() : '';
  }
  function classOf(manual, sourceName, device) {
    if (manual) return CLASS.MANUAL;
    var hasDev = device !== undefined && device !== null;
    if ((hasDev && device.indexOf('model:Watch') >= 0) || (!hasDev && sourceName.indexOf('Watch') >= 0)) return CLASS.WATCH;
    if ((hasDev && device.indexOf('model:iPhone') >= 0) || (!hasDev && sourceName.indexOf('iPhone') >= 0)) return CLASS.IPHONE;
    return CLASS.OTHER;
  }
  function sourceKey(manual, sourceName, hardware) {
    return manual ? 'manual:' + sourceName : 'src:' + sourceName + '|' + hardware;
  }

  /** Source table shared by both stores. */
  function SourceTable() { this.list = []; this.byKey = Object.create(null); }
  SourceTable.prototype.get = function (manual, sourceName, device, diag) {
    var hw = manual ? '' : hardwareOf(device);
    var key = sourceKey(manual, sourceName, hw);
    var cls = classOf(manual, sourceName, device);
    var s = this.byKey[key];
    if (s) {
      if (s.cls !== cls && diag) diag.classConflicts++;
      return s;
    }
    if (this.list.length >= 65535) throw err('tooManySources', 'This export has more data sources than the app can handle.');
    s = { id: this.list.length, key: key, sourceName: sourceName, hardware: hw, manual: !!manual, cls: cls,
      firstSeenMs: { steps: Infinity, sleep: Infinity }, count: { steps: 0, sleep: 0 } };
    this.list.push(s);
    this.byKey[key] = s;
    return s;
  };

  // ---------- XML helpers ----------
  var ATTR_RE = /([A-Za-z_][\w.:-]*)="([^"]*)"/g;
  var META_RE = /<MetadataEntry key="([^"]*)" value="([^"]*)"/g;
  var ENT_RE = /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(ENT_RE, function (m, e) {
      if (e.charAt(0) !== '#') return ENT[e];
      var cp = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return (cp >= 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : m;
    });
  }
  function parseAttrs(tag) {
    var o = Object.create(null), m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(tag)) !== null) o[m[1]] = decodeEntities(m[2]);
    return o;
  }
  /** Index of the '>' ending the start tag that begins at s (quote-aware), or -1 if not in buf. */
  function tagEnd(buf, s) {
    var i = s, inQ = false;
    for (;;) {
      var gt = buf.indexOf('>', i);
      if (gt < 0) return -1;
      var q = buf.indexOf('"', i);
      while (q >= 0 && q < gt) { inQ = !inQ; q = buf.indexOf('"', q + 1); }
      if (!inQ) return gt;
      i = gt + 1;
    }
  }

  function newDiag() {
    return {
      badDate: 0,
      steps: { kept: 0, endBeforeStart: 0, tooLong: 0, badValue: 0 },
      sleep: { kept: 0, endNotAfterStart: 0, tooLong: 0 },
      unknownSleepValues: {},
      classConflicts: 0,
      timeZoneEntries: 0,
      incompleteAtEnd: 0
    };
  }

  // ---------- scanner ----------
  function Scanner() {
    this.steps = new ColumnStore('steps');
    this.sleep = new ColumnStore('sleep');
    this.sources = new SourceTable();
    this.diag = newDiag();
    this.carry = '';
    this.sawRoot = false;
    this.sawEnd = false;      // '</HealthData>' seen after the last Record (T002-03)
    // <ExportDate value="…"/> (A-006 RC-1): UTC ms, or null when missing or unreadable.
    // Apple writes it right after <HealthData>, before <Me> and every Record, so the search
    // stops at the first Record (a file without it is not scanned twice).
    this.exportDateMs = null;
    this.exportDateDone = false;
    this.decoder = new TextDecoder('utf-8');
  }

  /**
   * Look for <ExportDate value="yyyy-MM-dd HH:mm:ss ±HHMM"/> in buf (the current carry + text).
   * A tag cut at the chunk end stays in the carry (it starts at the last '<'), so the next
   * call sees it whole. Unreadable → null: a missing date never blocks an import (RC-1).
   */
  Scanner.prototype._findExportDate = function (buf) {
    var i = buf.indexOf('<ExportDate');
    var r = buf.indexOf('<Record');
    if (i < 0 || (r >= 0 && r < i)) { if (r >= 0) this.exportDateDone = true; return; }
    var e = tagEnd(buf, i);
    if (e < 0) return;                       // rest of the tag arrives with the next chunk
    var a = parseAttrs(buf.slice(i, e + 1));
    var ms = a.value === undefined ? NaN : HD.parseHealthDate(a.value);
    this.exportDateMs = ms === ms ? ms : null;
    this.exportDateDone = true;
  };

  /** Feed raw bytes (UTF-8, split anywhere). */
  Scanner.prototype.pushBytes = function (u8) {
    this.pushText(this.decoder.decode(u8, { stream: true }));
  };

  /** Feed decoded text. R-001 §6.3 steps 10–13. */
  Scanner.prototype.pushText = function (text) {
    var buf = this.carry + text;
    if (!this.sawRoot && buf.indexOf('<HealthData') >= 0) this.sawRoot = true;
    if (!this.exportDateDone) this._findExportDate(buf);
    var pos = 0, nStep = -2, nSleep = -2, cut = -1;
    for (;;) {
      if (nStep !== -1 && nStep < pos) nStep = buf.indexOf(T_STEP, pos);
      if (nSleep !== -1 && nSleep < pos) nSleep = buf.indexOf(T_SLEEP, pos);
      var t, kind;
      if (nStep >= 0 && (nSleep < 0 || nStep < nSleep)) { t = nStep; kind = 'steps'; }
      else if (nSleep >= 0) { t = nSleep; kind = 'sleep'; }
      else break;
      // The start tag containing this type attribute begins at the nearest '<' before it
      // ('<' can't appear unescaped inside an attribute value).
      var s = buf.lastIndexOf('<', t);
      if (s < pos || buf.substr(s, 8) !== '<Record ') { pos = t + 1; continue; }
      var e = tagEnd(buf, s);
      if (e < 0) { cut = s; break; }
      if (e < t) { pos = t + 1; continue; }         // type string was outside the tag
      var body = '', endEl;
      if (buf.charCodeAt(e - 1) === 47 /* '/' */) endEl = e + 1;
      else {
        var c = buf.indexOf('</Record>', e);
        if (c < 0) { cut = s; break; }
        body = buf.slice(e + 1, c);
        endEl = c + 9;
      }
      this._record(buf.slice(s, e + 1), body, kind);
      pos = endEl;
    }
    // The closing root must come after every Record we kept. A Record found later clears it
    // again (in _record), so only a file that really ends with '</HealthData>' passes.
    if (buf.indexOf(END_ROOT, pos) >= 0 && (cut < 0 || buf.indexOf(END_ROOT, pos) < cut)) this.sawEnd = true;
    if (cut >= 0) this.carry = buf.slice(cut);
    else {
      var lt = buf.lastIndexOf('<');
      this.carry = lt >= pos ? buf.slice(lt) : '';
    }
    if (this.carry.length > CARRY_CAP) throw err('damaged', 'The file looks damaged (an element never ends).');
  };

  /**
   * End of input. An export.xml without its closing '</HealthData>' (or that stops inside a
   * Record) was cut off — usually by an interrupted copy/AirDrop or a partial iCloud
   * download. Architect rule (T002-03, 2026-09-24): reject the WHOLE import so no day is
   * overwritten with a smaller partial total; the zip path already rejects on size/CRC, this
   * covers plain XML and a zip whose export.xml itself is truncated but CRC-valid.
   */
  Scanner.prototype.finish = function () {
    this.pushText(this.decoder.decode());
    if (this.carry.indexOf(T_STEP) >= 0 || this.carry.indexOf(T_SLEEP) >= 0) this.diag.incompleteAtEnd = 1;
    this.carry = '';
    if (!this.sawRoot) throw err('notHealth', 'This isn’t an Apple Health export.');
    if (this.diag.incompleteAtEnd || !this.sawEnd) throw err('incomplete', MSG_INCOMPLETE_XML);
  };

  Scanner.prototype._record = function (tag, body, kind) {
    this.sawEnd = false;
    var a = parseAttrs(tag), d = this.diag;
    if (a.type !== (kind === 'steps' ? TYPE_STEP : TYPE_SLEEP)) return;
    var manual = false;
    if (body) {
      var m;
      META_RE.lastIndex = 0;
      while ((m = META_RE.exec(body)) !== null) {
        if (m[1] === 'HKWasUserEntered' && m[2] === '1') manual = true;
        else if (m[1] === 'HKTimeZone') d.timeZoneEntries++;
      }
    }
    var start = HD.parseHealthDate(a.startDate), end = HD.parseHealthDate(a.endDate);
    if (start !== start || end !== end) { d.badDate++; return; }
    var v;
    if (kind === 'steps') {
      if (end < start) { d.steps.endBeforeStart++; return; }
      if (end - start > MAX_SAMPLE_MS) { d.steps.tooLong++; return; }
      var s = a.value === undefined ? '' : a.value;
      v = STEP_VALUE_RE.test(s) ? Number(s) : NaN;
      if (!isFinite(v)) { d.steps.badValue++; return; }
    } else {
      v = SLEEP_CODES[a.value];
      if (v === undefined) {
        var name = String(a.value === undefined ? '(missing)' : a.value).slice(0, 80);
        d.unknownSleepValues[name] = (d.unknownSleepValues[name] || 0) + 1;
        return;
      }
      if (end <= start) { d.sleep.endNotAfterStart++; return; }
      if (end - start > MAX_SAMPLE_MS) { d.sleep.tooLong++; return; }
    }
    var src = this.sources.get(manual, a.sourceName || '', a.device, d);
    if (start < src.firstSeenMs[kind]) src.firstSeenMs[kind] = start;
    src.count[kind]++;
    d[kind].kept++;
    this[kind].push(start / 1000, end / 1000, v, src.id);
  };

  // ---------- full-export pipeline ----------
  /**
   * Scan an export (.zip or export.xml) and resolve it into per-day records.
   * opts: { savedOrder: {steps, sleep} | null, zone, onProgress(done,total,phase), isCancelled() }
   * Resolves { records, sources, priorities, diag, info } where info.exportDate is the file's
   * <ExportDate> as ISO UTC, or null when missing/unreadable. Commits nothing (the caller
   * writes records in one IndexedDB transaction).
   */
  function processExport(file, opts) {
    opts = opts || {};
    var Z = HT.healthZip, A = HT.healthAgg;
    var sc = new Scanner();
    var info = { kind: null, entryName: null, bytes: 0 };
    var onChunk = function (u8) { sc.pushBytes(u8); };
    var prog = function (done, total) { if (opts.onProgress) opts.onProgress(done, total, 'reading'); };
    return Z.sniff(file).then(function (kind) {
      info.kind = kind;
      if (kind === 'zip') {
        return Z.locateExport(file).then(function (entry) {
          info.entryName = entry.name;
          info.bytes = entry.uncomp;
          return Z.streamEntry(file, entry, onChunk, { onProgress: prog, isCancelled: opts.isCancelled });
        });
      }
      if (kind === 'xml') {
        info.bytes = file.size;
        return Z.streamFile(file, onChunk, { onProgress: prog, isCancelled: opts.isCancelled });
      }
      throw err('notHealth', 'This isn’t an Apple Health export.');
    }).then(function () {
      sc.finish();
      if (opts.isCancelled && opts.isCancelled()) throw err('cancelled', Z.MSG.cancelled);
      if (opts.onProgress) opts.onProgress(1, 1, 'resolving');
      var res = A.resolveAll(sc, opts.savedOrder || null, opts.zone || HD.localZone);
      res.diag.scan = sc.diag;
      // ISO UTC string (survives the Worker's structured clone), or null (A-006 RC-1).
      info.exportDate = sc.exportDateMs === null ? null : new Date(sc.exportDateMs).toISOString();
      res.info = info;
      return res;
    });
  }

  HT.healthScan = {
    CLASS: CLASS,
    SLEEP_CODES: SLEEP_CODES,
    STEP_VALUE_RE: STEP_VALUE_RE,
    ColumnStore: ColumnStore,
    SourceTable: SourceTable,
    Scanner: Scanner,
    hardwareOf: hardwareOf,
    classOf: classOf,
    sourceKey: sourceKey,
    decodeEntities: decodeEntities,
    tagEnd: tagEnd,
    processExport: processExport
  };

  // ---------- Worker entry ----------
  if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.onmessage = function (ev) {
      var msg = ev.data || {};
      if (msg.cmd !== 'run') return;
      var last = 0;
      processExport(msg.file, {
        savedOrder: msg.savedOrder,
        onProgress: function (done, total, phase) {
          var now = Date.now();
          if (now - last > 150 || phase !== 'reading') { last = now; self.postMessage({ type: 'progress', done: done, total: total, phase: phase }); }
        }
      }).then(function (res) {
        self.postMessage({ type: 'done', result: res });
      }, function (e) {
        self.postMessage({ type: 'error', code: (e && e.code) || 'unknown', message: (e && e.userMessage) || 'The import failed.' });
      });
    };
  }
})(self.HT = self.HT || {});
