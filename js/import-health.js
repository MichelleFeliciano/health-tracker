/* Health Tracker — import-health.js
 * Settings section "Apple Health import": file picker for the full export (.zip / export.xml)
 * and the daily Shortcut files (.csv), progress + cancel, result summary, data-source
 * priority editor, last imported day and a missing-data notice.
 * Specs: docs/team/research/R-001-apple-health-export.md §6 (Rev. 2) and
 * docs/team/research/R-002-shortcuts-and-ios-webapp.md §4.1/§6 with A-002 items 12–15.
 *
 * - The full export is scanned in a Worker when served over http(s) (R-001 §6.3), and on the
 *   main thread under file:// (Workers from file:// are blocked in most browsers). Nothing is
 *   written until the whole file has been read and resolved; then all per-day records are
 *   written in ONE IndexedDB transaction (a failure or cancel commits nothing, AT-12).
 * - The user's source-priority order lives in settings.sourcePriority (IndexedDB, backed up;
 *   schema v3). It is read/written through HT.healthData.getSavedOrder / saveSavedOrder, which
 *   also move a pre-v3 localStorage order once. Small UI caches (known sources, last-import
 *   summaries) stay in localStorage under "ht.healthImport.v1". Health records: IndexedDB only.
 * - Full-export days are written with HT.db.putExportDays: step counts to `steps`, per-day
 *   sleep to `healthDays` (schema v3).
 * - Never logs anything. Text-only DOM (no innerHTML).
 * Exposes window.HT.importHealth = { render(container), getSavedOrder() -> Promise }.
 */
(function (HT) {
  'use strict';

  var PREF_KEY = 'ht.healthImport.v1';
  var PREF_VERSION = 1;
  var TYPES = [['steps', 'Steps'], ['sleep', 'Sleep']];

  // ---------- small preferences (localStorage, guarded) ----------
  function loadPrefs() {
    var p = null;
    try { p = JSON.parse(window.localStorage.getItem(PREF_KEY) || 'null'); } catch (e) { p = null; }
    if (!p || typeof p !== 'object' || p.version !== PREF_VERSION) {
      p = { version: PREF_VERSION, sources: [], lastExport: null, lastCsv: null };
    }
    if (!Array.isArray(p.sources)) p.sources = [];
    return p;
  }
  function savePrefs(p) {
    // Every caller runs after HT.healthData.migrateLegacyOrder(), so a pre-v3 savedOrder has
    // already been copied into settings; never write it back here.
    delete p.savedOrder;
    try { window.localStorage.setItem(PREF_KEY, JSON.stringify(p)); return true; } catch (e) { return false; }
  }
  /** The user's saved priority lists (settings.sourcePriority): Promise<{ steps, sleep }>. */
  function getSavedOrder() { return HT.healthData.getSavedOrder(); }

  // ---------- helpers ----------
  function el(tag, attrs, children) { return HT.app.el(tag, attrs, children); }
  function isHttp() { return !!(HT.app && HT.app.isHttp && HT.app.isHttp()); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fmtNum(n) { try { return Number(n).toLocaleString(); } catch (e) { return String(n); } }
  function sum(o) { var t = 0; Object.keys(o || {}).forEach(function (k) { t += o[k]; }); return t; }
  function fmtLocalDateTime(ms) {
    try { return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return new Date(ms).toString(); }
  }

  // ---------- the running job (module level, so leaving Settings doesn't lose it) ----------
  var job = null;         // { kind, cancelled, cancel(), progress, text }
  var listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } }); }

  function startJob(kind) {
    job = { kind: kind, cancelled: false, done: 0, total: 0, phase: 'reading', text: 'Starting…', worker: null };
    job.cancel = function () {
      job.cancelled = true;
      if (job.worker) { try { job.worker.terminate(); } catch (e) { /* ignore */ } }
      if (job.rejectWorker) job.rejectWorker(HT.healthDates.importError('cancelled', 'Import cancelled.'));
    };
    notify();
    return job;
  }
  function endJob() { job = null; notify(); }

  // ---------- full export ----------
  function scanInWorker(file, savedOrder, j) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker('js/health-scan.js'); } catch (e) { reject({ fallback: true }); return; }
      var started = false;
      j.worker = w;
      j.rejectWorker = reject;
      w.onmessage = function (ev) {
        var m = ev.data || {};
        started = true;
        if (m.type === 'progress') { j.done = m.done; j.total = m.total; j.phase = m.phase; notify(); }
        else if (m.type === 'done') { w.terminate(); resolve(m.result); }
        else if (m.type === 'error') { w.terminate(); reject(HT.healthDates.importError(m.code, m.message)); }
      };
      w.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        w.terminate();
        // Worker could not load (e.g. blocked): fall back to the main thread.
        reject(started ? HT.healthDates.importError('worker', 'The import stopped unexpectedly. Try again.') : { fallback: true });
      };
      w.postMessage({ cmd: 'run', file: file, savedOrder: savedOrder });
    });
  }

  function scanOnMainThread(file, savedOrder, j, zone) {
    return HT.healthScan.processExport(file, {
      savedOrder: savedOrder,
      onProgress: function (done, total, phase) { j.done = done; j.total = total; j.phase = phase; notify(); },
      isCancelled: function () { return j.cancelled; },
      zone: zone      // undefined in the app (device zone); tests pass a fixed zone
    });
  }

  // A-006 RC-1, wording fixed by the Architect (decisions.md 2026-09-24 "A-006 rulings").
  var MSG_OLDER_EXPORT = 'This export is older than one you already imported. Importing it will replace newer sleep and step data for the days it covers. Import anyway?';
  var MSG_OLDER_DECLINED = 'Nothing was imported. Your newer sleep and step data were kept.';

  /**
   * True only when both dates are readable and the incoming export is STRICTLY earlier than
   * the latest one imported (settings.lastExportDate). A missing or unreadable date on either
   * side never blocks an import (A-006 RC-1).
   */
  function isOlderExport(incomingIso, lastIso) {
    var a = HT.dates.isoToMs(incomingIso), b = HT.dates.isoToMs(lastIso);
    return a === a && b === b && a < b;
  }

  /**
   * opts.confirm(text) -> boolean: the confirm used for an older export (default
   * window.confirm; tests pass a stub). opts.zone: tests only (main-thread scan).
   */
  function importExport(file, opts) {
    opts = opts || {};
    var confirmFn = typeof opts.confirm === 'function' ? opts.confirm : function (q) { return window.confirm(q); };
    var j = startJob('export');
    j.text = 'Reading the Apple Health export…';
    var p = getSavedOrder().catch(function () { return { steps: null, sleep: null }; }).then(function (saved) {
      if (j.cancelled) throw HT.healthDates.importError('cancelled', 'Import cancelled.');
      return (isHttp() && typeof Worker === 'function')
        ? scanInWorker(file, saved, j).catch(function (e) { if (e && e.fallback && !j.cancelled) return scanOnMainThread(file, saved, j, opts.zone); throw e; })
        : scanOnMainThread(file, saved, j, opts.zone);
    });
    return p.then(function (res) {
      if (j.cancelled) throw HT.healthDates.importError('cancelled', 'Import cancelled.');
      var exportDate = (res.info && res.info.exportDate) || null;
      // RC-1: an older export would replace newer data for the days it covers; ask first and
      // commit nothing unless the user agrees. Unreadable settings → no block.
      return HT.db.getSettings().catch(function () { return null; }).then(function (st) {
        if (isOlderExport(exportDate, st && st.lastExportDate) && !confirmFn(MSG_OLDER_EXPORT)) {
          throw HT.healthDates.importError('olderDeclined', MSG_OLDER_DECLINED);
        }
        if (j.cancelled) throw HT.healthDates.importError('cancelled', 'Import cancelled.');
        j.phase = 'saving'; j.text = 'Saving…'; notify();
        // One transaction: step counts -> `steps`, per-day sleep -> `healthDays` (schema v3),
        // plus settings.lastExportDate (kept at the latest date seen).
        var plan = HT.healthAgg.toExportPlan(res.days, HT.dates.nowIso());
        plan.exportDate = exportDate;
        return HT.db.putExportDays(plan).then(function (out) { res.removed = out; return res; });
      });
    }).then(function (res) {
      var sd = res.diag.scan;
      var summary = {
        at: Date.now(),
        fileKind: res.info.kind,
        days: res.days.length,
        from: res.days.length ? res.days[0].date : null,
        to: res.days.length ? res.days[res.days.length - 1].date : null,
        stepDays: res.diag.stepDays,
        nights: res.days.filter(function (d) { return d.kind === 'night'; }).length,
        inBedOnly: res.days.filter(function (d) { return d.kind === 'inBedOnly'; }).length,
        napOnly: res.days.filter(function (d) { return d.kind === 'napOnly'; }).length,   // T004-03
        // T004-01: records from an earlier export that this file's days no longer include.
        removedSleep: (res.removed && res.removed.removedSleep) || 0,
        removedSteps: (res.removed && res.removed.removedSteps) || 0,
        exportDate: (res.info && res.info.exportDate) || null,
        partialNights: res.diag.partialNights,
        stepRecords: sd.steps.kept, sleepRecords: sd.sleep.kept,
        rejected: sd.badDate + sd.steps.endBeforeStart + sd.steps.tooLong + sd.steps.badValue +
          sd.sleep.endNotAfterStart + sd.sleep.tooLong,
        unknownSleep: sum(sd.unknownSleepValues),
        unknownSleepValues: sd.unknownSleepValues,
        incompleteAtEnd: sd.incompleteAtEnd,
        classConflicts: sd.classConflicts,
        invariantViolations: res.diag.stepInvariantViolations,
        sources: res.sources.length
      };
      var p2 = loadPrefs();
      p2.sources = res.sources;
      p2.lastPriorities = res.priorities;
      p2.lastExport = summary;
      savePrefs(p2);
      endJob();
      return { ok: true, kind: 'export', summary: summary };
    }, function (e) {
      endJob();
      if (e && e.code === 'cancelled') return { ok: false, cancelled: true, message: 'Import cancelled. Nothing was saved.' };
      if (e && e.code === 'olderDeclined') return { ok: false, cancelled: true, olderDeclined: true, message: MSG_OLDER_DECLINED };
      var quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || '')));
      return { ok: false, message: quota ? 'The device is out of storage space. Nothing was saved.'
        : ((e && e.userMessage) || 'The import failed. Nothing was saved.') };
    });
  }

  // ---------- Shortcut CSV files ----------
  function readText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  }

  function importCsvFiles(files) {
    var j = startJob('csv');
    j.text = 'Reading ' + plural(files.length, 'Shortcut file') + '…';
    notify();
    var results = [];
    // Start from the one-time move of a pre-v3 saved order, before this job rewrites the prefs.
    return files.reduce(function (p, f) {
      return p.then(function () {
        if (j.cancelled) return;
        if (f.size > 5 * 1024 * 1024) { results.push({ name: f.name, parsed: { ok: false, error: 'This file is too large to be a Shortcut file.' } }); return; }
        return readText(f).then(function (t) {
          results.push({ name: f.name, parsed: HT.healthCsv.parseShortcutCsv(t) });
        }, function () { results.push({ name: f.name, parsed: { ok: false, error: 'The file could not be read.' } }); });
      });
    }, HT.healthData.migrateLegacyOrder()).then(function () {
      if (j.cancelled) throw HT.healthDates.importError('cancelled', 'Import cancelled.');
      // Two files for the same day in one batch: keep the one generated last.
      var byDay = {};
      results.forEach(function (r) {
        var p = r.parsed;
        if (!p.ok || p.status !== 'ok') return;
        var prev = byDay[p.day];
        if (!prev || HT.healthDates.parseIsoOffset(p.meta.generatedAt) >= HT.healthDates.parseIsoOffset(prev.parsed.meta.generatedAt)) {
          if (prev) prev.superseded = true;
          byDay[p.day] = r;
        } else r.superseded = true;
      });
      var toCommit = Object.keys(byDay).map(function (d) { return byDay[d].parsed; });
      j.text = 'Saving…'; notify();
      return HT.healthCsv.commit(toCommit).then(function (stats) {
        // A day already holding a Shortcut import generated later than this file is left
        // alone by commit() (T002-02); report that file as an older copy, not as imported.
        stats.olderSkipped.forEach(function (d) { byDay[d].olderThanSaved = true; });
        var days = stats.committedDays.slice().sort();
        var last = null;
        days.forEach(function (d) { var g = byDay[d].parsed.meta.generatedAt; if (!last || HT.healthDates.parseIsoOffset(g) > HT.healthDates.parseIsoOffset(last)) last = g; });
        var prefs = loadPrefs();
        if (days.length) {
          prefs.lastCsv = { at: Date.now(), day: days[days.length - 1], generatedAt: last };
          savePrefs(prefs);
        }
        endJob();
        return { ok: true, kind: 'csv', results: results, days: days, stats: stats };
      });
    }).catch(function (e) {
      endJob();
      if (e && e.code === 'cancelled') return { ok: false, cancelled: true, message: 'Import cancelled. Nothing was saved.' };
      return { ok: false, message: (e && e.userMessage) || 'The Shortcut files could not be saved. Nothing was changed.' };
    });
  }

  // ---------- rendering ----------
  function render(container) {
    var alive = true;
    var ids = { input: HT.app.nextId('ih-file'), prog: HT.app.nextId('ih-prog') };

    container.appendChild(el('h2', { id: 'ih-h', style: 'margin-top:0', text: 'Apple Health import' }));
    // An old cached index.html may lack the health-*.js script tags: don't offer a broken picker.
    if (!HT.healthDates || !HT.healthZip || !HT.healthScan || !HT.healthAgg || !HT.healthCsv) {
      container.appendChild(el('p', { class: 'notice', text: 'The import tools didn’t load. Close and reopen the app (or reload the page) to finish updating it.' }));
      return function () { alive = false; };
    }
    container.appendChild(el('p', { text: 'Bring in sleep and steps from Apple Health. Files are read on this device; nothing is uploaded.' }));
    container.appendChild(el('ul', { class: 'small' }, [
      el('li', { text: 'Full history: in the Health app, tap your picture › Export All Health Data, save export.zip to Files, then choose it here (or the export.xml inside it).' }),
      el('li', { text: 'Daily: choose one or more health-YYYY-MM-DD.csv files made by the Health Export Shortcut.' })
    ]));

    var input = el('input', { type: 'file', id: ids.input, accept: '.zip,.xml,.csv,application/zip,text/xml,application/xml,text/csv', multiple: true, 'aria-describedby': ids.input + '-hint' });
    container.appendChild(el('label', { for: ids.input, text: 'Choose export.zip, export.xml or Shortcut .csv files' }));
    container.appendChild(input);
    container.appendChild(el('p', { class: 'field-hint', id: ids.input + '-hint', text: 'A full export can take several minutes on a phone. Keep this screen open until it finishes.' }));

    var progWrap = el('div', { hidden: true });
    var progLabel = el('p', { id: ids.prog + '-l', class: 'small', text: '' });
    var prog = el('progress', { id: ids.prog, max: '100', 'aria-labelledby': ids.prog + '-l', style: 'width:100%;height:1.2rem' });
    var cancelBtn = el('button', { type: 'button', text: 'Cancel import' });
    progWrap.appendChild(progLabel);
    progWrap.appendChild(prog);
    progWrap.appendChild(el('div', { class: 'row', style: 'margin-top:6px' }, [cancelBtn]));
    container.appendChild(progWrap);

    var statusBox = el('div', { role: 'status', 'aria-live': 'polite' });
    container.appendChild(statusBox);

    var lastBox = el('div');
    container.appendChild(lastBox);

    var prioBox = el('details', { style: 'margin-top:12px' });
    container.appendChild(prioBox);

    container.appendChild(helpDetails());
    container.appendChild(el('p', { class: 'small muted', text: 'Not medical advice. Imported figures are estimates worked out on this device and may differ from the Health app.' }));

    cancelBtn.addEventListener('click', function () { if (job) job.cancel(); });

    function drawJob() {
      if (!alive) return;
      var running = !!job;
      progWrap.hidden = !running;
      input.disabled = running;
      if (!running) return;
      if (job.phase === 'reading' && job.total > 0) {
        var pct = Math.min(100, Math.floor(job.done / job.total * 100));
        prog.value = pct;
        progLabel.textContent = job.text + ' ' + pct + '%';
      } else {
        prog.removeAttribute('value');            // indeterminate
        progLabel.textContent = job.phase === 'resolving' ? 'Working out daily totals…' : job.text;
      }
    }
    listeners.push(drawJob);
    drawJob();

    function showMessage(lines, isError) {
      statusBox.textContent = '';
      var box = el('div', { class: isError ? 'notice' : 'banner' });
      lines.forEach(function (l) { if (l) box.appendChild(typeof l === 'string' ? el('p', { text: l }) : l); });
      statusBox.appendChild(box);
    }

    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      if (!files.length || job) return;
      statusBox.textContent = '';
      Promise.all(files.map(function (f) { return HT.healthZip.sniff(f).then(function (k) { return { f: f, k: k }; }, function () { return { f: f, k: null }; }); }))
        .then(function (list) {
          var exports = list.filter(function (x) { return x.k === 'zip' || x.k === 'xml'; });
          var csvs = list.filter(function (x) { return x.k === 'csv'; });
          var other = list.filter(function (x) { return !x.k; });
          if (exports.length && (exports.length > 1 || csvs.length)) {
            showMessage(['Choose the full export on its own (one file), or only Shortcut .csv files.'], true);
            return null;
          }
          if (!exports.length && !csvs.length) {
            showMessage(['This isn’t an Apple Health export or a Shortcut file.'], true);
            return null;
          }
          var skipped = other.length ? plural(other.length, 'file was', 'files were') + ' skipped (not a Health file).' : null;
          if (exports.length) return importExport(exports[0].f).then(function (r) { r.skipped = skipped; return r; });
          return importCsvFiles(csvs.map(function (x) { return x.f; })).then(function (r) { r.skipped = skipped; return r; });
        })
        .then(function (r) {
          if (!r || !alive) return;
          if (!r.ok) { showMessage([r.message], !r.cancelled); return; }
          if (r.kind === 'export') showMessage(exportSummaryLines(r.summary).concat([r.skipped]), false);
          else showMessage(csvSummaryLines(r).concat([r.skipped]), csvHasErrors(r));
          drawLast();
          drawPriority();
        });
    });

    // ----- last import + missing-data notice -----
    function drawLast() {
      if (!alive) return;
      var prefs = loadPrefs();
      Promise.all([HT.db.getAll('steps'), HT.db.getAll('healthDays')]).then(function (both) {
        if (!alive) return;
        // Schema v3: export days are in `steps` (step counts) and/or `healthDays` (sleep).
        var recs = both[0].concat(both[1]);
        lastBox.textContent = '';
        lastBox.appendChild(el('h3', { text: 'What’s imported' }));
        var sc = recs.filter(function (r) { return r.origin === 'shortcut'; }).map(function (r) { return r.date; }).sort();
        var exSet = {};
        recs.forEach(function (r) { if (r.origin === 'export') exSet[r.date] = true; });
        var ex = Object.keys(exSet).sort();
        var any = {};
        recs.forEach(function (r) { any[r.date] = true; });
        var ul = el('ul', { class: 'small' });
        if (ex.length) {
          ul.appendChild(el('li', { text: 'Full export: ' + plural(ex.length, 'day') + ', ' + ex[0] + ' to ' + ex[ex.length - 1] +
            (prefs.lastExport ? ' (imported ' + fmtLocalDateTime(prefs.lastExport.at) + ')' : '') + '.' }));
        } else ul.appendChild(el('li', { text: 'Full export: not imported yet.' }));
        if (sc.length) {
          ul.appendChild(el('li', { text: 'Last imported day from the Shortcut: ' + sc[sc.length - 1] + '.' }));
          if (prefs.lastCsv && prefs.lastCsv.generatedAt) {
            var g = HT.healthDates.parseIsoOffset(prefs.lastCsv.generatedAt);
            if (g === g) ul.appendChild(el('li', { text: 'Last Shortcut run: ' + fmtLocalDateTime(g) + '.' }));
          }
        } else ul.appendChild(el('li', { text: 'Shortcut files: none imported yet.' }));
        lastBox.appendChild(ul);

        // Missing days in the last 14 complete days (from the first day we have any data).
        var first = Object.keys(any).sort()[0];
        if (first) {
          var yesterday = HT.dates.addDays(HT.dates.todayLocal(), -1);
          var from = HT.dates.addDays(yesterday, -13);
          if (first > from) from = first;
          var missing = [];
          for (var d = from; d <= yesterday; d = HT.dates.addDays(d, 1)) if (!any[d]) missing.push(d);
          if (missing.length) {
            lastBox.appendChild(el('div', { class: 'notice' }, [
              el('p', { text: 'Missing data: no steps or sleep imported for ' + plural(missing.length, 'day') + ' in the last two weeks (' +
                (missing.length > 6 ? missing.slice(0, 6).join(', ') + ', …' : missing.join(', ')) + ').' }),
              el('p', { text: 'Run the Health Export Shortcut for those days (with the phone unlocked), then import the files here.' })
            ]));
          }
        }
      }, function () { /* storage unavailable: settings already shows that */ });
    }

    // ----- source priority editor -----
    function drawPriority() {
      if (!alive) return Promise.resolve();
      return getSavedOrder().catch(function () { return { steps: null, sleep: null }; }).then(function (savedOrder) {
        if (alive) drawPriorityWith(savedOrder);
      });
    }
    function drawPriorityWith(savedOrder) {
      prioBox.textContent = '';
      prioBox.appendChild(el('summary', { text: 'Data source priority' }));
      prioBox.appendChild(el('p', { class: 'small', text: 'When two sources record the same minute (for example your Watch and your iPhone), the one higher in this list is used, as in the Health app. Sleep uses one source per night. The order is saved with your settings and included in backups.' }));
      var prefs = loadPrefs();
      var sources = prefs.sources || [];
      if (!sources.length) {
        prioBox.appendChild(el('p', { class: 'small muted', text: 'Import the full export first to see your sources.' }));
        return;
      }
      var work = {};
      TYPES.forEach(function (t) { work[t[0]] = currentOrder(sources, t[0], savedOrder[t[0]]); });
      TYPES.forEach(function (t) {
        var type = t[0], legendId = HT.app.nextId('ih-pr');
        var fs = el('fieldset', { 'aria-labelledby': legendId, style: 'margin-top:8px' });
        fs.appendChild(el('legend', { id: legendId, text: t[1] + ' (top = used first)' }));
        var ol = el('ol', { class: 'small' });
        fs.appendChild(ol);
        prioBox.appendChild(fs);
        function drawList(focusKey, focusDir) {
          ol.textContent = '';
          var list = work[type];
          if (!list.length) { ol.appendChild(el('li', { class: 'muted', text: 'No ' + t[1].toLowerCase() + ' data in the export.' })); return; }
          list.forEach(function (s, i) {
            var name = s.names[type];
            var up = el('button', { type: 'button', class: 'link', text: 'Up', 'aria-label': 'Move ' + name + ' up', disabled: i === 0 });
            var down = el('button', { type: 'button', class: 'link', text: 'Down', 'aria-label': 'Move ' + name + ' down', disabled: i === list.length - 1 });
            up.addEventListener('click', function () { move(i, -1, s.key, 'up'); });
            down.addEventListener('click', function () { move(i, 1, s.key, 'down'); });
            ol.appendChild(el('li', {}, [
              el('span', { text: name + ' — ' + HT.healthAgg.CLASS_NAMES[s.cls] + ' ' }),
              up, down
            ]));
            if (focusKey === s.key) setTimeout(function () {
              var b = focusDir === 'up' ? up : down;
              (b.disabled ? (focusDir === 'up' ? down : up) : b).focus();
            }, 0);
          });
        }
        function move(i, d, key, dir) {
          var list = work[type], j = i + d;
          if (j < 0 || j >= list.length) return;
          var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
          drawList(key, dir);
        }
        drawList();
      });
      var msg = el('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
      var saveBtn = el('button', { type: 'button', class: 'primary', text: 'Save order' });
      var resetBtn = el('button', { type: 'button', text: 'Reset to default' });
      saveBtn.addEventListener('click', function () {
        var order = {};
        TYPES.forEach(function (t) {
          order[t[0]] = work[t[0]].map(function (s) { return { key: s.key, cls: s.cls, name: s.sourceName }; });
        });
        saveBtn.disabled = true;
        HT.healthData.saveSavedOrder(order).then(function () {
          msg.textContent = 'Saved. Shortcut sleep uses it now; import the full export again to apply it to your history.';
        }, function () {
          msg.textContent = 'Could not save the order. Nothing was changed.';
        }).then(function () { saveBtn.disabled = false; });
      });
      resetBtn.addEventListener('click', function () {
        resetBtn.disabled = true;
        HT.healthData.saveSavedOrder(null).then(function () {
          return drawPriority().then(function () {
            if (!alive) return;
            prioBox.open = true;
            prioBox.appendChild(el('p', { class: 'small', role: 'status', text: 'Default order restored. Import the full export again to apply it to your history.' }));
          });
        }, function () {
          resetBtn.disabled = false;
          msg.textContent = 'Could not reset the order. Nothing was changed.';
        });
      });
      prioBox.appendChild(el('div', { class: 'row', style: 'margin-top:8px' }, [saveBtn, resetBtn]));
      prioBox.appendChild(msg);
    }

    drawLast();
    drawPriority();

    return function () {
      alive = false;
      var i = listeners.indexOf(drawJob);
      if (i >= 0) listeners.splice(i, 1);
      // A running import keeps going and still saves when it finishes.
    };
  }

  /** Current order for display: the saved order with new sources inserted (same rule as import). */
  function currentOrder(summaries, type, saved) {
    var list = summaries.map(function (s, i) {
      return { id: i, key: s.key, cls: s.cls, sourceName: s.sourceName, hardware: s.hardware, manual: s.manual, names: s.names,
        firstSeenMs: { steps: s.firstSeenMs.steps === null ? Infinity : s.firstSeenMs.steps, sleep: s.firstSeenMs.sleep === null ? Infinity : s.firstSeenMs.sleep },
        count: s.count };
    });
    return HT.healthAgg.buildPriority(list, type, saved).order;
  }

  function exportSummaryLines(s) {
    // T005-01: a one-day export prints its date once ("(2026-04-12)"), not "(D to D)".
    var span = !s.from ? '' : (s.from === s.to ? ' (' + s.from + ')' : ' (' + s.from + ' to ' + s.to + ')');
    var lines = ['Imported ' + plural(s.days, 'day') + span + '.'];
    lines.push(plural(s.stepDays, 'day') + ' with steps, ' + plural(s.nights, 'night') + ' of sleep' +
      (s.inBedOnly ? ', ' + plural(s.inBedOnly, 'night') + ' with time in bed only' : '') +
      (s.napOnly ? ', ' + plural(s.napOnly, 'day') + ' with only a nap' : '') + '.');
    // T004-01: say what an export re-import removed (decision 5: a covered day without sleep or
    // steps removes the older export record). Only records that really existed are counted.
    if (s.removedSleep || s.removedSteps) {
      var gone = [];
      if (s.removedSleep) gone.push('sleep for ' + plural(s.removedSleep, 'day'));
      if (s.removedSteps) gone.push('steps for ' + plural(s.removedSteps, 'day'));
      lines.push('Removed ' + gone.join(' and ') + ' that this export no longer includes.');
    }
    if (s.partialNights) lines.push(plural(s.partialNights, 'night is', 'nights are') + ' marked partial: the chosen source stopped early while another source kept recording. Averages leave these out or say how many are included.');
    if (s.rejected) lines.push(fmtNum(s.rejected) + (s.rejected === 1 ? ' record was' : ' records were') + ' skipped because the times or values were invalid.');
    if (s.unknownSleep) lines.push(fmtNum(s.unknownSleep) + (s.unknownSleep === 1 ? ' sleep record had a type' : ' sleep records had a type') + ' this app doesn’t know; not counted as sleep.');
    if (!s.days) lines.push('No sleep or step records were found in this export.');
    return lines;
  }

  function csvHasErrors(r) { return r.results.some(function (x) { return !x.parsed.ok || x.parsed.status === 'nothing'; }); }

  function csvSummaryLines(r) {
    var lines = [];
    if (r.days.length) {
      lines.push('Imported ' + plural(r.days.length, 'day') + ' from the Shortcut (' + (r.days.length > 1 ? r.days[0] + ' to ' + r.days[r.days.length - 1] : r.days[0]) + ').');
    } else lines.push('No days were imported.');
    r.results.forEach(function (x) {
      var p = x.parsed;
      if (!p.ok) lines.push(x.name + ': ' + p.error);
      else if (p.status === 'nothing' && p.stepsDecimal) lines.push(x.name + ': the step count looked like a decimal number, so it was not used, and the file has no sleep. Nothing was imported.');
      else if (p.status === 'nothing') lines.push(x.name + ': No Health data in this file (was the phone locked?). Run the Shortcut again after unlocking.');
      else {
        var bits = [];
        if (x.superseded) bits.push('an older copy of ' + p.day + ', not used');
        if (x.olderThanSaved) bits.push('older copy skipped: a newer Shortcut file for ' + p.day + ' is already imported');
        if (p.stepsDecimal) bits.push('the step count looked like a decimal number, so steps for ' + p.day + ' stay missing');
        else if (p.steps === null) bits.push('no step count, so steps for ' + p.day + ' stay missing');
        if (p.stepsSuspect) bits.push('0 steps and no sleep: kept but marked “check this day”');
        if (p.unknownStages) bits.push(plural(p.unknownStages, 'sleep stage') + ' not recognised (kept, not counted as sleep)');
        if (bits.length) lines.push(x.name + ': ' + bits.join('; ') + '.');
      }
    });
    return lines;
  }

  function helpDetails() {
    return el('details', { style: 'margin-top:8px' }, [
      el('summary', { text: 'How sleep and steps are worked out' }),
      el('ul', { class: 'small' }, [
        el('li', { text: 'Steps: each minute is counted once, from the highest source in your priority list (the Health app also prefers the source at the top of its list). Totals can still differ slightly from the Health app.' }),
        el('li', { text: 'When a Shortcut file and the full export both cover a day, the Shortcut’s step count is shown, but for sleep the full export’s night is shown (it knows manual entries and which device recorded). If the export has only a nap or only time in bed for that day, the Shortcut’s night is shown, together with the export’s nap or time in bed. Both are kept.' }),
        el('li', { text: 'A Shortcut file older than one already imported for the same day is skipped.' }),
        el('li', { text: 'A full export made before one you already imported is only applied if you confirm, because it replaces newer sleep and steps for the days it covers.' }),
        el('li', { text: 'Sleep is counted only from “asleep” stages (Core, Deep, REM, Asleep), never from In Bed or Awake.' }),
        el('li', { text: 'A night belongs to the day you woke up. Waking at or after 18:00 counts toward the next day.' }),
        el('li', { text: 'Each night uses one source. If it stopped early while another source kept recording, the night is marked partial and the other figure is shown beside it; they are never added together.' }),
        el('li', { text: 'Short sleeps ending between 10:00 and 20:00 are kept as naps, separate from the night.' }),
        el('li', { text: 'Travel across time zones can move a night by one day.' })
      ])
    ]);
  }

  HT.importHealth = {
    render: render,
    getSavedOrder: getSavedOrder,
    importExport: importExport,
    importCsvFiles: importCsvFiles,
    exportSummaryLines: exportSummaryLines,
    csvSummaryLines: csvSummaryLines,
    isOlderExport: isOlderExport,
    MSG_OLDER_EXPORT: MSG_OLDER_EXPORT,
    MSG_OLDER_DECLINED: MSG_OLDER_DECLINED,
    _currentOrder: currentOrder
  };
})(window.HT = window.HT || {});
