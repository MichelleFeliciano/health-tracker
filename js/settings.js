/* Health Tracker — settings.js
 * Glucose unit, user-set glucose range, backup export/restore (A-002 §2 items 14–15),
 * "last backup" nudge, storage persistence, Apple Health import slot, about/not-medical-advice.
 *
 * Glucose range rule (decisions.md 2026-09-23, R-003 §4): blank by default; the app never
 * labels a reading high/low/abnormal. If the user sets a range, a reading outside it shows
 * one neutral notice plus a fixed emergency line (TEXT below). No condition is named.
 * Exposes window.HT.settings.
 */
(function (HT) {
  'use strict';

  var TEXT = {
    rangeNotice: 'This reading is outside the range you set. If you’re unsure what it means, consider checking with your care team.',
    emergency: 'If you feel very unwell, call your local emergency number.',
    disclaimer: 'This app is a personal log. It helps you record and look back at your sleep, activity, meals and how you feel. ' +
      'It does not diagnose, treat or prevent any condition and is not medical advice. Patterns are links in your own data, ' +
      'not proof of cause, and watch measurements such as sleep stages and steps are estimates. ' +
      'Talk with a qualified health professional about health questions and before changing any treatment.'
  };

  var NUDGE_DAYS = 7;
  var MAX_BACKUP_BYTES = 100 * 1024 * 1024;

  // Remember when the app was first used, so the backup nudge can start after 7 days.
  (function () {
    try { if (!window.localStorage.getItem('ht.firstUseAt')) window.localStorage.setItem('ht.firstUseAt', new Date().toISOString()); } catch (e) { /* ignore */ }
  })();

  function lastBackupIso() { return HT.app.prefGet('lastBackupAt'); }

  /** Days since the last backup (local calendar days), or null if never. */
  function daysSinceBackup() {
    var D = HT.dates;
    var ms = D.isoToMs(lastBackupIso() || '');
    if (isNaN(ms)) return null;
    return D.daysBetween(D.toLocalDateStr(new Date(ms)), D.todayLocal());
  }

  function backupStatusText() {
    var n = daysSinceBackup();
    if (n === null) return 'You haven’t made a backup on this device yet.';
    if (n <= 0) return 'Last backup: today.';
    if (n === 1) return 'Last backup: 1 day ago.';
    return 'Last backup: ' + n + ' days ago.';
  }

  /** Nudge element when the last backup is 7+ days old (or never, 7+ days after first use). */
  function backupNudgeEl() {
    var D = HT.dates, A = HT.app;
    var n = daysSinceBackup();
    if (n === null) {
      var first = D.isoToMs(A.prefGet('firstUseAt') || '');
      if (isNaN(first) || D.daysBetween(D.toLocalDateStr(new Date(first)), D.todayLocal()) < NUDGE_DAYS) return null;
    } else if (n < NUDGE_DAYS) return null;
    return A.el('div', { class: 'banner', role: 'note' }, [
      A.el('p', { style: 'margin:0 0 6px', text: backupStatusText() + ' Your entries live only on this device, so a backup file protects them.' }),
      A.el('button', { type: 'button', text: 'Download a backup now', onclick: function (ev) {
        var b = ev.currentTarget;
        exportBackup().then(function () { var bn = b.closest('.banner'); if (bn) bn.remove(); }, function () {});
      } })
    ]);
  }

  /** Build the backup file and offer it as a download. */
  function exportBackup() {
    var A = HT.app;
    return HT.db.exportAll().then(function (obj) {
      var json = JSON.stringify(obj);
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'health-tracker-backup-' + HT.dates.todayLocal() + '.json';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      A.prefSet('lastBackupAt', HT.dates.nowIso());
      A.status('Backup file created', 'ok');
    }).catch(function (e) {
      A.status('Backup failed — try again', 'err');
      throw e;
    });
  }

  function readFileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  }

  function render(container) {
    var A = HT.app, D = HT.dates, U = HT.units, el = A.el;
    var alive = true;
    var s = JSON.parse(JSON.stringify(HT.state.settings || HT.db.SETTINGS_DEFAULTS));

    function save(msg) {
      A.status('Saving…');
      return HT.db.saveSettings(s).then(function (saved) {
        s.updatedAt = saved.updatedAt;
        HT.state.settings = JSON.parse(JSON.stringify(saved));
        A.status(msg || 'Saved', 'ok');
      }, function (e) { A.saveError(e); throw e; });
    }

    // ---------- glucose unit ----------
    var unitName = A.nextId('unit');
    var unitFs = el('fieldset', { class: 'card' }, [el('legend', { text: 'Glucose unit' })]);
    var seg = el('div', { class: 'seg' });
    U.UNITS.forEach(function (u) {
      var r = el('input', { type: 'radio', name: unitName, value: u, checked: s.glucoseUnit === u });
      r.addEventListener('change', function () {
        if (!r.checked) return;
        s.glucoseUnit = u;
        save().then(drawRange, function () {});
      });
      seg.appendChild(el('label', { class: 'choice' }, [r, el('span', { text: u })]));
    });
    unitFs.appendChild(el('p', { class: 'field-hint', text: 'Readings are shown in this unit. 1 mmol/L = 18.0156 mg/dL.' }));
    unitFs.appendChild(seg);
    container.appendChild(unitFs);

    // ---------- glucose range ----------
    var rangeCard = el('section', { class: 'card', 'aria-labelledby': 'range-h' });
    container.appendChild(rangeCard);
    function drawRange() {
      if (!alive) return;
      rangeCard.textContent = '';
      var unit = s.glucoseUnit;
      var lowId = A.nextId('lo'), hiId = A.nextId('hi');
      var lowIn = el('input', { type: 'text', inputmode: 'decimal', id: lowId, autocomplete: 'off' });
      var hiIn = el('input', { type: 'text', inputmode: 'decimal', id: hiId, autocomplete: 'off' });
      lowIn.value = s.rangeLowMgdl == null ? '' : U.formatMgdlIn(s.rangeLowMgdl, unit);
      hiIn.value = s.rangeHighMgdl == null ? '' : U.formatMgdlIn(s.rangeHighMgdl, unit);
      var err = el('div', { class: 'field-error', role: 'alert' });
      rangeCard.appendChild(el('h2', { id: 'range-h', style: 'margin-top:0', text: 'My glucose range (optional)' }));
      rangeCard.appendChild(el('p', { class: 'field-hint', text: 'Only fill this in if you and your care team chose a range. Leave it blank and the app won’t compare readings to anything.' }));
      rangeCard.appendChild(el('div', { class: 'row grow' }, [
        el('div', null, [el('label', { for: lowId, text: 'Lowest, in ' + unit }), lowIn]),
        el('div', null, [el('label', { for: hiId, text: 'Highest, in ' + unit }), hiIn])
      ]));
      rangeCard.appendChild(err);
      rangeCard.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', { type: 'button', class: 'primary', text: 'Save range', onclick: function () {
          err.textContent = '';
          var lo = U.parseGlucose(lowIn.value, unit), hi = U.parseGlucose(hiIn.value, unit);
          if (!lo.ok) { err.textContent = 'Lowest: ' + lo.error; lowIn.focus(); return; }
          if (!hi.ok) { err.textContent = 'Highest: ' + hi.error; hiIn.focus(); return; }
          if (lo.value !== null && hi.value !== null && lo.value >= hi.value) { err.textContent = 'The lowest number must be smaller than the highest.'; lowIn.focus(); return; }
          s.rangeLowMgdl = lo.value === null ? null : U.toMgdlExact(lo.value, unit);
          s.rangeHighMgdl = hi.value === null ? null : U.toMgdlExact(hi.value, unit);
          save('Range saved').catch(function () {});
        } }),
        el('button', { type: 'button', text: 'Clear range', onclick: function () {
          s.rangeLowMgdl = null; s.rangeHighMgdl = null;
          save('Range cleared').then(drawRange, function () {});
        } })
      ]));
      rangeCard.appendChild(el('p', { class: 'small', text: TEXT.emergency }));
    }
    drawRange();

    // ---------- backup ----------
    var statusP = el('p', { text: backupStatusText() });
    container.appendChild(el('section', { class: 'card', 'aria-labelledby': 'bk-h' }, [
      el('h2', { id: 'bk-h', style: 'margin-top:0', text: 'Backup' }),
      el('p', { class: 'field-hint', text: 'Your entries are stored only on this device. A backup is a file you can keep in Files or iCloud Drive and restore later. It contains your health entries, so keep it private.' }),
      statusP,
      el('button', { type: 'button', class: 'primary', text: 'Download backup file', onclick: function () {
        exportBackup().then(function () { statusP.textContent = backupStatusText(); }, function () {});
      } })
    ]));

    // ---------- restore ----------
    var fileId = A.nextId('file'), modeName = A.nextId('mode');
    var fileIn = el('input', { type: 'file', id: fileId, accept: '.json,application/json' });
    var mMerge = el('input', { type: 'radio', name: modeName, value: 'merge', checked: true });
    var mReplace = el('input', { type: 'radio', name: modeName, value: 'replace' });
    var result = el('div', { role: 'status', 'aria-live': 'polite' });
    var restoreBtn = el('button', { type: 'button', class: 'primary', text: 'Restore' });
    container.appendChild(el('section', { class: 'card', 'aria-labelledby': 'rs-h' }, [
      el('h2', { id: 'rs-h', style: 'margin-top:0', text: 'Restore from a backup' }),
      el('label', { for: fileId, text: 'Backup file' }), fileIn,
      el('fieldset', { style: 'margin-top:10px' }, [
        el('legend', { text: 'How to restore' }),
        el('div', { class: 'seg' }, [
          el('label', { class: 'choice' }, [mMerge, el('span', { text: 'Merge (recommended)' })]),
          el('label', { class: 'choice' }, [mReplace, el('span', { text: 'Replace all' })])
        ]),
        el('p', { class: 'field-hint', text: 'Merge keeps whatever was changed most recently, on this device or in the file. Deleted entries stay deleted. Replace all erases everything on this device first and loads only the file.' })
      ]),
      el('div', { style: 'margin-top:10px' }, [restoreBtn]),
      result
    ]));
    restoreBtn.addEventListener('click', function () {
      result.textContent = '';
      var f = fileIn.files && fileIn.files[0];
      if (!f) { result.appendChild(el('p', { class: 'field-error', text: 'Choose a backup file first.' })); fileIn.focus(); return; }
      if (f.size > MAX_BACKUP_BYTES) { result.appendChild(el('p', { class: 'field-error', text: 'That file is too large to be a backup from this app.' })); return; }
      var mode = mReplace.checked ? 'replace' : 'merge';
      if (mode === 'replace' && !window.confirm('Replace all: this erases every entry on this device and loads only the backup file. Continue?')) return;
      restoreBtn.disabled = true;
      readFileText(f).then(function (text) {
        var obj;
        try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { ok: false, error: 'The file isn’t valid JSON, so it can’t be a backup.' }; }
        return HT.db.importBackup(obj, mode);
      }).then(function (r) {
        if (!r.ok) { result.appendChild(el('p', { class: 'field-error', text: r.error })); return; }
        var c = r.counts;
        var msg = r.mode === 'replace'
          ? 'Restored ' + c.added + ' records.'
          : 'Merged: ' + c.added + ' added, ' + c.updated + ' updated, ' + c.deleted + ' deleted, ' + c.unchanged + ' unchanged.';
        if (r.skipped) msg += ' ' + r.skipped + ' unreadable or duplicate records were skipped.';
        result.appendChild(el('p', { class: 'field-hint', style: 'color:var(--ok);font-weight:600', text: msg }));
        return HT.db.getSettings().then(function (ns) {
          HT.state.settings = ns;
          s = JSON.parse(JSON.stringify(ns));
          drawRange();
          Array.prototype.forEach.call(unitFs.querySelectorAll('input'), function (i) { i.checked = i.value === s.glucoseUnit; });
        });
      }).catch(function (e) {
        result.appendChild(el('p', { class: 'field-error', text: (e && e.name === 'QuotaExceededError') ? 'Not enough storage space to restore.' : 'Restore failed. Nothing may have changed; try again.' }));
      }).then(function () { restoreBtn.disabled = false; });
    });

    // ---------- storage ----------
    var persistP = el('p', { text: 'Checking…' });
    var persistBtn = el('button', { type: 'button', text: 'Ask the browser to keep my data', hidden: true });
    container.appendChild(el('section', { class: 'card', 'aria-labelledby': 'st-h' }, [
      el('h2', { id: 'st-h', style: 'margin-top:0', text: 'Storage on this device' }),
      persistP, persistBtn,
      el('p', { class: 'field-hint', text: 'On iPhone, the Home Screen app and Safari keep separate data. Use the app from the Home Screen icon so everything stays in one place.' })
    ]));
    function drawPersist(p) {
      if (!alive) return;
      if (p === null) { persistP.textContent = 'This browser can’t promise to keep data. Regular backups are the safe choice.'; persistBtn.hidden = true; }
      else if (p) { persistP.textContent = 'The browser has agreed to keep this app’s data.'; persistBtn.hidden = true; }
      else { persistP.textContent = 'The browser may clear this app’s data if the device runs low on space.'; persistBtn.hidden = false; }
    }
    persistBtn.addEventListener('click', function () { A.requestPersist().then(drawPersist); });
    A.persistedState().then(drawPersist);

    // ---------- Apple Health import (owned by js/import-health.js) ----------
    var importSlot = el('section', { class: 'card', 'aria-labelledby': 'ih-h' });
    container.appendChild(importSlot);
    var importCleanup = null;
    if (HT.importHealth && typeof HT.importHealth.render === 'function') {
      try { importCleanup = HT.importHealth.render(importSlot); } catch (e) {
        importSlot.appendChild(el('p', { class: 'field-error', text: 'The Apple Health import could not start.' }));
      }
    } else {
      importSlot.appendChild(el('h2', { id: 'ih-h', style: 'margin-top:0', text: 'Apple Health import' }));
      importSlot.appendChild(el('p', { class: 'muted', text: 'Coming soon: import sleep and steps from Apple Health.' }));
    }

    // ---------- about ----------
    container.appendChild(el('section', { class: 'card', 'aria-labelledby': 'ab-h' }, [
      el('h2', { id: 'ab-h', style: 'margin-top:0', text: 'About this app' }),
      el('p', { text: 'Not medical advice.' }),
      el('p', { class: 'small', text: TEXT.disclaimer }),
      el('p', { class: 'small', text: TEXT.emergency }),
      el('p', { class: 'small muted', text: 'Everything stays on this device. The app sends nothing anywhere.' })
    ]));

    return function () {
      alive = false;
      if (typeof importCleanup === 'function') { try { importCleanup(); } catch (e) { /* ignore */ } }
    };
  }

  HT.settings = {
    TEXT: TEXT,
    render: render,
    exportBackup: exportBackup,
    backupNudgeEl: backupNudgeEl,
    daysSinceBackup: daysSinceBackup,
    backupStatusText: backupStatusText
  };
})(window.HT = window.HT || {});
