/* Health Tracker — caffeine-ui.js
 * Caffeine screens, Batch A (docs/team/analysis/A-010-caffeine-spec.md §3, §6):
 *  - the day section on Today / past days (mounted by js/today.js after Meals): baseline status
 *    (today only), day total, quick add from My drinks (today only), entry list, the add/edit
 *    form, and the "No caffeine today" toggle;
 *  - the Settings "Caffeine" card (mounted by js/settings.js): volume unit, the baseline
 *    ("Track my usual amount"), My drinks, and the W1 note.
 * Batch B (B-006; A-010 §4, §5, §6, §10): the plan start form, the step-day offer (Next / Stay /
 * Go back, Stay first + W6 after a headache/tiredness mark), the daily target line (W7 when done),
 * W8 under late entries, the headache/tiredness chips, the Settings bedtime (W9) and cut-off
 * controls and the plan section with its history table. T006-01: after every action that
 * disables or redraws the focused control, focus returns to the equivalent control (data-fk).
 *
 * U-1 (decisions.md 2026-09-25): no caffeine element uses `.notice`, `--danger`, `--notice-*`
 * or `--focus`; notes are `.banner` or plain `.small` text; totals are never coloured and there
 * is no icon, badge or message at any amount. The only exceptions are `.field-error` form
 * validation text and `button.danger` Delete buttons (existing conventions).
 * All arithmetic lives in js/caffeine-core.js. Never logs entries.
 * Exposes window.HT.caffeineUI = { mountDay, renderSettingsCard, buildForm, buildStartForm, … }.
 */
(function (HT) {
  'use strict';

  // ---------- small helpers (work with or without js/app.js, so tests can mount pieces) ----------
  function el(tag, attrs, children) {
    if (HT.app && typeof HT.app.el === 'function') return HT.app.el(tag, attrs, children);
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }
  var uid = 0;
  function nextId(p) {
    if (HT.app && typeof HT.app.nextId === 'function') return HT.app.nextId(p);
    uid += 1; return (p || 'caf') + '-c' + uid;
  }
  function status(msg, kind) { if (HT.app && typeof HT.app.status === 'function') HT.app.status(msg, kind); }
  function saveError(e) { if (HT.app && typeof HT.app.saveError === 'function') HT.app.saveError(e); }
  function prefGet(k) {
    if (HT.app && typeof HT.app.prefGet === 'function') return HT.app.prefGet(k);
    try { return window.localStorage.getItem('ht.' + k); } catch (e) { return null; }
  }
  function prefSet(k, v) {
    if (HT.app && typeof HT.app.prefSet === 'function') { HT.app.prefSet(k, v); return; }
    try { window.localStorage.setItem('ht.' + k, v); } catch (e) { /* ignore */ }
  }
  function settingsNow() { return (HT.state && HT.state.settings) || HT.db.SETTINGS_DEFAULTS; }
  function unitNow() { return settingsNow().caffeineVolumeUnit === 'mL' ? 'mL' : 'fl oz'; }
  function fmtTime(t) { return HT.dates.formatTime(t); }
  var OFFER_PREF = 'caffeineOfferHiddenOn';   // "Keep tracking" hides the offer for that local date

  // =====================================================================================
  // Add / edit form (A-010 §2 rules, §6 "Add/edit form")
  // =====================================================================================
  /**
   * opts = { mode: 'entry' | 'drink', date, isToday, existing: entry | drink | null,
   *          drinks: [My drinks] (entry mode: picker group + the 50 cap),
   *          onSaved(record), onCancel() }
   * Returns the <form>. The record id is fixed when the form opens and a second submit is
   * ignored while a save is in flight (T001-02), so a double tap can never save twice.
   */
  function buildForm(opts) {
    var K = HT.caffeineCore, D = HT.dates;
    var isEntry = opts.mode !== 'drink';
    var existing = opts.existing || null;
    var drinks = opts.drinks || [];
    var unit = unitNow();
    var fid = nextId('caf');
    var recId = existing ? existing.id : HT.db.newId();
    var saving = false;

    // ----- picker -----
    var picker = el('select', { id: fid + '-pick' });
    if (isEntry && drinks.length) {
      var g0 = el('optgroup', { label: 'My drinks' });
      drinks.forEach(function (d) { g0.appendChild(el('option', { value: 'd:' + d.id, text: d.label })); });
      picker.appendChild(g0);
    }
    K.GROUPS.forEach(function (g) {
      var og = el('optgroup', { label: g });
      K.PRESETS.forEach(function (p) { if (p.group === g) og.appendChild(el('option', { value: 'p:' + p.id, text: p.label })); });
      picker.appendChild(og);
    });
    picker.appendChild(el('option', { value: 'other', text: 'Something else' }));

    // ----- fields -----
    var nameIn = el('input', { type: 'text', id: fid + '-name', maxlength: String(K.NAME_MAX), autocomplete: 'off' });
    var amountWrap = el('div');
    var volIn = el('input', { type: 'text', inputmode: 'decimal', id: fid + '-vol', autocomplete: 'off' });
    var countIn = el('input', { type: 'text', inputmode: 'decimal', id: fid + '-count', autocomplete: 'off' });
    var perIn = el('input', { type: 'text', inputmode: 'numeric', id: fid + '-per', autocomplete: 'off' });
    var mgIn = el('input', { type: 'text', inputmode: 'numeric', id: fid + '-mg', autocomplete: 'off', 'aria-describedby': fid + '-about ' + fid + '-err' });
    var mgWrap = el('div');
    var aboutP = el('p', { class: 'field-hint', id: fid + '-about' });
    var useLink = el('button', { type: 'button', class: 'link', hidden: true });
    var srcDetails = el('details', { class: 'small' });
    var otcNote = el('p', { class: 'banner small', hidden: true, text: K.TEXT.W2 });
    var timeIn = el('input', { type: 'time', id: fid + '-time' });
    var saveChk = el('input', { type: 'checkbox', id: fid + '-keep' });
    var err = el('div', { class: 'field-error', id: fid + '-err', role: 'alert' });
    var submitBtn = el('button', { type: 'submit', class: 'primary', text: isEntry ? 'Save' : 'Save drink' });

    // ----- selection state -----
    var sel = null;          // { kind:'preset'|'drink'|'other'|'stored', p, d, amountKind:'volume'|'count'|'grams'|null, mode }
    var initial = {};        // text of the amount fields when the selection was loaded (untouched check)
    var mgTouched = false;

    function selectionFor(value) {
      if (value.slice(0, 2) === 'p:') {
        var p = K.presetById(value.slice(2));
        return { kind: 'preset', value: value, p: p, amountKind: p.kind,
          mode: p.mgRef === null ? (p.kind === 'count' ? 'labelCount' : 'labelVol') : 'preset' };
      }
      if (value.slice(0, 2) === 'd:') {
        var d = drinks.filter(function (x) { return 'd:' + x.id === value; })[0];
        return { kind: 'drink', value: value, d: d, p: null, amountKind: typeof d.count === 'number' ? 'count' : 'volume', mode: 'user' };
      }
      return { kind: 'other', value: 'other', p: null, amountKind: 'volume', mode: 'user' };
    }

    /** The picker value and selection that show a stored entry/drink (A-010 §2 "Editing"). */
    function selectionForExisting(rec) {
      var p = K.presetById(rec.presetId);
      if (p) {
        var s = selectionFor('p:' + p.id);
        // A stored amount that doesn't fit the preset kind (e.g. from another build) → user mode.
        var fits = p.kind === 'volume' ? (typeof rec.amountMl === 'number' || !hasAmount(rec)) : (typeof rec.count === 'number' || !hasAmount(rec));
        if (fits) return s;
      }
      // Unknown presetId, or no preset: edited as a user entry, keeping what is stored.
      var ak = typeof rec.amountMl === 'number' ? 'volume' : typeof rec.count === 'number' ? 'count' : typeof rec.amountG === 'number' ? 'grams' : 'volume';
      return { kind: 'stored', value: 'other', p: null, amountKind: ak, mode: 'user' };
    }
    function hasAmount(r) { return typeof r.amountMl === 'number' || typeof r.amountG === 'number' || typeof r.count === 'number'; }

    function amountLabel() {
      if (sel.amountKind === 'count') {
        var u = sel.p ? sel.p.unit : (sel.d ? unitOfDrink(sel.d) : null);
        return 'How many' + (u ? ' (' + u + ')' : '');
      }
      return 'Amount, in ' + unit + (sel.mode === 'user' ? ' (optional)' : '');
    }
    function unitOfDrink(d) { var p = K.presetById(d.presetId); return p && p.unit ? p.unit : null; }

    /** Draw the amount/mg area for the current selection and fill it from `src` values. */
    function load(src) {
      mgTouched = false;
      amountWrap.textContent = '';
      mgWrap.textContent = '';
      var p = sel.p;
      // amount
      if (sel.amountKind === 'grams') {
        amountWrap.appendChild(el('p', { class: 'small', text: 'Amount: ' + src.amountG + ' g' }));
      } else {
        var inp = sel.amountKind === 'count' ? countIn : volIn;
        amountWrap.appendChild(el('label', { for: inp.id, text: amountLabel() }));
        if (sel.amountKind === 'count') amountWrap.appendChild(el('p', { class: 'field-hint', text: 'Halves are fine, like 1 or 1.5.' }));
        amountWrap.appendChild(inp);
        if (sel.amountKind === 'count') countIn.value = typeof src.count === 'number' ? K.countText(src.count) : '';
        else volIn.value = typeof src.amountMl === 'number' ? K.volumeText(src.amountMl, unit) : '';
      }
      initial = { vol: volIn.value, count: countIn.value, per: '', ml: src.amountMl, cnt: src.count };
      // mg
      if (sel.mode === 'labelCount') {
        perIn.value = typeof src.perUnit === 'number' ? String(src.perUnit) : '';
        initial.per = perIn.value;
        mgWrap.appendChild(el('label', { for: perIn.id, text: 'Caffeine per ' + p.unit + ', in mg' }));
        mgWrap.appendChild(el('p', { class: 'field-hint', text: p.hint === 'preworkout' ? K.TEXT.W3 : K.TEXT.W12 }));
        mgWrap.appendChild(perIn);
        mgWrap.appendChild(aboutP);
      } else {
        mgIn.value = typeof src.mg === 'number' ? String(src.mg) : '';
        mgWrap.appendChild(el('label', { for: mgIn.id, text: 'Caffeine, in mg' }));
        if (sel.mode === 'labelVol') mgWrap.appendChild(el('p', { class: 'field-hint', text: K.TEXT.W12 }));
        mgWrap.appendChild(mgIn);
        mgWrap.appendChild(aboutP);
        mgWrap.appendChild(useLink);
      }
      // where the number comes from
      srcDetails.textContent = '';
      srcDetails.hidden = !p;
      if (p) {
        srcDetails.appendChild(el('summary', { text: 'Where this number comes from' }));
        srcDetails.appendChild(el('p', { text: p.source + '. Checked ' + p.checkedDate + '.' }));
        if (p.range) srcDetails.appendChild(el('p', { text: 'Range: ' + p.range + '.' }));
        srcDetails.appendChild(el('p', { text: 'Confidence: ' + p.confidence + '.' }));
      }
      otcNote.hidden = !(p && p.otc);
      refreshAbout();
    }

    /** Current amount from the fields: { ok, amount:{amountMl|count}|{}, touched } or { ok:false, error }. */
    function readAmount(required) {
      if (sel.amountKind === 'grams') return { ok: true, amount: { amountG: existing.amountG }, touched: false };
      if (sel.amountKind === 'count') {
        if (countIn.value === initial.count && typeof initial.cnt === 'number') return { ok: true, amount: { count: initial.cnt }, touched: false };
        if (!required && countIn.value.trim() === '') return { ok: true, amount: {}, touched: countIn.value !== initial.count };
        var c = K.parseCount(countIn.value);
        return c.ok ? { ok: true, amount: { count: c.count }, touched: true } : c;
      }
      // Untouched volume keeps the exact stored/reference mL (237, not 236.6 — A-010 §2).
      if (volIn.value === initial.vol && typeof initial.ml === 'number') return { ok: true, amount: { amountMl: initial.ml }, touched: false };
      if (!required && volIn.value.trim() === '') return { ok: true, amount: {}, touched: volIn.value !== initial.vol };
      var v = K.parseVolume(volIn.value, unit);
      return v.ok ? { ok: true, amount: { amountMl: v.ml }, touched: true } : v;
    }

    /** Scaled preset mg for the current amount, or null. */
    function scaledMg() {
      if (sel.mode !== 'preset') return null;
      var a = readAmount(true);
      return a.ok ? K.presetMg(sel.p, a.amount) : null;
    }
    function labelCountMg() {
      var a = readAmount(true), per = K.parseMg(perIn.value);
      return (a.ok && per.ok) ? K.countMg(per.mg, a.amount.count) : null;
    }

    function refreshAbout() {
      var p = sel.p;
      aboutP.textContent = '';
      useLink.hidden = true;
      if (sel.mode === 'preset') {
        var x = scaledMg();
        if (x === null) return;
        var parts = [K.mgText(x)];
        if (p.def === 'estimate') { parts.push(K.TEXT.W13); if (p.range) parts.push('range ' + p.range); }
        aboutP.textContent = parts.join(' · ');
        if (mgTouched && mgIn.value.trim() !== String(x)) {
          useLink.textContent = 'Use ' + K.mgText(x);
          useLink.hidden = false;
        }
      } else if (sel.mode === 'labelCount') {
        var t = labelCountMg();
        if (t !== null) aboutP.textContent = 'In total: ' + K.mgText(t);
      } else if (sel.mode === 'labelVol' && p && p.range) {
        aboutP.textContent = 'Range: ' + p.range + '.';
      }
    }

    function onAmountInput() {
      if (sel.mode === 'preset' && !mgTouched) {
        var x = scaledMg();
        if (x !== null) mgIn.value = String(x);
      }
      refreshAbout();
    }
    volIn.addEventListener('input', onAmountInput);
    countIn.addEventListener('input', onAmountInput);
    perIn.addEventListener('input', refreshAbout);
    mgIn.addEventListener('input', function () { mgTouched = true; refreshAbout(); });
    useLink.addEventListener('click', function () {
      var x = scaledMg();
      if (x === null) return;
      mgTouched = false;
      mgIn.value = String(x);
      refreshAbout();
      mgIn.focus();
    });

    function onPick() {
      sel = selectionFor(picker.value);
      var src;
      if (sel.kind === 'preset') {
        src = K.defaultAmount(sel.p);
        src.mg = K.presetMg(sel.p, src);   // null for label-only → empty mg field
        nameIn.value = sel.p.label;
      } else if (sel.kind === 'drink') {
        src = JSON.parse(JSON.stringify(sel.d));
        nameIn.value = sel.d.label;
      } else {
        src = {};
        nameIn.value = '';
      }
      load(src);
    }
    picker.addEventListener('change', onPick);

    // ----- initial state -----
    if (existing) {
      sel = selectionForExisting(existing);
      picker.value = sel.value;
      nameIn.value = existing.label;
      var src0 = JSON.parse(JSON.stringify(existing));
      if (sel.mode === 'labelCount' && typeof existing.count === 'number' && existing.count > 0) src0.perUnit = Math.round(existing.mg / existing.count);
      load(src0);
    } else {
      picker.value = isEntry && drinks.length ? 'd:' + drinks[0].id : 'p:coffee-brewed';
      onPick();
    }
    var initialValue = picker.value;
    if (isEntry) timeIn.value = existing ? existing.time : (opts.isToday ? D.nowHHMM() : '');

    // ----- save -----
    function fail(msg, focusEl) { err.textContent = msg; if (focusEl) focusEl.focus(); }

    var form = el('form', { class: 'meal-form caf-form', novalidate: true, 'aria-label': isEntry ? (existing ? 'Edit caffeine' : 'Add caffeine') : (existing ? 'Edit saved drink' : 'Add saved drink') });
    // O-2 (T-006): Escape closes the form like Cancel (focus goes back to the opener).
    form.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Escape' || ev.key === 'Esc') && !saving && typeof opts.onCancel === 'function') {
        ev.preventDefault();
        opts.onCancel();
      }
    });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (saving) return;
      err.textContent = '';
      var t = isEntry ? (timeIn.value || '').slice(0, 5) : null;
      if (isEntry && !D.isValidTime(t)) return fail(K.MSG.time, timeIn);
      var nm = K.parseName(nameIn.value);
      if (!nm.ok) return fail(nm.error, nameIn);
      var amountRequired = sel.mode !== 'user';
      var a = readAmount(amountRequired);
      if (!a.ok) return fail(a.error, sel.amountKind === 'count' ? countIn : volIn);
      var unchangedSel = !!existing && picker.value === initialValue;
      var mg, source, checkedDate;
      if (sel.mode === 'labelCount') {
        var per = K.parseMg(perIn.value);
        if (!per.ok) return fail(per.empty ? K.TEXT.W12 : per.error, perIn);
        mg = (unchangedSel && !a.touched && perIn.value === initial.per) ? existing.mg : K.countMg(per.mg, a.amount.count);
        if (mg > K.MG_MAX) return fail(K.MSG.mgMax, perIn);
      } else {
        var m = K.parseMg(mgIn.value);
        if (!m.ok) return fail(m.empty && sel.mode === 'labelVol' ? K.TEXT.W12 : m.error, mgIn);
        mg = m.mg;
      }
      // Source (A-010 §2, RC-6 snapshot): an untouched stored entry keeps its source and
      // checkedDate; an untyped preset value is 'preset:<id>' with the preset's checkedDate;
      // anything the user typed is 'user'.
      if (unchangedSel && !a.touched && !mgTouched && (sel.mode !== 'labelCount' || perIn.value === initial.per)) {
        source = existing.source; checkedDate = existing.checkedDate === undefined ? null : existing.checkedDate;
      } else if (sel.mode === 'preset' && !mgTouched) {
        source = 'preset:' + sel.p.id; checkedDate = sel.p.checkedDate;
      } else { source = 'user'; checkedDate = null; }
      var presetId = sel.p ? sel.p.id : sel.d ? (sel.d.presetId || null) : (sel.kind === 'stored' ? (existing.presetId || null) : null);

      var rec = existing ? JSON.parse(JSON.stringify(existing)) : { id: recId };
      ['amountMl', 'amountG', 'count'].forEach(function (k) { delete rec[k]; });
      Object.keys(a.amount).forEach(function (k) { rec[k] = a.amount[k]; });
      rec.label = nm.name; rec.presetId = presetId; rec.mg = mg;
      if (isEntry) {
        rec.date = existing ? existing.date : opts.date;
        rec.time = t; rec.source = source; rec.checkedDate = checkedDate;
      } else {
        delete rec.amountG;   // never on a drink (§1.4)
        delete rec.source; delete rec.checkedDate; delete rec.date; delete rec.time;
      }
      var keep = isEntry && saveChk.checked && !saveChk.disabled;
      saving = true;
      submitBtn.disabled = true;
      status('Saving…');
      var save = isEntry ? HT.db.saveCaffeineEntry(rec) : HT.db.saveCaffeineDrink(rec);
      save.then(function (saved) {
        if (!keep) return saved;
        return HT.db.saveCaffeineDrink(HT.caffeineCore.drinkFromEntry(saved, HT.db.newId())).then(function () { return saved; });
      }).then(function (saved) {
        status('Saved', 'ok');
        if (typeof opts.onSaved === 'function') opts.onSaved(saved);
      }, function (e) {
        saving = false;
        submitBtn.disabled = false;
        saveError(e);
      });
    });

    form.appendChild(el('label', { for: picker.id, text: 'Drink' }));
    form.appendChild(picker);
    form.appendChild(el('label', { for: nameIn.id, text: 'Name' }));
    form.appendChild(nameIn);
    form.appendChild(amountWrap);
    form.appendChild(mgWrap);
    form.appendChild(srcDetails);
    form.appendChild(otcNote);
    if (isEntry) {
      form.appendChild(el('label', { for: timeIn.id, text: 'Time' }));
      form.appendChild(timeIn);
      var full = drinks.length >= K.DRINKS_MAX;
      if (full) saveChk.disabled = true;
      form.appendChild(el('div', { class: 'check' }, [saveChk, el('label', { for: saveChk.id, text: 'Save to My drinks' })]));
      if (full) form.appendChild(el('p', { class: 'field-hint', text: 'You have ' + K.DRINKS_MAX + ' saved drinks. Delete one in Settings to save another.' }));
    }
    form.appendChild(err);
    form.appendChild(el('details', { class: 'small' }, [el('summary', { text: 'About these amounts' }), el('p', { text: K.TEXT.W1 })]));
    form.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [
      submitBtn,
      el('button', { type: 'button', text: 'Cancel', onclick: function () { if (typeof opts.onCancel === 'function') opts.onCancel(); } })
    ]));
    form._fields = { picker: picker, name: nameIn, vol: volIn, count: countIn, per: perIn, mg: mgIn, time: timeIn, keep: saveChk, err: err, submit: submitBtn, about: aboutP, use: useLink };
    return form;
  }

  // =====================================================================================
  // Focus helpers (T006-01: after an action disables or redraws the focused control, focus
  // goes back to the equivalent control, found by its data-fk key after the redraw).
  // =====================================================================================
  function usable(t) {
    return !!t && t.isConnected && !t.disabled && !t.hidden && !(t.closest && t.closest('[hidden]'));
  }
  /** Focus [data-fk=key] inside root, else the fallback element; does nothing when neither is usable. */
  function focusKey(root, key, fallback) {
    var t = key ? root.querySelector('[data-fk="' + key + '"]') : null;
    if (!usable(t)) t = fallback || null;
    if (usable(t)) { try { t.focus(); } catch (e) { /* ignore */ } }
  }
  function onEscape(node, fn) {
    node.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); fn(); }
    });
  }

  // =====================================================================================
  // Baseline status (A-010 §3), shared by Today and Settings
  // =====================================================================================
  /** Resolves { plan, sum } where sum = baselineSummary (or null when not in the baseline). */
  function loadBaseline(today) {
    var K = HT.caffeineCore;
    return HT.db.getCaffeinePlan().then(function (plan) {
      if (!plan || plan.status !== 'baseline') return { plan: plan || null, sum: null };
      var start = plan.baselineStartDate;
      if (!(start < today)) return { plan: plan, sum: K.baselineSummary(start, today, [], []) };
      return HT.db.getCaffeineRange(start, HT.dates.addDays(today, -1)).then(function (rg) {
        return { plan: plan, sum: K.baselineSummary(start, today, rg.entries, rg.days) };
      });
    });
  }
  /**
   * Draw the baseline state into box. where = 'today' | 'settings'. In Settings "Start my plan
   * now" is always offered once n ≥ 3 and "Keep tracking" is not shown (§3).
   * hooks = { redraw(focusKey), openStart() }.
   */
  function drawBaseline(box, sum, where, today, hooks) {
    var K = HT.caffeineCore;
    box.textContent = '';
    var hidden = where === 'today' && prefGet(OFFER_PREF) === today;
    var v = K.baselineView(sum, { offerHidden: hidden });
    var buttons = v.buttons;
    if (where === 'settings') buttons = buttons.filter(function (b) { return b !== 'keep'; });
    // tabindex -1: focus lands here after "Keep tracking" (T006-01).
    box.appendChild(el('p', { class: 'caf-status', tabindex: '-1', 'data-fk': 'status', text: v.text }));
    if (!buttons.length) return;
    var row = el('div', { class: 'row' });
    buttons.forEach(function (b) {
      var btn = el('button', { type: 'button', class: b === 'keep' ? '' : 'primary', 'data-fk': b === 'keep' ? 'keep' : 'start', text: K.BASE_TEXT[b] });
      btn.addEventListener('click', function () {
        if (b === 'keep') { prefSet(OFFER_PREF, today); if (hooks && hooks.redraw) hooks.redraw('status'); return; }
        if (hooks && hooks.openStart) hooks.openStart();
      });
      row.appendChild(btn);
    });
    box.appendChild(row);
  }

  // =====================================================================================
  // Plan start form (A-010 §4 "Plan start form"), shared by Today and Settings
  // =====================================================================================
  /**
   * opts = { plan, sum (baselineSummary, n ≥ 3, avg > 0), onSaved(plan), onCancel() }.
   * Shows the baseline, W11, W5 and W4; the goal field is EMPTY with no placeholder (the app never
   * suggests a goal); weekly step 10/15/20/25 % (default 25); preview of the first week's target.
   */
  function buildStartForm(opts) {
    var K = HT.caffeineCore, D = HT.dates, sum = opts.sum;
    var fid = nextId('caf-start');
    var saving = false;
    var goalIn = el('input', { type: 'text', inputmode: 'numeric', id: fid + '-goal', autocomplete: 'off', 'aria-describedby': fid + '-hint ' + fid + '-err ' + fid + '-prev' });
    var err = el('div', { class: 'field-error', id: fid + '-err', role: 'alert' });
    var prev = el('p', { class: 'caf-preview', id: fid + '-prev', 'aria-live': 'polite' });
    var pctName = nextId('caf-pct');
    var pctFs = el('fieldset', null, [el('legend', { text: 'Weekly step' })]);
    var seg = el('div', { class: 'seg' });
    K.PCTS.forEach(function (p) {
      var r = el('input', { type: 'radio', name: pctName, value: String(p), checked: p === K.PCT_DEFAULT });
      r.addEventListener('change', refresh);
      seg.appendChild(el('label', { class: 'choice' }, [r, el('span', { text: p + '%' })]));
    });
    pctFs.appendChild(seg);
    var submitBtn = el('button', { type: 'submit', class: 'primary', text: 'Start my plan' });
    function pct() {
      var c = seg.querySelector('input:checked');
      return c ? Number(c.value) : K.PCT_DEFAULT;
    }
    function refresh() {
      var g = K.parseGoal(goalIn.value, sum.avg);
      if (!g.ok) { prev.textContent = ''; return; }
      var first = K.nextTarget(sum.avg, g.goal, pct());
      prev.textContent = 'First week\'s target: ' + K.fmtInt(first) + ' mg a day' + (first === g.goal ? ' (your goal)' : '');
    }
    goalIn.addEventListener('input', refresh);

    var form = el('form', { class: 'caf-form caf-start', novalidate: true, 'aria-label': 'Start a caffeine plan' });
    function cancel() { if (!saving && typeof opts.onCancel === 'function') opts.onCancel(); }
    onEscape(form, cancel);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (saving) return;
      err.textContent = '';
      var res = K.startPlan(opts.plan, sum, goalIn.value, pct(), D.todayLocal());
      if (!res.ok) { err.textContent = res.error; goalIn.focus(); return; }
      saving = true;
      submitBtn.disabled = true;
      status('Saving…');
      HT.db.saveCaffeinePlan(res.plan).then(function (saved) {
        status('Saved', 'ok');
        if (typeof opts.onSaved === 'function') opts.onSaved(saved);
      }, function (e) {
        saving = false;
        submitBtn.disabled = false;
        saveError(e);
        submitBtn.focus();
      });
    });
    form.appendChild(el('p', { class: 'caf-status', text: 'Your usual amount: about ' + K.fmtInt(sum.avg) + ' mg a day (from ' + sum.n + ' days).' }));
    form.appendChild(el('p', { class: 'small', text: K.TEXT.W11 }));
    form.appendChild(el('p', { class: 'small', text: K.TEXT.W5 }));
    form.appendChild(el('p', { class: 'banner small', text: K.TEXT.W4 }));
    form.appendChild(el('label', { for: goalIn.id, text: 'Your daily goal, in mg' }));
    form.appendChild(el('p', { class: 'field-hint', id: fid + '-hint', text: 'Any whole number lower than your usual amount, including 0.' }));
    form.appendChild(goalIn);
    form.appendChild(pctFs);
    form.appendChild(prev);
    form.appendChild(err);
    form.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [
      submitBtn,
      el('button', { type: 'button', text: 'Cancel', onclick: cancel })
    ]));
    form._fields = { goal: goalIn, pct: seg, preview: prev, err: err, submit: submitBtn };
    return form;
  }

  /** Resolves { plan, sum, marks } for the day section. marks = day records in [targetSince, today] when a step is due. */
  function loadPlanState(today, full) {
    var K = HT.caffeineCore;
    if (!full) return HT.db.getCaffeinePlan().then(function (plan) { return { plan: plan || null, sum: null, marks: [] }; });
    return loadBaseline(today).then(function (b) {
      var out = { plan: b.plan, sum: b.sum, marks: [] };
      if (!K.stepDue(b.plan, today)) return out;
      return HT.db.getCaffeineRange(b.plan.targetSince, today).then(function (rg) { out.marks = rg.days; return out; });
    });
  }

  // =====================================================================================
  // Day section (A-010 §6 "Day section")
  // =====================================================================================
  /** params = { date, today }. Returns a cleanup function. */
  function mountDay(sec, params) {
    var K = HT.caffeineCore, D = HT.dates;
    var date = params.date, today = params.today || D.todayLocal();
    var isToday = date === today;
    var alive = true;
    var st = { entries: [], day: null, drinks: [], plan: null, sum: null, marks: [], startForm: null };
    var pending = null;   // data-fk key to focus after the next draw (T006-01)
    var hid = nextId('caf-h');

    var statusBox = el('div', { class: 'caf-baseline' });
    var totalP = el('p', { class: 'caf-total' });
    var offerBox = el('div', { class: 'caf-offer' });
    var quickBox = el('div');
    var live = el('div', { class: 'caf-live', role: 'status', 'aria-live': 'polite' });
    var list = el('ul', { class: 'meal-list caf-list' });
    var formSlot = el('div');
    var addBtn = el('button', { type: 'button', class: 'primary', 'data-fk': 'add', text: '+ Add caffeine' });
    var noneBtn = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-fk': 'none', text: isToday ? 'No caffeine today' : 'No caffeine this day' });
    var noneWrap = el('div', { class: 'chips', style: 'margin-top:10px' }, [noneBtn]);
    var marksBox = el('div', { class: 'caf-marks' });

    sec.setAttribute('aria-labelledby', hid);
    sec.appendChild(el('h2', { id: hid, text: 'Caffeine' }));
    if (isToday) sec.appendChild(statusBox);
    sec.appendChild(totalP);
    if (isToday) sec.appendChild(offerBox);
    if (isToday) sec.appendChild(quickBox);
    sec.appendChild(live);
    sec.appendChild(list);
    sec.appendChild(formSlot);
    sec.appendChild(addBtn);
    sec.appendChild(noneWrap);
    sec.appendChild(marksBox);

    function load() {
      return Promise.all([
        HT.db.getCaffeineForDate(date),
        HT.db.getCaffeineDay(date),
        isToday ? HT.db.getCaffeineDrinks() : Promise.resolve([]),
        loadPlanState(today, isToday)
      ]).then(function (r) {
        if (!alive) return;
        st.entries = r[0]; st.day = r[1] || null; st.drinks = r[2];
        st.plan = r[3].plan; st.sum = r[3].sum; st.marks = r[3].marks;
        if (st.startForm && !(st.plan && st.plan.status === 'baseline')) st.startForm = null;
        draw();
      }, function () {
        if (!alive) return;
        totalP.textContent = 'Could not load caffeine for this day. Try reloading.';
      });
    }
    function redraw(key) { pending = key || null; draw(); }

    function drawStatus() {
      statusBox.textContent = '';
      if (!isToday) return;
      if (st.startForm) { statusBox.appendChild(st.startForm); return; }
      if (st.plan && st.plan.status === 'baseline' && st.sum) {
        drawBaseline(statusBox, st.sum, 'today', today, { redraw: redraw, openStart: openStart });
        return;
      }
      K.planStatusLines(st.plan).forEach(function (t, i) {
        statusBox.appendChild(i === 0 ? el('p', { class: 'caf-status', tabindex: '-1', 'data-fk': 'status', text: t }) : el('p', { class: 'small', text: t }));
      });
    }
    function openStart() {
      st.startForm = buildStartForm({ plan: st.plan, sum: st.sum,
        onSaved: function () { st.startForm = null; pending = 'status'; load(); },
        onCancel: function () { st.startForm = null; redraw('start'); } });
      draw();
      st.startForm._fields.goal.focus();
    }

    // Step-day offer (A-010 §4; §10 ordering). Today only, while due; never acts by itself.
    function drawOffer() {
      offerBox.textContent = '';
      var o = isToday && !st.startForm ? K.stepOffer(st.plan, st.marks, today) : null;
      if (!o) return;
      var oh = nextId('caf-o');
      offerBox.appendChild(el('p', { class: 'caf-status', id: oh, text: 'Step day: your target has been ' + K.fmtInt(st.plan.currentTargetMg) + ' mg a day for a week. What would you like to do?' }));
      var row = el('div', { class: 'caf-offer-btns', role: 'group', 'aria-labelledby': oh });
      o.order.forEach(function (k) {
        var text = k === 'next' ? K.nextLabel(o) : k === 'stay' ? K.OFFER_TEXT.stay : K.OFFER_TEXT.back + ': ' + K.fmtInt(o.backMg) + ' mg a day';
        var b = el('button', { type: 'button', class: k === o.order[0] ? 'primary' : '', 'data-fk': 'offer-' + k, text: text });
        b.addEventListener('click', function () { offerAct(k, row, b); });
        row.appendChild(b);
      });
      offerBox.appendChild(row);
      if (o.hold) offerBox.appendChild(el('p', { class: 'banner small', text: K.TEXT.W6 }));
    }
    function offerAct(k, row, btn) {
      if (row.getAttribute('data-busy') === '1') return;
      var fn = k === 'next' ? K.applyNext : k === 'stay' ? K.applyStay : K.applyBack;
      var r = fn(st.plan, D.todayLocal());
      if (!r.ok) return;
      row.setAttribute('data-busy', '1');
      var btns = row.querySelectorAll('button');
      Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
      status('Saving…');
      HT.db.saveCaffeinePlan(r.plan).then(function () {
        status('Saved', 'ok');
        pending = 'status';
        return load();
      }, function (e) {
        saveError(e);
        row.removeAttribute('data-busy');
        Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
        btn.focus();
      });
    }

    // Withdrawal marks (A-010 §10): only while the plan is active, on dates from its start.
    function drawMarks() {
      marksBox.textContent = '';
      if (!K.marksShown(st.plan, date)) return;
      var mh = nextId('caf-mk');
      marksBox.appendChild(el('p', { class: 'small', id: mh, style: 'margin:12px 0 6px', text: isToday ? 'Did you notice any of these today? (optional)' : 'Did you notice any of these on this day? (optional)' }));
      var chips = el('div', { class: 'chips', role: 'group', 'aria-labelledby': mh });
      [['headache', 'Headache'], ['tired', 'Tiredness']].forEach(function (m) {
        var on = !!(st.day && st.day[m[0]] === true);
        var b = el('button', { type: 'button', class: 'chip', 'aria-pressed': on ? 'true' : 'false', 'data-fk': 'mark-' + m[0], text: m[1] });
        b.addEventListener('click', function () { toggleMark(m[0], b); });
        chips.appendChild(b);
      });
      marksBox.appendChild(chips);
    }
    function toggleMark(key, b) {
      if (b.disabled) return;
      var on = b.getAttribute('aria-pressed') !== 'true';
      var patch = {};
      patch[key] = on;
      b.disabled = true;
      status('Saving…');
      HT.db.setCaffeineDay(date, patch).then(function () {
        status('Saved', 'ok');
        pending = 'mark-' + key;
        return load();
      }, function (e) { b.disabled = false; saveError(e); b.focus(); });
    }

    function draw() {
      var unit = unitNow(), s = settingsNow();
      // 1. status line (today only)
      drawStatus();
      // 2. total
      var tot = K.dayTotal(st.entries, st.day);
      if (tot.count) totalP.textContent = 'About ' + K.fmtInt(tot.mg) + ' mg ' + (isToday ? 'today' : 'on this day');
      else if (tot.none) totalP.textContent = isToday ? 'No caffeine marked for today.' : 'No caffeine marked for this day.';
      else totalP.textContent = isToday ? 'No caffeine logged yet.' : 'No caffeine logged on this day.';
      // 3. step-day offer (today only)
      drawOffer();
      // 4. quick add (today only)
      quickBox.textContent = '';
      if (isToday && st.drinks.length) {
        var qh = nextId('caf-q');
        quickBox.appendChild(el('p', { class: 'small muted', id: qh, text: 'Quick add from My drinks:' }));
        var wrap = el('div', { class: 'caf-quick', role: 'group', 'aria-labelledby': qh });
        st.drinks.slice(0, K.QUICK_MAX).forEach(function (d, i) {
          var b = el('button', { type: 'button', class: 'caf-quick-btn', 'data-fk': 'quick-' + i, text: K.describe(d, unit) });
          b.addEventListener('click', function () { quickAdd(d, wrap, b); });
          wrap.appendChild(b);
        });
        quickBox.appendChild(wrap);
      }
      // 5. entries, with W8 under each flagged entry (A-010 §5: bedtime set and mg > 0)
      var hours = typeof s.caffeineCutoffHours === 'number' ? s.caffeineCutoffHours : 8;
      list.textContent = '';
      st.entries.forEach(function (e) {
        var li = el('li', null, [
          el('div', { class: 'meal-main' }, [el('strong', { text: fmtTime(e.time) }), ' ', el('span', { text: K.describe(e, unit) })]),
          el('div', { class: 'row' }, [
            el('button', { type: 'button', text: 'Edit', 'aria-label': 'Edit ' + e.label + ' at ' + fmtTime(e.time), onclick: function () { openForm(e); } }),
            el('button', { type: 'button', class: 'danger', text: 'Delete', 'aria-label': 'Delete ' + e.label + ' at ' + fmtTime(e.time), onclick: function () { removeEntry(e); } })
          ])
        ]);
        if (K.isLateEntry(e, s)) li.appendChild(el('p', { class: 'small caf-late', text: K.w8(hours) }));
        list.appendChild(li);
      });
      list.hidden = !st.entries.length;
      // 7. "No caffeine today" toggle, only when there are no entries
      noneWrap.hidden = st.entries.length > 0;
      noneBtn.setAttribute('aria-pressed', tot.none ? 'true' : 'false');
      // 8. withdrawal chips
      drawMarks();
      // T006-01: put focus back where the action happened.
      if (pending) { var k = pending; pending = null; focusKey(sec, k, addBtn); }
    }

    // T001-02 pattern: every quick button is disabled while one save is in flight.
    function quickAdd(d, wrap, btn) {
      var btns = wrap.querySelectorAll('button');
      if (wrap.getAttribute('data-busy') === '1') return;
      wrap.setAttribute('data-busy', '1');
      Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
      var id = HT.db.newId();
      status('Saving…');
      HT.db.saveCaffeineEntry(K.entryFromDrink(d, date, D.nowHHMM(), id)).then(function () {
        status('Saved', 'ok');
        showAdded(d.label, id);
        pending = 'undo';
        return load();
      }, function (e) {
        saveError(e);
        wrap.removeAttribute('data-busy');
        Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
        btn.focus();
      });
    }
    function showAdded(label, id) {
      live.textContent = '';
      var undo = el('button', { type: 'button', class: 'link', 'data-fk': 'undo', text: 'Undo' });
      undo.addEventListener('click', function () {
        if (undo.disabled) return;
        undo.disabled = true;
        HT.db.deleteCaffeineEntry(id).then(function () {
          live.textContent = 'Removed ' + label + '.';
          status('Deleted', 'ok');
          pending = 'add';
          return load();
        }, function (e) { undo.disabled = false; saveError(e); undo.focus(); });
      });
      live.appendChild(el('p', { class: 'small', style: 'margin:4px 0' }, ['Added ' + label + '. ', undo]));
    }

    function removeEntry(e) {
      if (!window.confirm('Delete ' + e.label + ' at ' + fmtTime(e.time) + '?')) return;
      status('Saving…');
      HT.db.deleteCaffeineEntry(e.id).then(function () { status('Deleted', 'ok'); live.textContent = ''; pending = 'add'; return load(); }, saveError);
    }

    function openForm(existing) {
      formSlot.textContent = '';
      addBtn.hidden = true;
      live.textContent = '';
      var f = buildForm({ mode: 'entry', date: date, isToday: isToday, existing: existing || null, drinks: st.drinks,
        onSaved: function () { if (!alive) return; closeForm(); load(); },
        onCancel: closeForm });
      formSlot.appendChild(f);
      f._fields.picker.focus();
    }
    function closeForm() {
      formSlot.textContent = '';
      addBtn.hidden = false;
      addBtn.focus();
    }
    addBtn.addEventListener('click', function () {
      // The picker lists My drinks on past days too.
      if (isToday) { openForm(null); return; }
      HT.db.getCaffeineDrinks().then(function (d) { st.drinks = d; if (alive) openForm(null); }, function () { openForm(null); });
    });

    noneBtn.addEventListener('click', function () {
      if (noneBtn.disabled) return;
      var on = noneBtn.getAttribute('aria-pressed') !== 'true';
      noneBtn.disabled = true;
      status('Saving…');
      HT.db.setCaffeineDay(date, { none: on }).then(function () {
        status('Saved', 'ok');
        noneBtn.disabled = false;
        pending = 'none';
        return load();
      }, function (e) { noneBtn.disabled = false; saveError(e); noneBtn.focus(); });
    });

    load();
    return function cleanupCaffeineDay() { alive = false; };
  }

  // =====================================================================================
  // Settings card (A-010 §6 "Settings 'Caffeine' card")
  // =====================================================================================
  var END_Q = 'End your caffeine plan? Your target will no longer be shown. Your caffeine entries and the plan history are kept.';
  var AGAIN_Q = 'Start again? This replaces your current plan and starts tracking your usual amount again from today. Your caffeine entries and the plan history are kept.';
  var FINISH_Q = 'Your target is already at or below this goal. Finish the plan with this goal?';
  var BED_HINT_TAIL = ' Used only for the late-caffeine note and the late caffeine and sleep comparison.';

  /** Returns { cleanup(), refresh() }. refresh() re-reads settings, the plan and drinks (after a restore). */
  function renderSettingsCard(card) {
    var K = HT.caffeineCore, D = HT.dates;
    var alive = true;
    var hid = nextId('caf-set');
    card.setAttribute('aria-labelledby', hid);
    card.appendChild(el('h2', { id: hid, style: 'margin-top:0', text: 'Caffeine' }));

    function saveSetting(patch, after) {
      status('Saving…');
      return HT.db.patchSettings(patch).then(function (saved) {
        if (HT.state) HT.state.settings = JSON.parse(JSON.stringify(saved));
        status('Saved', 'ok');
        if (after) after(saved);
      }, saveError);
    }

    // ----- usual bedtime (with Clear; hint W9) and the late-caffeine cut-off (4–12 h) -----
    var bedId = nextId('caf-bed');
    var bedIn = el('input', { type: 'time', id: bedId, 'aria-describedby': bedId + '-hint' });
    bedIn.value = settingsNow().caffeineBedtime || '';
    var bedClear = el('button', { type: 'button', 'aria-label': 'Clear usual bedtime', text: 'Clear' });
    bedIn.addEventListener('change', function () {
      var v = (bedIn.value || '').slice(0, 5);
      if (v === '') { saveSetting({ caffeineBedtime: null }); return; }
      if (D.isValidTime(v)) saveSetting({ caffeineBedtime: v });
    });
    bedClear.addEventListener('click', function () {
      bedIn.value = '';
      saveSetting({ caffeineBedtime: null });   // focus stays on Clear (never disabled)
    });
    card.appendChild(el('label', { for: bedId, text: 'Usual bedtime' }));
    card.appendChild(el('p', { class: 'field-hint', id: bedId + '-hint', text: K.TEXT.W9 + BED_HINT_TAIL }));
    card.appendChild(el('div', { class: 'row' }, [bedIn, bedClear]));

    var cutId = nextId('caf-cut');
    var cutSel = el('select', { id: cutId });
    for (var h = 4; h <= 12; h++) cutSel.appendChild(el('option', { value: String(h), text: h + ' hours before bedtime' }));
    cutSel.value = String(settingsNow().caffeineCutoffHours || 8);
    cutSel.addEventListener('change', function () {
      var n = Number(cutSel.value);
      if (n >= 4 && n <= 12) saveSetting({ caffeineCutoffHours: n });
    });
    card.appendChild(el('label', { for: cutId, text: 'Late-caffeine note' }));
    card.appendChild(cutSel);

    // ----- volume unit (D9: fl oz default) -----
    var unitName = nextId('caf-unit');
    var unitFs = el('fieldset', null, [el('legend', { text: 'Show drink amounts in' })]);
    var seg = el('div', { class: 'seg' });
    HT.db.CAFFEINE_UNITS.forEach(function (u) {
      var r = el('input', { type: 'radio', name: unitName, value: u, checked: unitNow() === u });
      r.addEventListener('change', function () {
        if (!r.checked) return;
        saveSetting({ caffeineVolumeUnit: u }, function () { drawDrinks(); });
      });
      seg.appendChild(el('label', { class: 'choice' }, [r, el('span', { text: u })]));
    });
    unitFs.appendChild(seg);
    card.appendChild(unitFs);

    // ----- My drinks -----
    var drinksH = nextId('caf-dr');
    var drinkList = el('ul', { class: 'meal-list caf-list' });
    var drinkForm = el('div');
    var addDrinkBtn = el('button', { type: 'button', text: '+ Add a drink' });
    var drinkNote = el('p', { class: 'field-hint' });
    var drinks = [];
    card.appendChild(el('h3', { id: drinksH, text: 'My drinks' }));
    card.appendChild(el('p', { class: 'field-hint', text: 'Saved drinks appear as quick-add buttons on Today (the first 6).' }));
    card.appendChild(drinkList);
    card.appendChild(drinkForm);
    card.appendChild(addDrinkBtn);
    card.appendChild(drinkNote);

    function drawDrinks() {
      return HT.db.getCaffeineDrinks().then(function (list) {
        if (!alive) return;
        drinks = list;
        var unit = unitNow();
        drinkList.textContent = '';
        if (!list.length) drinkList.appendChild(el('li', { class: 'muted', text: 'No saved drinks yet.' }));
        list.forEach(function (d) {
          drinkList.appendChild(el('li', null, [
            el('div', { class: 'meal-main', text: K.describe(d, unit) }),
            el('div', { class: 'row' }, [
              el('button', { type: 'button', text: 'Edit', 'aria-label': 'Edit saved drink ' + d.label, onclick: function () { openDrinkForm(d); } }),
              el('button', { type: 'button', class: 'danger', text: 'Delete', 'aria-label': 'Delete saved drink ' + d.label, onclick: function () {
                if (!window.confirm('Delete ' + d.label + ' from My drinks? Caffeine you already logged with it is kept.')) return;
                status('Saving…');
                HT.db.deleteCaffeineDrink(d.id).then(function () {
                  status('Deleted', 'ok');
                  // T006-01: the list is rebuilt, so focus goes to "+ Add a drink" (or the heading when full).
                  return drawDrinks().then(function () { focusKey(card, null, usable(addDrinkBtn) ? addDrinkBtn : drinkHeading); });
                }, saveError);
              } })
            ])
          ]));
        });
        var full = list.length >= K.DRINKS_MAX;
        addDrinkBtn.hidden = full || !!drinkForm.firstChild;
        drinkNote.textContent = full ? 'You have ' + K.DRINKS_MAX + ' saved drinks. Delete one to add another.' : '';
      });
    }
    var drinkHeading = card.querySelector('#' + drinksH);
    drinkHeading.setAttribute('tabindex', '-1');
    function openDrinkForm(existing) {
      drinkForm.textContent = '';
      addDrinkBtn.hidden = true;
      var f = buildForm({ mode: 'drink', existing: existing || null,
        onSaved: function () { closeDrinkForm(); drawDrinks(); },
        onCancel: closeDrinkForm });
      drinkForm.appendChild(f);
      f._fields.picker.focus();
    }
    function closeDrinkForm() {
      drinkForm.textContent = '';
      addDrinkBtn.hidden = drinks.length >= K.DRINKS_MAX;
      focusKey(card, null, usable(addDrinkBtn) ? addDrinkBtn : drinkHeading);
    }
    addDrinkBtn.addEventListener('click', function () { openDrinkForm(null); });

    // ----- usual amount and plan (A-010 §3, §4, §6) -----
    var planBox = el('div', { class: 'caf-plan' });
    var planPending = null;
    var startForm = null;
    card.appendChild(el('h3', { text: 'Usual amount and plan' }));
    card.appendChild(planBox);

    function planRedraw(key) { planPending = key || null; return drawPlan(); }
    function drawPlan() {
      var today = D.todayLocal();
      return loadBaseline(today).then(function (b) {
        if (!alive) return;
        planBox.textContent = '';
        var plan = b.plan;
        if (!plan || plan.status !== 'baseline') startForm = null;
        if (!plan) {
          planBox.appendChild(el('p', { class: 'small', text: 'Log your caffeine as usual, without changing anything, and the app works out your usual daily amount. You can start a plan after 3 days; 7 days is recommended.' }));
          planBox.appendChild(el('button', { type: 'button', class: 'primary', 'data-fk': 'track', text: 'Track my usual amount', onclick: function (ev) {
            ev.currentTarget.disabled = true;
            status('Saving…');
            HT.db.saveCaffeinePlan(K.newBaselinePlan(D.todayLocal())).then(function () { status('Saved', 'ok'); planRedraw('status'); }, function (e) { saveError(e); planRedraw('track'); });
          } }));
        } else if (plan.status === 'baseline') {
          if (startForm) {
            planBox.appendChild(startForm);
          } else {
            var box = el('div');
            planBox.appendChild(box);
            drawBaseline(box, b.sum, 'settings', today, { redraw: planRedraw, openStart: function () { openStart(plan, b.sum); } });
            planBox.appendChild(el('p', { class: 'small muted', text: 'Tracking since ' + D.formatLong(plan.baselineStartDate) + '.' }));
            planBox.appendChild(el('button', { type: 'button', 'data-fk': 'restart', text: 'Start the baseline again', onclick: function () {
              if (!window.confirm('Start tracking your usual amount again from today? Days logged so far will no longer count toward it. Your caffeine entries are kept.')) return;
              savePlan(K.restartBaseline(plan, D.todayLocal()), 'status');
            } }));
          }
        } else {
          drawStarted(plan, today);
        }
        if (planPending) { var k = planPending; planPending = null; focusKey(planBox, k, planBox.querySelector('[data-fk="status"]')); }
      }, function () {
        if (alive) { planBox.textContent = ''; planBox.appendChild(el('p', { class: 'small', text: 'Could not load the caffeine plan. Try reloading.' })); }
      });
    }
    function openStart(plan, sum) {
      startForm = buildStartForm({ plan: plan, sum: sum,
        onSaved: function () { startForm = null; planRedraw('status'); },
        onCancel: function () { startForm = null; planRedraw('start'); } });
      planRedraw(null).then(function () { if (startForm) startForm._fields.goal.focus(); });
    }
    /** Save a plan record, then redraw and focus `key` (T006-01). Buttons in planBox are disabled meanwhile. */
    function savePlan(p, key) {
      Array.prototype.forEach.call(planBox.querySelectorAll('button'), function (b) { b.disabled = true; });
      status('Saving…');
      return HT.db.saveCaffeinePlan(p).then(function () { status('Saved', 'ok'); return planRedraw(key); },
        function (e) { saveError(e); return planRedraw('status'); });
    }

    /** Active, done or ended plan: status, numbers, actions, W4/W5 and the history table. */
    function drawStarted(plan, today) {
      var active = plan.status === 'active', done = plan.status === 'done';
      var head;
      if (active) head = 'Plan in progress. This week\'s target: ' + K.fmtInt(plan.currentTargetMg) + ' mg a day, since ' + D.formatLong(plan.targetSince) + '.';
      else if (done) head = K.w7(plan.goalMg);
      else head = 'This plan ended on ' + D.formatLong(plan.endDate) + '.';
      planBox.appendChild(el('p', { class: 'caf-status', tabindex: '-1', 'data-fk': 'status', text: head }));
      var nDays = Array.isArray(plan.baselineDays) ? plan.baselineDays.length : 0;
      if (typeof plan.baselineMg === 'number') planBox.appendChild(el('p', { class: 'small', text: 'Your usual amount: about ' + K.fmtInt(plan.baselineMg) + ' mg a day' + (nDays ? ' (from ' + nDays + ' days).' : '.') }));
      if (typeof plan.goalMg === 'number') planBox.appendChild(el('p', { class: 'small', text: 'Your goal: ' + K.fmtInt(plan.goalMg) + ' mg a day.' }));
      if (active || done) planBox.appendChild(el('p', { class: 'small', text: 'Weekly step: ' + plan.pct + '%.' }));
      var due = K.stepDue(plan, today);
      if (active && !due) planBox.appendChild(el('p', { class: 'small muted', text: 'The next step is offered from ' + D.formatLong(K.addDays(plan.targetSince, K.STEP_DAYS)) + '.' }));

      var editSlot = el('div');
      var row = el('div', { class: 'row caf-plan-actions' });
      function btn(key, text, fn, cls) {
        row.appendChild(el('button', { type: 'button', class: cls || '', 'data-fk': key, text: text, onclick: fn }));
      }
      if (active) {
        if (due) {
          var o = K.stepOffer(plan, [], today);
          btn('next', K.nextLabel(o), function () { var r = K.applyNext(plan, D.todayLocal()); if (r.ok) savePlan(r.plan, 'status'); }, 'primary');
        }
        btn('stay', K.OFFER_TEXT.stay, function () { var r = K.applyStay(plan, D.todayLocal()); if (r.ok) savePlan(r.plan, 'status'); });
        var back = K.backTarget(plan);
        if (back !== null) btn('back', K.OFFER_TEXT.back + ': ' + K.fmtInt(back) + ' mg a day', function () { var r = K.applyBack(plan, D.todayLocal()); if (r.ok) savePlan(r.plan, 'status'); });
      }
      if (active || done) {
        btn('goal', 'Change goal', function () { openGoalForm(plan, editSlot, row); });
        if (active) btn('pct', 'Change weekly step', function () { openPctForm(plan, editSlot, row); });
        btn('end', 'End plan', function () {
          if (!window.confirm(END_Q)) return;
          var r = K.endPlan(plan, D.todayLocal());
          if (r.ok) savePlan(r.plan, 'status');
        });
      }
      btn('again', 'Start again', function () {
        if (!window.confirm(AGAIN_Q)) return;
        savePlan(K.restartBaseline(plan, D.todayLocal()), 'status');
      });
      planBox.appendChild(row);
      planBox.appendChild(editSlot);
      if (active || done) {
        planBox.appendChild(el('p', { class: 'banner small', text: K.TEXT.W4 }));
        planBox.appendChild(el('p', { class: 'small', text: K.TEXT.W5 }));
      }
      planBox.appendChild(historyTable(plan));
    }

    function historyTable(plan) {
      var rows = K.historyRows(plan);
      var capId = nextId('caf-hist');
      var tbody = el('tbody');
      rows.forEach(function (r) {
        tbody.appendChild(el('tr', null, [el('th', { scope: 'row', text: D.formatLong(r.date) }), el('td', { text: r.what }), el('td', { text: r.amount })]));
      });
      var table = el('table', { class: 'data-table' }, [
        el('caption', { id: capId, text: 'Plan history' }),
        el('thead', null, el('tr', null, [el('th', { scope: 'col', text: 'Date' }), el('th', { scope: 'col', text: 'What happened' }), el('th', { scope: 'col', text: 'Amount' })])),
        tbody
      ]);
      return el('div', { class: 'table-wrap', role: 'region', 'aria-labelledby': capId, tabindex: '0' }, table);
    }

    function closeEdit(slot, row, key) {
      slot.textContent = '';
      row.hidden = false;
      focusKey(row, key, null);
    }
    function openGoalForm(plan, slot, row) {
      var fid = nextId('caf-goal');
      var inp = el('input', { type: 'text', inputmode: 'numeric', id: fid, autocomplete: 'off', 'aria-describedby': fid + '-err' });
      var err = el('div', { class: 'field-error', id: fid + '-err', role: 'alert' });
      var save = el('button', { type: 'submit', class: 'primary', text: 'Save goal' });
      var f = el('form', { class: 'caf-form', novalidate: true, 'aria-label': 'Change goal' });
      var busy = false;
      function cancel() { if (!busy) closeEdit(slot, row, 'goal'); }
      onEscape(f, cancel);
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (busy) return;
        err.textContent = '';
        var g = K.parseGoal(inp.value, plan.baselineMg);
        if (!g.ok) { err.textContent = g.error; inp.focus(); return; }
        var kind = K.goalChangeKind(plan, g.goal);
        if (kind === 'same') { closeEdit(slot, row, 'goal'); return; }
        if (kind === 'finish' && !window.confirm(FINISH_Q)) { inp.focus(); return; }
        var r = K.changeGoal(plan, g.goal, D.todayLocal());
        if (!r.ok) return;
        busy = true;
        save.disabled = true;
        savePlan(r.plan, 'status');
      });
      f.appendChild(el('label', { for: fid, text: 'New goal, in mg' }));
      f.appendChild(el('p', { class: 'field-hint', text: 'Any whole number lower than your usual amount (about ' + K.fmtInt(plan.baselineMg) + ' mg a day), including 0.' }));
      f.appendChild(inp);
      f.appendChild(err);
      f.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [save, el('button', { type: 'button', text: 'Cancel', onclick: cancel })]));
      slot.textContent = '';
      slot.appendChild(f);
      row.hidden = true;
      inp.focus();
    }
    function openPctForm(plan, slot, row) {
      var name = nextId('caf-pct2');
      var fs = el('fieldset', null, [el('legend', { text: 'Weekly step (from the next step)' })]);
      var sg = el('div', { class: 'seg' });
      K.PCTS.forEach(function (p) {
        sg.appendChild(el('label', { class: 'choice' }, [el('input', { type: 'radio', name: name, value: String(p), checked: p === plan.pct }), el('span', { text: p + '%' })]));
      });
      fs.appendChild(sg);
      var save = el('button', { type: 'submit', class: 'primary', text: 'Save weekly step' });
      var f = el('form', { class: 'caf-form', novalidate: true, 'aria-label': 'Change weekly step' });
      var busy = false;
      function cancel() { if (!busy) closeEdit(slot, row, 'pct'); }
      onEscape(f, cancel);
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (busy) return;
        var c = sg.querySelector('input:checked');
        var r = K.changePct(plan, c ? Number(c.value) : plan.pct, D.todayLocal());
        if (!r.ok || r.unchanged) { closeEdit(slot, row, 'pct'); return; }
        busy = true;
        save.disabled = true;
        savePlan(r.plan, 'status');
      });
      f.appendChild(fs);
      f.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [save, el('button', { type: 'button', text: 'Cancel', onclick: cancel })]));
      slot.textContent = '';
      slot.appendChild(f);
      row.hidden = true;
      var checked = sg.querySelector('input:checked');
      if (checked) checked.focus();
    }

    // ----- notes (W11, W10, W1) -----
    card.appendChild(el('h3', { text: 'About caffeine amounts' }));
    card.appendChild(el('p', { class: 'small', text: K.TEXT.W11 }));
    card.appendChild(el('p', { class: 'small', text: K.TEXT.W10 }));
    card.appendChild(el('p', { class: 'small', text: K.TEXT.W1 }));

    drawPlan();
    drawDrinks();
    return {
      cleanup: function () { alive = false; },
      refresh: function () {
        var s = settingsNow();
        Array.prototype.forEach.call(unitFs.querySelectorAll('input'), function (i) { i.checked = i.value === unitNow(); });
        bedIn.value = s.caffeineBedtime || '';
        cutSel.value = String(s.caffeineCutoffHours || 8);
        startForm = null;
        drawPlan(); drawDrinks();
      }
    };
  }

  HT.caffeineUI = { mountDay: mountDay, renderSettingsCard: renderSettingsCard, buildForm: buildForm,
    buildStartForm: buildStartForm, loadBaseline: loadBaseline, OFFER_PREF: OFFER_PREF,
    END_Q: END_Q, AGAIN_Q: AGAIN_Q, FINISH_Q: FINISH_Q };
})(window.HT = window.HT || {});
