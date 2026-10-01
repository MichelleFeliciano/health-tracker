/* Health Tracker — settings.js
 * Glucose unit, user-set glucose range, backup export/restore (A-002 §2 items 14–15),
 * "last backup" nudge, storage persistence, Apple Health import slot, about/not-medical-advice.
 *
 * Glucose range rule (decisions.md 2026-09-23 + amendment, R-003 §4, A-003): the range is
 * blank by default with no suggested values; the app never labels a reading high/low/abnormal.
 * The out-of-range notice is OPT-IN and OFF by default (settings.rangeNoticeOn): only when the
 * user ticks the checkbox AND has entered their own range does a reading outside it show one
 * neutral notice plus a fixed emergency line (TEXT below), once, next to the reading. No
 * condition is named and there are no push alerts. Saving a range never turns the notice on.
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

  var CAFFEINE_OLD_BACKUP = 'This backup was made before caffeine tracking, so it has no caffeine entries, drinks or plan.';
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

  /** A-005 R1-3: range order check on the exact mg/dL values to be stored (null = no bound). */
  function rangeOrderOk(lowMgdl, highMgdl) {
    return lowMgdl === null || highMgdl === null || lowMgdl < highMgdl;
  }

  /**
   * Replace-all confirm text (A-005 R1-1/R1-2). prep = HT.db.prepareBackup() result; the
   * per-type breakdown comes from prep.counts (HT.db.countDataRecords), the same count the
   * guard and the result message use.
   */
  function replaceConfirmText(prep) {
    var q = 'Replace all: this erases every entry on this device and loads only the backup file (' +
      HT.db.describeRecordCounts(prep.counts) + ').';
    // D8 (A-010 §1.8): a pre-caffeine backup (schema 1–3) wipes the device's caffeine data.
    if (typeof prep.fromSchema === 'number' && prep.fromSchema < 4) q += '\n\n' + CAFFEINE_OLD_BACKUP;
    if (prep.skipped) {
      q += '\n\n' + prep.skipped + (prep.skipped === 1 ? ' record in the file is' : ' records in the file are') +
        ' unreadable or duplicated and will NOT be restored.';
    }
    return q + '\n\nContinue?';
  }
  /** Replace-all result text, from the same count as the confirm (R1-2). */
  function replaceResultText(r) {
    return 'Restored ' + HT.db.describeRecordCounts(r.restored) + '.';
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

  // ---------- folding sections (B-008) ----------
  // Every Settings section is a disclosure: a heading holding a real button with aria-expanded
  // and aria-controls, and a body that is hidden when closed. All start closed; each section's
  // open/closed state is remembered in localStorage (HT.app.prefGet/prefSet wrap it in
  // try/catch, so blocked storage just means "closed"). A section's key is fixed, not its title.
  var FOLD_PREF = 'fold.settings.';

  /**
   * Build a folding card. Returns { card, body, open(), adoptHeading() }.
   * - title/headingId: the heading text and the id that aria-labelledby points to.
   * - adoptHeading(): for sections drawn by another module into `body` (caffeine, Apple Health
   *   import), move that module's first <h2> up into the fold header (keeping its id), so the
   *   title appears once and the module's own code stays unchanged.
   */
  function foldCard(key, title, headingId) {
    var el = HT.app.el, A = HT.app;
    var bodyId = A.nextId('fold-' + key);
    var titleSpan = el('span', { text: title || '' });
    var btn = el('button', { type: 'button', class: 'fold-btn', 'aria-expanded': 'false', 'aria-controls': bodyId }, [titleSpan]);
    var head = el('h2', { class: 'fold-h', id: headingId || null }, [btn]);
    var body = el('div', { class: 'fold-body', id: bodyId, hidden: true });
    var card = el('section', { class: 'card fold', 'data-fold': key, 'aria-labelledby': headingId || null }, [head, body]);
    function set(open, remember) {
      body.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      card.setAttribute('data-open', open ? 'true' : 'false');
      if (remember) A.prefSet(FOLD_PREF + key, open ? '1' : '0');
    }
    btn.addEventListener('click', function () { set(body.hidden, true); });
    // HT.app.reveal(node) calls this when code must focus something inside a closed section.
    body._reveal = function () { set(true, true); };
    set(A.prefGet(FOLD_PREF + key) === '1', false);
    return {
      card: card,
      body: body,
      button: btn,
      open: function () { set(true, true); },
      adoptHeading: function () {
        var h = body.querySelector('h2');
        if (!h || h.parentNode !== body) return;
        titleSpan.textContent = h.textContent;
        if (h.id) { head.id = h.id; card.setAttribute('aria-labelledby', h.id); h.removeAttribute('id'); }
        body.removeAttribute('aria-labelledby');
        h.remove();
      }
    };
  }

  function render(container) {
    var A = HT.app, D = HT.dates, U = HT.units, el = A.el;
    var alive = true;
    var s = JSON.parse(JSON.stringify(HT.state.settings || HT.db.SETTINGS_DEFAULTS));

    // Saves only the fields this screen owns (glucose unit, range, opt-in), read-modify-write in
    // one transaction, so it never overwrites settings.sourcePriority saved by the Apple Health
    // import section with an older copy (schema v3).
    function save(msg) {
      A.status('Saving…');
      return HT.db.patchSettings({ glucoseUnit: s.glucoseUnit, rangeLowMgdl: s.rangeLowMgdl,
        rangeHighMgdl: s.rangeHighMgdl, rangeNoticeOn: s.rangeNoticeOn === true }).then(function (saved) {
        s = JSON.parse(JSON.stringify(saved));
        HT.state.settings = JSON.parse(JSON.stringify(saved));
        A.status(msg || 'Saved', 'ok');
      }, function (e) { A.saveError(e); throw e; });
    }

    // ---------- glucose unit ----------
    var unitName = A.nextId('unit');
    var unitFold = foldCard('unit', 'Glucose unit', 'gu-h');
    // The fold header shows the title; the legend stays for the radio group's name.
    var unitFs = el('fieldset', null, [el('legend', { class: 'visually-hidden', text: 'Glucose unit' })]);
    var seg = el('div', { class: 'seg' });
    U.UNITS.forEach(function (u) {
      var r = el('input', { type: 'radio', name: unitName, value: u, checked: s.glucoseUnit === u });
      r.addEventListener('change', function () {
        if (!r.checked) return;
        s.glucoseUnit = u;
        save().then(function () { drawRange(); }, function () {});
      });
      seg.appendChild(el('label', { class: 'choice' }, [r, el('span', { text: u })]));
    });
    unitFs.appendChild(el('p', { class: 'field-hint', text: 'Readings are shown in this unit. 1 mmol/L = 18.0156 mg/dL.' }));
    unitFs.appendChild(seg);
    unitFold.body.appendChild(unitFs);
    container.appendChild(unitFold.card);

    // ---------- glucose range ----------
    var rangeFold = foldCard('range', 'My glucose range (optional)', 'range-h');
    var rangeCard = rangeFold.body;
    container.appendChild(rangeFold.card);
    // B-008: Save range / Clear range redraw this section, which removed the focused button and
    // dropped focus to <body>. drawRange(key) puts focus back on the same button after the redraw
    // (opening the fold first via HT.app.reveal). Redraws from elsewhere (unit switch, restore)
    // pass no key and leave focus where it is.
    function drawRange(focusKey) {
      if (!alive) return;
      rangeCard.textContent = '';
      var unit = s.glucoseUnit;
      var lowId = A.nextId('lo'), hiId = A.nextId('hi');
      var lowIn = el('input', { type: 'text', inputmode: 'decimal', id: lowId, autocomplete: 'off' });
      var hiIn = el('input', { type: 'text', inputmode: 'decimal', id: hiId, autocomplete: 'off' });
      // T001-06: remember the text as shown, so an untouched field keeps its exact stored value.
      var origLow = s.rangeLowMgdl == null ? '' : U.formatMgdlIn(s.rangeLowMgdl, unit);
      var origHigh = s.rangeHighMgdl == null ? '' : U.formatMgdlIn(s.rangeHighMgdl, unit);
      lowIn.value = origLow;
      hiIn.value = origHigh;
      var err = el('div', { class: 'field-error', role: 'alert' });
      rangeCard.appendChild(el('p', { class: 'field-hint', text: 'Only fill this in if you and your care team chose a range. Leave it blank and the app won’t compare readings to anything.' }));

      // T001-13: explicit opt-in, off by default. Saved as soon as it is ticked or unticked.
      var optId = A.nextId('rn'), optHintId = optId + '-h';
      var optIn = el('input', { type: 'checkbox', id: optId, checked: s.rangeNoticeOn === true, 'aria-describedby': optHintId });
      var optHint = el('p', { class: 'field-hint', id: optHintId });
      function drawOptHint() {
        var hasRange = s.rangeLowMgdl != null || s.rangeHighMgdl != null;
        optHint.textContent = 'Optional, and off unless you turn it on. When it is on, a short note appears next to a reading that is outside the range you entered. ' +
          (s.rangeNoticeOn && !hasRange ? 'Enter your range below; until then nothing is compared.' : 'The app never suggests a range.');
      }
      optIn.addEventListener('change', function () {
        var prevOn = s.rangeNoticeOn;
        s.rangeNoticeOn = optIn.checked === true;
        drawOptHint();
        save(s.rangeNoticeOn ? 'Range note turned on' : 'Range note turned off').catch(function () {
          s.rangeNoticeOn = prevOn; optIn.checked = prevOn === true; drawOptHint();
        });
      });
      drawOptHint();
      rangeCard.appendChild(el('div', { class: 'check' }, [
        optIn, el('label', { for: optId, text: 'Show a note when a reading is outside my range' })
      ]));
      rangeCard.appendChild(optHint);
      rangeCard.appendChild(el('div', { class: 'row grow' }, [
        el('div', null, [el('label', { for: lowId, text: 'Lowest, in ' + unit }), lowIn]),
        el('div', null, [el('label', { for: hiId, text: 'Highest, in ' + unit }), hiIn])
      ]));
      rangeCard.appendChild(err);
      rangeCard.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [
        el('button', { type: 'button', class: 'primary', 'data-fk': 'save', text: 'Save range', onclick: function () {
          err.textContent = '';
          var lo = U.parseGlucose(lowIn.value, unit), hi = U.parseGlucose(hiIn.value, unit);
          if (!lo.ok) { err.textContent = 'Lowest: ' + lo.error; lowIn.focus(); return; }
          if (!hi.ok) { err.textContent = 'Highest: ' + hi.error; hiIn.focus(); return; }
          // T001-06: an unchanged field keeps the exact stored bound (no re-rounding drift
          // after a unit switch); only an edited field is re-parsed.
          var effLow = lowIn.value.trim() === origLow ? s.rangeLowMgdl : (lo.value === null ? null : U.toMgdlExact(lo.value, unit));
          var effHigh = hiIn.value.trim() === origHigh ? s.rangeHighMgdl : (hi.value === null ? null : U.toMgdlExact(hi.value, unit));
          // A-005 R1-3: validate the EXACT values that will be stored, not the rounded display
          // text — 70–71 mg/dL shows as 3.9–3.9 mmol/L but is still a valid range.
          if (!rangeOrderOk(effLow, effHigh)) { err.textContent = 'The lowest number must be smaller than the highest.'; lowIn.focus(); return; }
          s.rangeLowMgdl = effLow;
          s.rangeHighMgdl = effHigh;
          // Saving a range never turns the note on (T001-13); rangeNoticeOn is left as it is.
          save('Range saved').then(function () { drawRange('save'); }, function () {});
        } }),
        el('button', { type: 'button', 'data-fk': 'clear', text: 'Clear range', onclick: function () {
          // Clearing the range also switches the note off (T001-13 fix direction).
          s.rangeLowMgdl = null; s.rangeHighMgdl = null; s.rangeNoticeOn = false;
          save('Range cleared').then(function () { drawRange('clear'); }, function () {});
        } })
      ]));
      rangeCard.appendChild(el('p', { class: 'small', text: TEXT.emergency }));
      if (focusKey) {
        var t = rangeCard.querySelector('[data-fk="' + focusKey + '"]');
        if (t) { A.reveal(t); try { t.focus(); } catch (e) { /* ignore */ } }
      }
    }
    drawRange();

    // ---------- caffeine (owned by js/caffeine-ui.js, A-010 §6) ----------
    var cafFold = foldCard('caffeine', 'Caffeine', null);
    var caf = null;
    if (HT.caffeineUI && typeof HT.caffeineUI.renderSettingsCard === 'function') {
      container.appendChild(cafFold.card);
      try { caf = HT.caffeineUI.renderSettingsCard(cafFold.body); cafFold.adoptHeading(); } catch (e) { cafFold.card.remove(); }
    }

    // ---------- backup ----------
    var statusP = el('p', { text: backupStatusText() });
    var bkFold = foldCard('backup', 'Backup', 'bk-h');
    [
      el('p', { class: 'field-hint', text: 'Your entries are stored only on this device. A backup is a file you can keep in Files or iCloud Drive and restore later. It contains your health entries, so keep it private.' }),
      statusP,
      el('button', { type: 'button', class: 'primary', text: 'Download backup file', onclick: function () {
        exportBackup().then(function () { statusP.textContent = backupStatusText(); }, function () {});
      } })
    ].forEach(function (n) { bkFold.body.appendChild(n); });
    container.appendChild(bkFold.card);

    // ---------- restore ----------
    var fileId = A.nextId('file'), modeName = A.nextId('mode');
    var fileIn = el('input', { type: 'file', id: fileId, accept: '.json,application/json' });
    var mMerge = el('input', { type: 'radio', name: modeName, value: 'merge', checked: true });
    var mReplace = el('input', { type: 'radio', name: modeName, value: 'replace' });
    var result = el('div', { role: 'status', 'aria-live': 'polite' });
    var restoreBtn = el('button', { type: 'button', class: 'primary', text: 'Restore' });
    var rsFold = foldCard('restore', 'Restore from a backup', 'rs-h');
    container.appendChild(rsFold.card);
    [
      el('label', { for: fileId, style: 'margin-top:0', text: 'Backup file' }), fileIn,
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
    ].forEach(function (n) { rsFold.body.appendChild(n); });
    restoreBtn.addEventListener('click', function () {
      result.textContent = '';
      var f = fileIn.files && fileIn.files[0];
      if (!f) { result.appendChild(el('p', { class: 'field-error', text: 'Choose a backup file first.' })); fileIn.focus(); return; }
      if (f.size > MAX_BACKUP_BYTES) { result.appendChild(el('p', { class: 'field-error', text: 'That file is too large to be a backup from this app.' })); return; }
      var mode = mReplace.checked ? 'replace' : 'merge';
      restoreBtn.disabled = true;
      readFileText(f).then(function (text) {
        var obj;
        try { obj = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { return { ok: false, error: 'The file isn’t valid JSON, so it can’t be a backup.' }; }
        if (mode === 'replace') {
          // T001-01: read and check the file BEFORE asking, so the confirm can show counts,
          // and refuse outright when nothing in it is readable (db.importBackup refuses too).
          var prep = HT.db.prepareBackup(obj);
          if (!prep.ok) return prep;
          // A-005 R1-1: only days, meals, steps and sleep count; a file with only settings or
          // only deletions (tombstones) would erase everything, so it is refused.
          if (!prep.counts.total) return { ok: false, error: 'This backup has no readable entries, so nothing was changed.' };
          if (!window.confirm(replaceConfirmText(prep))) return { ok: false, cancelled: true };
        }
        return HT.db.importBackup(obj, mode);
      }).then(function (r) {
        if (r.cancelled) return;
        if (!r.ok) { result.appendChild(el('p', { class: 'field-error', text: r.error })); return; }
        var c = r.counts;
        var msg = r.mode === 'replace'
          ? replaceResultText(r)
          : 'Merged: ' + c.added + ' added, ' + c.updated + ' updated, ' + c.deleted + ' deleted, ' + c.unchanged + ' unchanged.';
        if (r.skipped) msg += ' ' + r.skipped + ' unreadable or duplicate records were skipped.';
        result.appendChild(el('p', { class: 'field-hint', style: 'color:var(--ok);font-weight:600', text: msg }));
        return HT.db.getSettings().then(function (ns) {
          HT.state.settings = ns;
          s = JSON.parse(JSON.stringify(ns));
          drawRange();
          Array.prototype.forEach.call(unitFs.querySelectorAll('input'), function (i) { i.checked = i.value === s.glucoseUnit; });
          if (caf) caf.refresh();
        });
      }).catch(function (e) {
        result.appendChild(el('p', { class: 'field-error', text: (e && e.name === 'QuotaExceededError') ? 'Not enough storage space to restore.' : 'Restore failed. Nothing may have changed; try again.' }));
      }).then(function () { restoreBtn.disabled = false; });
    });

    // ---------- storage ----------
    var persistP = el('p', { text: 'Checking…' });
    var persistBtn = el('button', { type: 'button', text: 'Ask the browser to keep my data', hidden: true });
    var stFold = foldCard('storage', 'Storage on this device', 'st-h');
    [
      persistP, persistBtn,
      el('p', { class: 'field-hint', text: 'On iPhone, the Home Screen app and Safari keep separate data. Use the app from the Home Screen icon so everything stays in one place.' })
    ].forEach(function (n) { stFold.body.appendChild(n); });
    container.appendChild(stFold.card);
    function drawPersist(p) {
      if (!alive) return;
      if (p === null) { persistP.textContent = 'This browser can’t promise to keep data. Regular backups are the safe choice.'; persistBtn.hidden = true; }
      else if (p) { persistP.textContent = 'The browser has agreed to keep this app’s data.'; persistBtn.hidden = true; }
      else { persistP.textContent = 'The browser may clear this app’s data if the device runs low on space.'; persistBtn.hidden = false; }
    }
    persistBtn.addEventListener('click', function () { A.requestPersist().then(drawPersist); });
    A.persistedState().then(drawPersist);

    // ---------- Apple Health import (owned by js/import-health.js) ----------
    var ihFold = foldCard('health-import', 'Apple Health import', null);
    var importSlot = ihFold.body;
    container.appendChild(ihFold.card);
    var importCleanup = null;
    if (HT.importHealth && typeof HT.importHealth.render === 'function') {
      try { importCleanup = HT.importHealth.render(importSlot); } catch (e) {
        importSlot.appendChild(el('p', { class: 'field-error', text: 'The Apple Health import could not start.' }));
      }
    } else {
      importSlot.appendChild(el('h2', { id: 'ih-h', style: 'margin-top:0', text: 'Apple Health import' }));
      importSlot.appendChild(el('p', { class: 'muted', text: 'Coming soon: import sleep and steps from Apple Health.' }));
    }
    ihFold.adoptHeading();

    // ---------- about ----------
    var abFold = foldCard('about', 'About this app', 'ab-h');
    [
      el('p', { text: 'Not medical advice.' }),
      el('p', { class: 'small', text: TEXT.disclaimer }),
      el('p', { class: 'small', text: TEXT.emergency }),
      el('p', { class: 'small muted', text: 'Everything stays on this device. The app sends nothing anywhere.' })
    ].forEach(function (n) { abFold.body.appendChild(n); });
    container.appendChild(abFold.card);
    // The About section starts folded, so the short note stays visible below the sections.
    container.appendChild(el('p', { class: 'disclaimer', text: 'Not medical advice.' }));

    return function () {
      alive = false;
      if (caf) { try { caf.cleanup(); } catch (e) { /* ignore */ } }
      if (typeof importCleanup === 'function') { try { importCleanup(); } catch (e) { /* ignore */ } }
    };
  }

  HT.settings = {
    TEXT: TEXT,
    render: render,
    exportBackup: exportBackup,
    backupNudgeEl: backupNudgeEl,
    daysSinceBackup: daysSinceBackup,
    backupStatusText: backupStatusText,
    rangeOrderOk: rangeOrderOk,            // exposed for tests (A-005 R1-3)
    foldCard: foldCard,                    // exposed for tests (B-008)
    FOLD_PREF: FOLD_PREF,
    replaceConfirmText: replaceConfirmText, // exposed for tests (A-005 R1-1/R1-2)
    replaceResultText: replaceResultText,
    CAFFEINE_OLD_BACKUP: CAFFEINE_OLD_BACKUP
  };
})(window.HT = window.HT || {});
