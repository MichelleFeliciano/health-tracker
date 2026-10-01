/* Health Tracker — summary.js
 * Printable 30 / 90-day summary to take to a doctor, opened from the Trends screen.
 * Shows: averages, lowest–highest, day counts, "hard to tell" counts, tag frequency, meals by
 * carb level, and glucose readings exactly AS ENTERED with their units (decisions.md: stored
 * as entered; display conversion only via HT.units, ÷ 18.0156).
 * Deliberately NOT shown: any diagnostic or target threshold, range flag, condition name, or
 * "normal/abnormal" label (FDA 2026 General Wellness, A-003 W5; decisions.md 2026-09-23).
 * Partial sleep nights are excluded from sleep averages and counted (R-001 §6.1 step 10).
 * Caffeine (A-010 §9): a "Daily measures" row (estimates) and a "Caffeine" subsection with the
 * person's own plan, late-evening count (only if a bedtime is set) and headache/tiredness marks.
 * NO reference amounts (no 400 or 200 mg), no count of days over any amount, no pregnancy
 * numbers, and no amber/red or .notice styling (U-1).
 * Printing uses the browser's print dialog; css/charts.css holds the print stylesheet.
 * Classic script. Exposes window.HT.summary = { render(container, {days, onBack}), build }.
 * Never logs health data.
 */
(function (HT) {
  'use strict';

  // Same anchors the user rated against on the Today screen (js/today.js), so a clinician
  // reading the print knows each scale is relative to the person (A-004 L6).
  var RATING_ROWS = [
    ['anxiety', 'Anxiety (0 = not anxious at all, 10 = the most anxious I get)'],
    ['mood', 'Mood (0 = the worst mood I get, 10 = the best mood I get)'],
    ['energy', 'Energy (0 = no energy at all, 10 = the most energy I get)'],
    ['stress', 'Stress (0 = not stressed at all, 10 = the most stressed I get)']
  ];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  /** Same rule as HT.db sanitize / HT.stats: integer 0–720 (A-005 Part 2). */
  function validMinutes(v) { return isNum(v) && Math.floor(v) === v && v >= 0 && v <= 720; }

  function isHHMM(t) { return typeof t === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t); }
  function fmtInt(n) {
    if (HT.trends && HT.trends.fmt) return HT.trends.fmt.int(n);
    return String(Math.round(n));
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /**
   * Pure: caffeine numbers for the period (A-010 §9).
   * opts.settings: bedtime / cut-off (default HT.state.settings); opts.plan: the plan record
   * (default days.caffeinePlan, loaded by HT.trends.data.loadDays).
   */
  function buildCaffeine(days, opts) {
    var D = HT.trends.data, core = HT.caffeineCore;
    var st = D.caffeineStats(days);
    var c = { n: st.n, mean: st.mean, min: st.min, max: st.max, none: st.none, headache: 0, tired: 0, late: null, plan: null };
    days.dates.forEach(function (d) {
      var x = days.byDate[d].caffeine;
      if (x.headache) c.headache++;
      if (x.tired) c.tired++;
    });
    var settings = (opts && opts.settings) || (HT.state && HT.state.settings) || {};
    if (isHHMM(settings.caffeineBedtime)) {
      var N = typeof settings.caffeineCutoffHours === 'number' ? settings.caffeineCutoffHours : 8;
      var flags = D.lateFlags(days, settings.caffeineBedtime, N), k = 0, n = 0;
      Object.keys(flags).forEach(function (d) { n++; if (flags[d] === 1) k++; });
      c.late = { hours: N, k: k, n: n };
    }
    var plan = opts && opts.plan !== undefined ? opts.plan : days.caffeinePlan;
    // A plan "overlaps" the period if it started on or before the last day and had not ended
    // before the first day. Baseline-only records have no plan to report.
    if (plan && (plan.status === 'active' || plan.status === 'done' || plan.status === 'ended') &&
        typeof plan.startDate === 'string' && plan.startDate <= days.end &&
        !(plan.status === 'ended' && typeof plan.endDate === 'string' && plan.endDate < days.start)) {
      c.plan = { goalMg: plan.goalMg, pct: plan.pct,
        targetOnEnd: core && typeof core.targetOn === 'function' ? core.targetOn(plan, days.end) : null };
    }
    return c;
  }

  /**
   * Pure: the caffeine row for "Daily measures" and the lines of the "Caffeine" subsection,
   * exact A-010 §9 templates. endLabel = the period's last day, formatted.
   */
  function caffeineText(c, endLabel) {
    var row = ['Caffeine, about mg per day (estimates)', String(c.n),
      c.n ? fmtInt(c.mean) : '—',
      c.n ? fmtInt(c.min) + ' – ' + fmtInt(c.max) : '—',
      plural(c.none, 'day', 'days') + ' marked no caffeine (counted as 0). Amounts are estimates from food databases and labels.'];
    var lines = [];
    if (!c.n) lines.push('No caffeine logged in this period.');
    if (c.plan) {
      lines.push('Goal set by the person: ' + fmtInt(c.plan.goalMg) + ' mg a day.' +
        (typeof c.plan.targetOnEnd === 'number' ? ' Target on ' + endLabel + ': ' + fmtInt(c.plan.targetOnEnd) + ' mg a day.' : '') +
        ' Weekly step chosen: ' + c.plan.pct + '%.');
    }
    if (c.late) lines.push('Evenings with caffeine within ' + c.late.hours + ' hours of the person’s usual bedtime: ' + c.late.k + ' of ' + c.late.n + ' logged.');
    lines.push('Days marked headache: ' + c.headache + '. Days marked tiredness: ' + c.tired + '.');
    return { row: row, lines: lines };
  }

  /**
   * Pure: build the summary numbers from merged days (HT.trends.data.buildDays output).
   * unit = the user's display glucose unit. opts: see buildCaffeine.
   */
  function build(days, unit, opts) {
    var D = HT.trends.data, U = HT.units;
    var out = { start: days.start, end: days.end, totalDays: days.dates.length, unit: unit };
    out.loggedDays = 0;
    days.dates.forEach(function (d) { if (days.byDate[d].logged) out.loggedDays++; });
    out.sleep = D.sleepStats(days);
    out.steps = D.describe(D.series(days, 'steps'));
    out.ratings = {};
    RATING_ROWS.forEach(function (r) {
      var st = D.describe(D.series(days, r[0]));
      st.hardToTell = D.hardToTellCount(days, r[0]);
      out.ratings[r[0]] = st;
    });
    // Tag frequency over logged days ("other" included here: it is a count, not an analysis).
    out.tags = Object.keys(HT.trends.TAG_LABELS).map(function (t) {
      var c = 0;
      days.dates.forEach(function (d) { if (days.byDate[d].tags.indexOf(t) >= 0) c++; });
      return { tag: t, label: HT.trends.TAG_LABELS[t], days: c };
    });
    // Meals and glucose, as entered.
    out.meals = { total: 0, byCarb: { low: 0, med: 0, high: 0, none: 0 } };
    out.glucose = [];
    var lo = Infinity, hi = -Infinity;
    days.dates.forEach(function (d) {
      days.byDate[d].meals.forEach(function (m) {
        out.meals.total++;
        out.meals.byCarb[m.carb === 'low' || m.carb === 'med' || m.carb === 'high' ? m.carb : 'none']++;
        var g = m.glucose;
        if (g && isNum(g.value) && U.isUnit(g.unit)) {
          var mg = U.toMgdlExact(g.value, g.unit);
          if (mg < lo) lo = mg; if (mg > hi) hi = mg;
          out.glucose.push({ date: d, time: m.time, carb: m.carb || null,
            entered: U.format(g.value, g.unit, g.unit),            // exactly as entered, with unit
            display: g.unit === unit ? null : U.format(g.value, g.unit, unit),
            // A-005 Part 2: minutes from meal start, as the user reported it; null = not known.
            minutesAfter: validMinutes(g.minutesAfter) ? g.minutesAfter : null });
        }
      });
    });
    out.glucoseRange = out.glucose.length ? { low: U.formatMgdlIn(lo, unit) + ' ' + unit, high: U.formatMgdlIn(hi, unit) + ' ' + unit } : null;
    out.caffeine = buildCaffeine(days, opts);
    return out;
  }

  function render(container, opts) {
    var T = HT.trends, F = T.fmt, el = T.el, alive = true;
    opts = opts || {};
    var period = opts.days === 90 ? 90 : 30;
    T.ensureCss();
    document.documentElement.classList.add('printing-summary');

    var root = el('div', { class: 'summary' });
    container.appendChild(root);

    var backBtn = el('button', { type: 'button', text: '‹ Back to trends' });
    var printBtn = el('button', { type: 'button', class: 'primary', text: 'Print or save as PDF' });
    var controls = el('div', { class: 'no-print summary-controls' });
    var fs = el('fieldset', { class: 'range-picker' }, [el('legend', { text: 'Summary covers the last' })]);
    var seg = el('div', { class: 'seg' }), gname = 'sum-range-' + Date.now();
    [30, 90].forEach(function (n) {
      var inp = el('input', { type: 'radio', name: gname, value: String(n) });
      inp.checked = n === period;
      inp.addEventListener('change', function () { if (inp.checked) { period = n; load(); } });
      seg.appendChild(el('label', { class: 'choice' }, [inp, el('span', { text: n + ' days' })]));
    });
    fs.appendChild(seg);
    controls.appendChild(el('div', { class: 'row' }, [backBtn, printBtn]));
    controls.appendChild(fs);
    root.appendChild(controls);
    var status = el('p', { class: 'muted no-print', role: 'status', 'aria-live': 'polite' });
    root.appendChild(status);
    var body = el('div', { class: 'summary-body' });
    root.appendChild(body);

    backBtn.addEventListener('click', function () { if (opts.onBack) opts.onBack(); });
    printBtn.addEventListener('click', function () { try { window.print(); } catch (e) { status.textContent = 'Printing is not available in this browser.'; } });

    function row(cells) { return cells; }

    function draw(s) {
      body.textContent = '';
      var headId = 'sum-h-' + Date.now();
      body.appendChild(el('h2', { id: headId, text: 'Health log summary' }));
      body.appendChild(el('p', { text: F.longDate(s.start) + ' to ' + F.longDate(s.end) + ' (' + s.totalDays + ' days). Days with a log entry: ' + s.loggedDays + '.' }));
      body.appendChild(el('p', { class: 'small', text: 'Prepared on ' + F.longDate(HT.dates.todayLocal()) + ' from the person’s own daily entries and Apple Watch / iPhone data. Ratings are the person’s own 0–10 scores, not a clinical questionnaire.' }));

      // Daily measures
      var sl = s.sleep, rows = [];
      rows.push(row(['Sleep, hours asleep per night',
        String(sl.n) + (sl.partial ? ' (+' + sl.partial + ' partial)' : ''),
        sl.n ? F.hm(sl.mean * 60) : '—',
        sl.n ? F.hm(sl.min * 60) + ' – ' + F.hm(sl.max * 60) : '—',
        (sl.partial ? sl.partial + ' partial night' + (sl.partial === 1 ? '' : 's') + ' not included. ' : '') + 'Dated by wake-up day. Watch estimate.']));
      var st = s.steps;
      rows.push(row(['Steps per day', String(st.n), st.n ? F.int(st.mean) : '—', st.n ? F.int(st.min) + ' – ' + F.int(st.max) : '—', 'Watch / phone estimate.']));
      RATING_ROWS.forEach(function (r) {
        var x = s.ratings[r[0]];
        rows.push(row([r[1], String(x.n), x.n ? F.one(x.mean) : '—', x.n ? x.min + ' – ' + x.max : '—',
          x.hardToTell ? x.hardToTell + ' day' + (x.hardToTell === 1 ? '' : 's') + ' “hard to tell” (not counted).' : '']));
      });
      var caf = caffeineText(s.caffeine, F.longDate(s.end));
      rows.push(row(caf.row));
      body.appendChild(el('h3', { text: 'Daily measures' }));
      body.appendChild(T.dataTable('Averages over days with data', ['Measure', 'Days with data', 'Average', 'Lowest – highest', 'Notes'], rows));

      // Tags
      body.appendChild(el('h3', { text: 'Things marked on the day' }));
      body.appendChild(T.dataTable('Days each tag was marked (' + s.loggedDays + ' days logged)', ['Tag', 'Days marked'],
        s.tags.map(function (t) { return [t.label, String(t.days)]; })));

      // Caffeine (A-010 §9): plain paragraphs, no reference amounts, no colour.
      body.appendChild(el('h3', { text: 'Caffeine' }));
      caf.lines.forEach(function (t) { body.appendChild(el('p', { text: t })); });

      // Meals
      body.appendChild(el('h3', { text: 'Meals' }));
      var mc = s.meals.byCarb;
      body.appendChild(el('p', { text: s.meals.total + ' meal' + (s.meals.total === 1 ? '' : 's') + ' logged. Carb level (the person’s own estimate): low ' + mc.low + ', medium ' + mc.med + ', high ' + mc.high + (mc.none ? ', not set ' + mc.none : '') + '.' }));

      // Glucose readings, as entered
      body.appendChild(el('h3', { text: 'Glucose readings (as entered)' }));
      if (!s.glucose.length) {
        body.appendChild(el('p', { text: 'No glucose readings entered in this period.' }));
      } else {
        body.appendChild(el('p', { text: s.glucose.length + ' reading' + (s.glucose.length === 1 ? '' : 's') + ' entered. Lowest ' + s.glucoseRange.low + ', highest ' + s.glucoseRange.high + '. Values are shown exactly as typed; converted values use mmol/L = mg/dL ÷ 18.0156.' }));
        var anyConv = s.glucose.some(function (g) { return g.display; });
        var head = ['Date', 'Meal time', 'Carb level', 'Reading as entered'];
        if (anyConv) head.push('In ' + s.unit);
        head.push('Minutes after meal start');
        body.appendChild(T.dataTable('Glucose readings linked to meals', head, s.glucose.map(function (g) {
          var r = [F.longDate(g.date), HT.dates.formatTime(g.time), g.carb ? T.CARB_LABELS[g.carb] : 'Not set', g.entered];
          if (anyConv) r.push(g.display || g.entered);
          r.push(g.minutesAfter === null ? '' : String(g.minutesAfter));   // blank when not known (A-005)
          return r;
        })));
      }

      body.appendChild(el('div', { class: 'disclaimer summary-note' }, [
        el('p', null, [el('strong', { text: 'Not medical advice. ' }), document.createTextNode('This is a personal wellness log. It does not diagnose, treat or prevent any condition. Sleep and step figures are device estimates. Please discuss any questions with a qualified health professional.')])
      ]));
    }

    function load() {
      status.textContent = 'Loading…';
      T.data.loadDays(period).then(function (days) {
        if (!alive) return;
        var unit = (HT.state && HT.state.settings && HT.state.settings.glucoseUnit) || 'mg/dL';
        draw(build(days, unit));
        status.textContent = 'Showing the last ' + period + ' days.';
      }).catch(function () {
        if (alive) status.textContent = 'Your data could not be read on this device.';
      });
    }
    load();
    try { backBtn.focus(); } catch (e) { /* ignore */ }

    return function cleanup() {
      alive = false;
      document.documentElement.classList.remove('printing-summary');
    };
  }

  HT.summary = { render: render, build: build, buildCaffeine: buildCaffeine, caffeineText: caffeineText, RATING_ROWS: RATING_ROWS };
})(window.HT = window.HT || {});
