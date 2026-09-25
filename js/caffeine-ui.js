/* Health Tracker — caffeine-ui.js
 * Caffeine screens, Batch A (docs/team/analysis/A-010-caffeine-spec.md §3, §6):
 *  - the day section on Today / past days (mounted by js/today.js after Meals): baseline status
 *    (today only), day total, quick add from My drinks (today only), entry list, the add/edit
 *    form, and the "No caffeine today" toggle;
 *  - the Settings "Caffeine" card (mounted by js/settings.js): volume unit, the baseline
 *    ("Track my usual amount"), My drinks, and the W1 note.
 * Batch B adds the plan start form, taper steps, the late-caffeine note, bedtime settings and the
 * withdrawal chips. Until then "Start my plan now" only says the plan is coming.
 *
 * U-1 (decisions.md 2026-09-25): no caffeine element uses `.notice`, `--danger`, `--notice-*`
 * or `--focus`; notes are `.banner` or plain `.small` text; totals are never coloured and there
 * is no icon, badge or message at any amount. The only exceptions are `.field-error` form
 * validation text and `button.danger` Delete buttons (existing conventions).
 * All arithmetic lives in js/caffeine-core.js. Never logs entries.
 * Exposes window.HT.caffeineUI = { mountDay, renderSettingsCard, buildForm }.
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
   */
  function drawBaseline(box, sum, where, today, redraw) {
    var K = HT.caffeineCore;
    box.textContent = '';
    var hidden = where === 'today' && prefGet(OFFER_PREF) === today;
    var v = K.baselineView(sum, { offerHidden: hidden });
    var buttons = v.buttons;
    if (where === 'settings') buttons = buttons.filter(function (b) { return b !== 'keep'; });
    box.appendChild(el('p', { class: 'caf-status', text: v.text }));
    if (!buttons.length) return;
    var msg = el('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
    var row = el('div', { class: 'row' });
    buttons.forEach(function (b) {
      var btn = el('button', { type: 'button', class: b === 'keep' ? '' : 'primary', text: K.BASE_TEXT[b] });
      btn.addEventListener('click', function () {
        if (b === 'keep') { prefSet(OFFER_PREF, today); if (typeof redraw === 'function') redraw(); return; }
        // Batch A: the plan start form is Batch B. Nothing else happens.
        msg.textContent = K.BASE_TEXT.notYet;
      });
      row.appendChild(btn);
    });
    box.appendChild(row);
    box.appendChild(msg);
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
    var st = { entries: [], day: null, drinks: [], base: null };
    var hid = nextId('caf-h');

    var statusBox = el('div', { class: 'caf-baseline' });
    var totalP = el('p', { class: 'caf-total' });
    var quickBox = el('div');
    var live = el('div', { class: 'caf-live', role: 'status', 'aria-live': 'polite' });
    var list = el('ul', { class: 'meal-list caf-list' });
    var formSlot = el('div');
    var addBtn = el('button', { type: 'button', class: 'primary', text: '+ Add caffeine' });
    var noneBtn = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', text: isToday ? 'No caffeine today' : 'No caffeine this day' });
    var noneWrap = el('div', { class: 'chips', style: 'margin-top:10px' }, [noneBtn]);

    sec.setAttribute('aria-labelledby', hid);
    sec.appendChild(el('h2', { id: hid, text: 'Caffeine' }));
    if (isToday) sec.appendChild(statusBox);
    sec.appendChild(totalP);
    if (isToday) sec.appendChild(quickBox);
    sec.appendChild(live);
    sec.appendChild(list);
    sec.appendChild(formSlot);
    sec.appendChild(addBtn);
    sec.appendChild(noneWrap);

    function load() {
      return Promise.all([
        HT.db.getCaffeineForDate(date),
        HT.db.getCaffeineDay(date),
        isToday ? HT.db.getCaffeineDrinks() : Promise.resolve([]),
        isToday ? loadBaseline(today) : Promise.resolve(null)
      ]).then(function (r) {
        if (!alive) return;
        st.entries = r[0]; st.day = r[1] || null; st.drinks = r[2]; st.base = r[3];
        draw();
      }, function () {
        if (!alive) return;
        totalP.textContent = 'Could not load caffeine for this day. Try reloading.';
      });
    }

    function draw() {
      var unit = unitNow();
      // 1. baseline status (today only)
      statusBox.textContent = '';
      if (isToday && st.base && st.base.sum) drawBaseline(statusBox, st.base.sum, 'today', today, draw);
      // 2. total
      var tot = K.dayTotal(st.entries, st.day);
      if (tot.count) totalP.textContent = 'About ' + K.fmtInt(tot.mg) + ' mg ' + (isToday ? 'today' : 'on this day');
      else if (tot.none) totalP.textContent = isToday ? 'No caffeine marked for today.' : 'No caffeine marked for this day.';
      else totalP.textContent = isToday ? 'No caffeine logged yet.' : 'No caffeine logged on this day.';
      // 4. quick add (today only)
      quickBox.textContent = '';
      if (isToday && st.drinks.length) {
        var qh = nextId('caf-q');
        quickBox.appendChild(el('p', { class: 'small muted', id: qh, text: 'Quick add from My drinks:' }));
        var wrap = el('div', { class: 'caf-quick', role: 'group', 'aria-labelledby': qh });
        st.drinks.slice(0, K.QUICK_MAX).forEach(function (d) {
          var b = el('button', { type: 'button', class: 'caf-quick-btn', text: K.describe(d, unit) });
          b.addEventListener('click', function () { quickAdd(d, wrap); });
          wrap.appendChild(b);
        });
        quickBox.appendChild(wrap);
      }
      // 5. entries
      list.textContent = '';
      st.entries.forEach(function (e) {
        list.appendChild(el('li', null, [
          el('div', { class: 'meal-main' }, [el('strong', { text: fmtTime(e.time) }), ' ', el('span', { text: K.describe(e, unit) })]),
          el('div', { class: 'row' }, [
            el('button', { type: 'button', text: 'Edit', 'aria-label': 'Edit ' + e.label + ' at ' + fmtTime(e.time), onclick: function () { openForm(e); } }),
            el('button', { type: 'button', class: 'danger', text: 'Delete', 'aria-label': 'Delete ' + e.label + ' at ' + fmtTime(e.time), onclick: function () { removeEntry(e); } })
          ])
        ]));
      });
      list.hidden = !st.entries.length;
      // 7. "No caffeine today" toggle, only when there are no entries
      noneWrap.hidden = st.entries.length > 0;
      noneBtn.setAttribute('aria-pressed', tot.none ? 'true' : 'false');
    }

    // T001-02 pattern: every quick button is disabled while one save is in flight.
    function quickAdd(d, wrap) {
      var btns = wrap.querySelectorAll('button');
      if (wrap.getAttribute('data-busy') === '1') return;
      wrap.setAttribute('data-busy', '1');
      Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
      var id = HT.db.newId();
      status('Saving…');
      HT.db.saveCaffeineEntry(K.entryFromDrink(d, date, D.nowHHMM(), id)).then(function () {
        status('Saved', 'ok');
        showAdded(d.label, id);
        return load();
      }, function (e) {
        saveError(e);
        wrap.removeAttribute('data-busy');
        Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
      });
    }
    function showAdded(label, id) {
      live.textContent = '';
      var undo = el('button', { type: 'button', class: 'link', text: 'Undo' });
      undo.addEventListener('click', function () {
        undo.disabled = true;
        HT.db.deleteCaffeineEntry(id).then(function () {
          live.textContent = 'Removed ' + label + '.';
          status('Deleted', 'ok');
          return load();
        }, function (e) { undo.disabled = false; saveError(e); });
      });
      live.appendChild(el('p', { class: 'small', style: 'margin:4px 0' }, ['Added ' + label + '. ', undo]));
    }

    function removeEntry(e) {
      if (!window.confirm('Delete ' + e.label + ' at ' + fmtTime(e.time) + '?')) return;
      status('Saving…');
      HT.db.deleteCaffeineEntry(e.id).then(function () { status('Deleted', 'ok'); live.textContent = ''; return load(); }, saveError);
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
      var on = noneBtn.getAttribute('aria-pressed') !== 'true';
      noneBtn.disabled = true;
      status('Saving…');
      HT.db.setCaffeineDay(date, { none: on }).then(function () {
        status('Saved', 'ok');
        noneBtn.disabled = false;
        return load();
      }, function (e) { noneBtn.disabled = false; saveError(e); });
    });

    load();
    return function cleanupCaffeineDay() { alive = false; };
  }

  // =====================================================================================
  // Settings card (A-010 §6 "Settings 'Caffeine' card", Batch A part)
  // =====================================================================================
  /** Returns { cleanup(), refresh() }. refresh() re-reads the plan and drinks (after a restore). */
  function renderSettingsCard(card) {
    var K = HT.caffeineCore, D = HT.dates;
    var alive = true;
    var hid = nextId('caf-set');
    card.setAttribute('aria-labelledby', hid);
    card.appendChild(el('h2', { id: hid, style: 'margin-top:0', text: 'Caffeine' }));

    // ----- volume unit (D9: fl oz default) -----
    var unitName = nextId('caf-unit');
    var unitFs = el('fieldset', null, [el('legend', { text: 'Show drink amounts in' })]);
    var seg = el('div', { class: 'seg' });
    HT.db.CAFFEINE_UNITS.forEach(function (u) {
      var r = el('input', { type: 'radio', name: unitName, value: u, checked: unitNow() === u });
      r.addEventListener('change', function () {
        if (!r.checked) return;
        status('Saving…');
        HT.db.patchSettings({ caffeineVolumeUnit: u }).then(function (saved) {
          if (HT.state) HT.state.settings = JSON.parse(JSON.stringify(saved));
          status('Saved', 'ok');
          drawDrinks();
        }, saveError);
      });
      seg.appendChild(el('label', { class: 'choice' }, [r, el('span', { text: u })]));
    });
    unitFs.appendChild(seg);
    card.appendChild(unitFs);

    // ----- usual amount (baseline) -----
    var baseH = nextId('caf-base');
    var baseBox = el('div');
    card.appendChild(el('h3', { id: baseH, text: 'Your usual amount' }));
    card.appendChild(baseBox);

    function drawPlan() {
      var today = D.todayLocal();
      return loadBaseline(today).then(function (b) {
        if (!alive) return;
        baseBox.textContent = '';
        if (!b.plan) {
          baseBox.appendChild(el('p', { class: 'small', text: 'Log your caffeine as usual, without changing anything, and the app works out your usual daily amount. You can start a plan after 3 days; 7 days is recommended.' }));
          baseBox.appendChild(el('button', { type: 'button', class: 'primary', text: 'Track my usual amount', onclick: function (ev) {
            ev.currentTarget.disabled = true;
            status('Saving…');
            HT.db.saveCaffeinePlan(K.newBaselinePlan(D.todayLocal())).then(function () { status('Saved', 'ok'); drawPlan(); }, function (e) { saveError(e); drawPlan(); });
          } }));
          return;
        }
        if (b.plan.status === 'baseline') {
          var box = el('div');
          baseBox.appendChild(box);
          drawBaseline(box, b.sum, 'settings', today, drawPlan);
          baseBox.appendChild(el('p', { class: 'small muted', text: 'Tracking since ' + D.formatLong(b.plan.baselineStartDate) + '.' }));
          baseBox.appendChild(el('button', { type: 'button', text: 'Start the baseline again', onclick: function () {
            if (!window.confirm('Start tracking your usual amount again from today? Days logged so far will no longer count toward it. Your caffeine entries are kept.')) return;
            status('Saving…');
            HT.db.saveCaffeinePlan(K.restartBaseline(b.plan, D.todayLocal())).then(function () { status('Saved', 'ok'); drawPlan(); }, saveError);
          } }));
          return;
        }
        // active / done / ended: restored from a backup made by a later build (Batch B).
        baseBox.appendChild(el('p', { class: 'small', text: 'A caffeine plan is saved on this device. Plan steps will appear here in the next update.' }));
      }, function () {
        if (alive) { baseBox.textContent = ''; baseBox.appendChild(el('p', { class: 'small', text: 'Could not load the caffeine plan. Try reloading.' })); }
      });
    }

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
                HT.db.deleteCaffeineDrink(d.id).then(function () { status('Deleted', 'ok'); drawDrinks(); }, saveError);
              } })
            ])
          ]));
        });
        var full = list.length >= K.DRINKS_MAX;
        addDrinkBtn.hidden = full || !!drinkForm.firstChild;
        drinkNote.textContent = full ? 'You have ' + K.DRINKS_MAX + ' saved drinks. Delete one to add another.' : '';
      });
    }
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
      addDrinkBtn.focus();
    }
    addDrinkBtn.addEventListener('click', function () { openDrinkForm(null); });

    // ----- notes -----
    card.appendChild(el('h3', { text: 'About caffeine amounts' }));
    card.appendChild(el('p', { class: 'small', text: K.TEXT.W1 }));

    drawPlan();
    drawDrinks();
    return {
      cleanup: function () { alive = false; },
      refresh: function () {
        Array.prototype.forEach.call(unitFs.querySelectorAll('input'), function (i) { i.checked = i.value === unitNow(); });
        drawPlan(); drawDrinks();
      }
    };
  }

  HT.caffeineUI = { mountDay: mountDay, renderSettingsCard: renderSettingsCard, buildForm: buildForm,
    loadBaseline: loadBaseline, OFFER_PREF: OFFER_PREF };
})(window.HT = window.HT || {});
