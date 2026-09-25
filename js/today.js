/* Health Tracker — today.js
 * Daily log editor for one local date (Today tab, and past days opened from History).
 * - 0–10 ratings with literal wording, a stated time window, labels at both ends, and a
 *   "Hard to tell" choice stored as null (missing), never as a middle value.
 *   Wording follows R-003 §4 (design inference; A-003 review pending).
 * - Trigger-tag chips, meals (time, carb level, optional glucose), notes.
 * - Autosave with a "Saved" indicator in the header.
 * Exposes window.HT.today = { render(container, {date}) }.
 */
(function (HT) {
  'use strict';

  var METRICS = [
    { key: 'anxiety', name: 'Anxiety', q: 'How anxious did you feel', low: '0 = not anxious at all', high: '10 = the most anxious I get', dir: 'Higher number = more anxious.' },
    { key: 'mood', name: 'Mood', q: 'How was your mood', low: '0 = the worst mood I get', high: '10 = the best mood I get', dir: 'Higher number = better mood.' },
    { key: 'energy', name: 'Energy', q: 'How much energy did you have', low: '0 = no energy at all', high: '10 = the most energy I get', dir: 'Higher number = more energy.' },
    { key: 'stress', name: 'Stress', q: 'How stressed did you feel', low: '0 = not stressed at all', high: '10 = the most stressed I get', dir: 'Higher number = more stressed.' }
  ];

  var TAG_LABELS = {
    'sensory': 'Sensory',
    'schedule-change': 'Schedule change',
    'social': 'Social',
    'work-school': 'Work / school',
    'caregiving': 'Caregiving',
    'other': 'Other'
  };
  var CARB_LABELS = { low: 'Low', med: 'Medium', high: 'High' };

  var NOTE_DEBOUNCE_MS = 700;
  var LOG_DEBOUNCE_MS = 200;
  var MINUTES_AFTER_MAX = 720;   // typo guard only (A-005 Part 2; same as HT.db.MINUTES_AFTER_MAX)

  /**
   * "About how many minutes after you started eating?" (A-005 Part 2).
   * Blank → { ok, value: null }. Only whole ASCII minutes 0–720 are accepted: "1.5", "-5",
   * "1:30", "90m" and non-ASCII digits are refused (no guessing).
   */
  function parseMinutesAfter(text) {
    var t = String(text == null ? '' : text).trim();
    if (t === '') return { ok: true, value: null };
    if (!/^[0-9]{1,4}$/.test(t)) return { ok: false, error: 'Enter whole minutes, like 90.' };
    var n = parseInt(t, 10);
    if (n > MINUTES_AFTER_MAX) return { ok: false, error: 'That’s more than 12 hours after the meal. Check the number.' };
    return { ok: true, value: n };
  }

  function render(container, params) {
    var A = HT.app, D = HT.dates, U = HT.units, el = A.el;
    var date = params.date;
    var today = D.todayLocal();
    var isToday = date === today;
    var alive = true;
    var log = null;
    var saveTimer = null;
    var pending = false;

    if (D.daysBetween(today, date) > 0) {
      container.appendChild(el('div', { class: 'notice', role: 'alert' }, [
        el('p', { text: 'That date is in the future, so there is nothing to log yet.' }),
        el('p', null, [el('a', { href: '#today', text: 'Go to today' })])
      ]));
      return null;
    }

    // ---------- saving ----------
    function flush() {
      if (!pending || !log) return Promise.resolve();
      pending = false;
      clearTimeout(saveTimer);
      A.status('Saving…');
      return HT.db.saveDailyLog(log).then(function (saved) {
        log.updatedAt = saved.updatedAt;
        A.status('Saved', 'ok');
      }, function (err) { pending = true; A.saveError(err); });
    }
    function scheduleSave(ms) {
      pending = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, ms);
    }
    function onHide() { if (document.visibilityState === 'hidden') flush(); }
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);

    // ---------- layout ----------
    var windowText = isToday ? 'today, so far' : 'on this day';
    var root = el('div', { class: 'today-view' });
    container.appendChild(root);

    // Day navigation
    var prev = D.addDays(date, -1), next = D.addDays(date, 1);
    root.appendChild(el('div', { class: 'daynav' }, [
      el('a', { class: 'btn', href: '#day/' + prev, 'aria-label': 'Previous day, ' + D.formatLong(prev), text: '‹ Prev' }),
      el('h2', { text: isToday ? D.formatLong(date) : D.formatRelative(date, today) }),
      D.daysBetween(today, next) > 0
        ? el('span', { style: 'min-width:44px' })
        : el('a', { class: 'btn', href: next === today ? '#today' : '#day/' + next, 'aria-label': 'Next day, ' + D.formatLong(next), text: 'Next ›' })
    ]));

    if (isToday && HT.settings && typeof HT.settings.backupNudgeEl === 'function') {
      var nudge = HT.settings.backupNudgeEl();
      if (nudge) root.appendChild(nudge);
    }

    var ratingsSec = el('section', { 'aria-labelledby': 'feel-h' }, [el('h2', { id: 'feel-h', text: 'How it went' })]);
    var tagsSec = el('section', { 'aria-labelledby': 'tags-h' });
    var mealsSec = el('section', { 'aria-labelledby': 'meals-h' });
    // Caffeine (A-010 §6): owned by js/caffeine-ui.js; this file only mounts it after Meals.
    var cafSec = el('section', { class: 'caf-section' });
    var cafCleanup = null;
    var notesSec = el('section', { 'aria-labelledby': 'notes-h' });
    root.appendChild(ratingsSec);
    root.appendChild(tagsSec);
    root.appendChild(mealsSec);
    root.appendChild(cafSec);
    root.appendChild(notesSec);
    root.appendChild(el('p', { class: 'disclaimer', text: 'A personal log, not medical advice. Ratings are for spotting your own patterns and have no cut-offs.' }));

    // ---------- ratings ----------
    function ratingControl(m) {
      var name = A.nextId('r-' + m.key);
      var legendId = A.nextId('lg');
      var fs = el('fieldset', { class: 'rating', 'aria-describedby': legendId + '-d' });
      fs.appendChild(el('legend', { class: 'question', text: m.name + ' — ' + m.q + ' ' + windowText + '?' }));
      fs.appendChild(el('div', { class: 'ends', id: legendId + '-d' }, [
        el('span', { text: m.low }), el('span', { text: m.high })
      ]));
      var grid = el('div', { class: 'scale' });
      var inputs = [];
      for (var i = 0; i <= 10; i++) {
        var inp = el('input', { type: 'radio', name: name, value: String(i), 'aria-label': i + (i === 0 ? ' (' + m.low.replace(/^0 = /, '') + ')' : i === 10 ? ' (' + m.high.replace(/^10 = /, '') + ')' : '') });
        inputs.push(inp);
        grid.appendChild(el('label', { class: 'choice' }, [inp, el('span', { text: String(i) })]));
      }
      fs.appendChild(grid);
      var unsure = el('input', { type: 'radio', name: name, value: 'unsure' });
      inputs.push(unsure);
      var status = el('span', { class: 'status' });
      // T001-11: a distinct accessible name per rating ("Clear anxiety rating").
      var clearBtn = el('button', { type: 'button', class: 'link', text: 'Clear', 'aria-label': 'Clear ' + m.name.toLowerCase() + ' rating' });
      fs.appendChild(el('div', { class: 'extra' }, [
        el('label', { class: 'choice' }, [unsure, el('span', { text: isToday ? 'Hard to tell today' : 'Hard to tell for this day' })]),
        clearBtn, status
      ]));
      fs.appendChild(el('p', { class: 'field-hint', text: m.dir }));

      function sync() {
        var v = log[m.key];
        var isUnsure = v === null && log.hardToTell.indexOf(m.key) >= 0;
        inputs.forEach(function (x) { x.checked = isUnsure ? x.value === 'unsure' : (v !== null && x.value === String(v)); });
        status.textContent = v !== null ? '' : isUnsure ? 'Saved as not answered.' : 'Not answered yet.';
      }
      fs.addEventListener('change', function (ev) {
        var t = ev.target;
        if (!t || t.name !== name) return;
        var ht = log.hardToTell.filter(function (k) { return k !== m.key; });
        if (t.value === 'unsure') { log[m.key] = null; ht.push(m.key); }
        else log[m.key] = parseInt(t.value, 10);
        log.hardToTell = ht;
        sync();
        scheduleSave(LOG_DEBOUNCE_MS);
      });
      clearBtn.addEventListener('click', function () {
        log[m.key] = null;
        log.hardToTell = log.hardToTell.filter(function (k) { return k !== m.key; });
        sync();
        scheduleSave(LOG_DEBOUNCE_MS);
      });
      fs._sync = sync;
      return fs;
    }

    // ---------- tags ----------
    function buildTags() {
      tagsSec.appendChild(el('h2', { id: 'tags-h', text: isToday ? 'What happened today?' : 'What happened this day?' }));
      tagsSec.appendChild(el('p', { class: 'field-hint', text: 'Tap any that apply. Tap again to remove.' }));
      var wrap = el('div', { class: 'chips', role: 'group', 'aria-labelledby': 'tags-h' });
      HT.db.TAGS.forEach(function (t) {
        var on = log.tags.indexOf(t) >= 0;
        var b = el('button', { type: 'button', class: 'chip', 'aria-pressed': on ? 'true' : 'false', text: TAG_LABELS[t] });
        b.addEventListener('click', function () {
          var i = log.tags.indexOf(t);
          if (i >= 0) log.tags.splice(i, 1); else log.tags.push(t);
          b.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
          scheduleSave(LOG_DEBOUNCE_MS);
        });
        wrap.appendChild(b);
      });
      tagsSec.appendChild(wrap);
    }

    // ---------- notes ----------
    function buildNotes() {
      var id = A.nextId('notes');
      notesSec.appendChild(el('h2', { id: 'notes-h' }, [el('label', { for: id, style: 'margin:0;font-weight:inherit', text: 'Notes' })]));
      var ta = el('textarea', { id: id, rows: '4', maxlength: '20000', placeholder: 'Anything you want to remember (optional)' });
      ta.value = log.notes || '';
      ta.addEventListener('input', function () { log.notes = ta.value; scheduleSave(NOTE_DEBOUNCE_MS); });
      ta.addEventListener('blur', flush);
      notesSec.appendChild(ta);
    }

    // ---------- meals ----------
    var meals = [];
    var mealListEl = el('ul', { class: 'meal-list' });
    var mealFormSlot = el('div');
    var addBtn = el('button', { type: 'button', class: 'primary', text: '+ Add meal' });

    function settingsNow() { return HT.state.settings || HT.db.SETTINGS_DEFAULTS; }

    function rangeNoticeEl() {
      var T = (HT.settings && HT.settings.TEXT) || {};
      return el('div', { class: 'notice', role: 'note' }, [
        el('p', { text: T.rangeNotice || 'This reading is outside the range you set. If you’re unsure what it means, consider checking with your care team.' }),
        el('p', { text: T.emergency || 'If you feel very unwell, call your local emergency number.' })
      ]);
    }

    function mealSummary(m) {
      var s = settingsNow();
      var parts = [];
      parts.push('Carbs: ' + (m.carb ? CARB_LABELS[m.carb] : 'not set'));
      if (m.glucose) {
        var gtxt = 'Glucose ' + U.format(m.glucose.value, m.glucose.unit, s.glucoseUnit);
        // A-005: neutral wording only, no colour or judgement about the timing.
        if (typeof m.glucose.minutesAfter === 'number') gtxt += ' · about ' + m.glucose.minutesAfter + ' min after starting';
        parts.push(gtxt);
      }
      return parts.join(' · ');
    }

    function renderMeals() {
      mealListEl.textContent = '';
      if (!meals.length) {
        mealListEl.appendChild(el('li', { class: 'muted', text: 'No meals logged.' }));
        return;
      }
      var s = settingsNow();
      meals.forEach(function (m) {
        var main = el('div', { class: 'meal-main' }, [
          el('strong', { class: 'meal-time', text: D.formatTime(m.time) }), ' ',
          el('span', { text: mealSummary(m) }),
          m.note ? el('div', { class: 'small muted', text: m.note }) : null
        ]);
        var li = el('li', null, [
          main,
          el('div', { class: 'row meal-actions' }, [
            el('button', { type: 'button', text: 'Edit', 'aria-label': 'Edit meal at ' + D.formatTime(m.time), onclick: function () { openForm(m); } }),
            el('button', { type: 'button', class: 'danger', text: 'Delete', 'aria-label': 'Delete meal at ' + D.formatTime(m.time), onclick: function () { removeMeal(m); } })
          ])
        ]);
        // T001-13: the notice is OPT-IN (decisions.md 2026-09-23 amendment): shown only when
        // the user switched it on in Settings AND the reading is outside their own range,
        // compared at the precision shown on screen (T001-05). Once per reading, no alerts.
        if (m.glucose && s.rangeNoticeOn === true &&
            U.outsideRange(m.glucose.value, m.glucose.unit, s.rangeLowMgdl, s.rangeHighMgdl, s.glucoseUnit)) {
          li.appendChild(el('div', { style: 'flex-basis:100%' }, [rangeNoticeEl()]));
        }
        mealListEl.appendChild(li);
      });
    }

    function reloadMeals() {
      return HT.db.getMealsForDate(date).then(function (list) {
        if (!alive) return;
        meals = list; renderMeals();
      });
    }

    function removeMeal(m) {
      if (!window.confirm('Delete the meal at ' + D.formatTime(m.time) + '?')) return;
      A.status('Saving…');
      HT.db.deleteMeal(m.id).then(function () { A.status('Deleted', 'ok'); return reloadMeals(); }, A.saveError);
    }

    function openForm(existing) {
      var s = settingsNow();
      var unit = s.glucoseUnit;
      var fid = A.nextId('meal');
      mealFormSlot.textContent = '';
      addBtn.hidden = true;

      var timeIn = el('input', { type: 'time', id: fid + '-time', required: true });
      timeIn.value = existing ? existing.time : (isToday ? D.nowHHMM() : '');

      var carbName = fid + '-carb';
      var carbInputs = [];
      var seg = el('div', { class: 'seg' });
      HT.db.CARBS.forEach(function (c) {
        var r = el('input', { type: 'radio', name: carbName, value: c });
        if (existing && existing.carb === c) r.checked = true;
        carbInputs.push(r);
        seg.appendChild(el('label', { class: 'choice' }, [r, el('span', { text: CARB_LABELS[c] })]));
      });

      var origGlucoseText = '';
      if (existing && existing.glucose) {
        origGlucoseText = unit === U.MMOL
          ? U.convert(existing.glucose.value, existing.glucose.unit, unit).toFixed(1)
          : String(U.convert(existing.glucose.value, existing.glucose.unit, unit));
      }
      var gIn = el('input', { type: 'text', inputmode: 'decimal', id: fid + '-g', autocomplete: 'off', 'aria-describedby': fid + '-gh ' + fid + '-ge' });
      gIn.value = origGlucoseText;
      // A-005 Part 2: optional reading time, in minutes after the meal started. Text input
      // (like the glucose field) to avoid iOS number-input quirks. No 60–120 guidance here.
      var gmIn = el('input', { type: 'text', inputmode: 'numeric', id: fid + '-gm', autocomplete: 'off', 'aria-describedby': fid + '-gmh ' + fid + '-ge' });
      gmIn.value = (existing && existing.glucose && typeof existing.glucose.minutesAfter === 'number') ? String(existing.glucose.minutesAfter) : '';
      var noteIn = el('input', { type: 'text', id: fid + '-note', maxlength: '2000', autocomplete: 'off' });
      noteIn.value = existing ? (existing.note || '') : '';
      var err = el('div', { class: 'field-error', id: fid + '-ge', role: 'alert' });
      var submitBtn = el('button', { type: 'submit', class: 'primary', text: 'Save meal' });
      // T001-02: the id is fixed when the form opens, and a second submit is ignored while
      // a save is in flight, so a double-click/double-tap can never create two meals.
      var mealId = existing ? existing.id : HT.db.newId();
      var saving = false;

      var form = el('form', { class: 'meal-form', novalidate: true, 'aria-label': existing ? 'Edit meal' : 'Add meal' }, [
        el('label', { for: timeIn.id, text: 'Time' }), timeIn,
        el('fieldset', null, [
          el('legend', { style: 'margin-top:10px', text: 'Carbs in this meal' }),
          el('p', { class: 'field-hint', text: 'Your own rough guess. Leave unselected if unsure.' }),
          seg
        ]),
        el('label', { for: gIn.id, text: 'Glucose reading (optional), in ' + unit }),
        el('p', { class: 'field-hint', id: fid + '-gh', text: 'From your meter, if you took one. Leave blank if not.' }),
        gIn, err,
        el('label', { for: gmIn.id, text: 'About how many minutes after you started eating? (optional)' }),
        el('p', { class: 'field-hint', id: fid + '-gmh', text: 'Roughly is fine, for example 90 for an hour and a half. Leave blank if you’re not sure. Patterns use only readings that have this filled in.' }),
        gmIn,
        el('label', { for: noteIn.id, text: 'What you ate (optional)' }), noteIn,
        el('div', { class: 'row', style: 'margin-top:12px' }, [
          submitBtn,
          el('button', { type: 'button', text: 'Cancel', onclick: closeForm })
        ])
      ]);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (saving) return;
        err.textContent = '';
        var t = (timeIn.value || '').slice(0, 5);
        if (!D.isValidTime(t)) { err.textContent = 'Enter a time for the meal.'; timeIn.focus(); return; }
        var glucose = null;
        if (existing && existing.glucose && gIn.value.trim() === origGlucoseText) {
          // Unchanged: keep the stored value/unit (no round-trip drift, T001-06). Always a NEW
          // object, so the minutes below never leak from the old record (A-005 Part 2 #5).
          glucose = { value: existing.glucose.value, unit: existing.glucose.unit };
        } else {
          var p = U.parseGlucose(gIn.value, unit);
          if (!p.ok) { err.textContent = p.error; gIn.focus(); return; }
          glucose = p.value === null ? null : { value: p.value, unit: unit };
        }
        var pm = parseMinutesAfter(gmIn.value);
        if (!pm.ok) { err.textContent = pm.error; gmIn.focus(); return; }
        if (pm.value !== null && glucose === null) {
          err.textContent = 'Add the glucose reading, or leave the minutes blank.'; gmIn.focus(); return;
        }
        // Blank minutes → the key is absent (unknown), never null.
        if (glucose && pm.value !== null) glucose.minutesAfter = pm.value;
        var carb = null;
        carbInputs.forEach(function (r) { if (r.checked) carb = r.value; });
        var rec = existing ? JSON.parse(JSON.stringify(existing)) : { id: mealId, date: date };
        rec.time = t; rec.carb = carb; rec.glucose = glucose; rec.note = noteIn.value.trim().slice(0, 2000);
        saving = true;
        submitBtn.disabled = true;
        A.status('Saving…');
        HT.db.saveMeal(rec).then(function () {
          A.status('Saved', 'ok');
          if (!alive) return;
          closeForm();
          return reloadMeals();
        }, function (e) {
          saving = false;
          submitBtn.disabled = false;
          A.saveError(e);
        });
      });

      mealFormSlot.appendChild(form);
      timeIn.focus();
    }

    function closeForm() {
      mealFormSlot.textContent = '';
      addBtn.hidden = false;
      addBtn.focus();
    }

    function buildMeals() {
      mealsSec.appendChild(el('h2', { id: 'meals-h', text: 'Meals' }));
      mealsSec.appendChild(mealListEl);
      mealsSec.appendChild(mealFormSlot);
      addBtn.addEventListener('click', function () { openForm(null); });
      mealsSec.appendChild(addBtn);
    }

    // ---------- load ----------
    Promise.all([HT.db.getDailyLog(date), HT.db.getMealsForDate(date)]).then(function (res) {
      if (!alive) return;
      log = res[0] ? JSON.parse(JSON.stringify(res[0])) : HT.db.emptyDailyLog(date);
      if (!Array.isArray(log.tags)) log.tags = [];
      if (!Array.isArray(log.hardToTell)) log.hardToTell = [];
      METRICS.forEach(function (m) {
        var c = ratingControl(m);
        ratingsSec.appendChild(c);
        c._sync();
      });
      buildTags();
      buildMeals();
      buildNotes();
      meals = res[1];
      renderMeals();
      if (HT.caffeineUI && typeof HT.caffeineUI.mountDay === 'function') {
        try { cafCleanup = HT.caffeineUI.mountDay(cafSec, { date: date, today: today }); } catch (e) { cafSec.textContent = ''; }
      }
    }).catch(function () {
      if (!alive) return;
      root.appendChild(el('div', { class: 'notice', role: 'alert' }, [el('p', { text: 'Could not load this day. Try reloading.' })]));
    });

    return function cleanupToday() {
      flush();
      alive = false;
      if (typeof cafCleanup === 'function') { try { cafCleanup(); } catch (e) { /* ignore */ } }
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }

  HT.today = { render: render, METRICS: METRICS, TAG_LABELS: TAG_LABELS, CARB_LABELS: CARB_LABELS,
    parseMinutesAfter: parseMinutesAfter, MINUTES_AFTER_MAX: MINUTES_AFTER_MAX };
})(window.HT = window.HT || {});
