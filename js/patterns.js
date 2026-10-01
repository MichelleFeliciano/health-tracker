/* Health Tracker — patterns.js
 * Patterns screen: plain-language cards for the FIXED pair set of
 * docs/team/analysis/A-003-metrics-evidence-and-patterns.md §5.2 (P1–P12), computed with
 * HT.stats (js/stats.js = A-003 §5.4/§5.5) and worded with the §5.6 sentence templates.
 * Also: docs/team/research/R-003-metrics-evidence-and-patterns.md Revision 1 (gating 14/30,
 * n_eff ≥ 20, "no clear pattern yet" is never "no link").
 *
 * Window: the last 90 local days, today included (§5.3). All lags are in STORED dates:
 * sleep is stored under its wake date, so sleep(d)↔rating(d) is lag 0 and
 * steps(d)↔sleep(d+1) is lag +1 (A-003 §1 "Additional check").
 * Sleep input: usable nights only (partial nights and in-bed-only rows are missing, because a
 * partial night's figure is known to be too low — R-001 §6.1 step 10).
 * Never shown: p values, "significant", "causes", "because", advice, red/green, condition
 * names, thresholds (§5.6).
 * Caffeine pairs (docs/team/analysis/A-010-caffeine-spec.md §8, same engine, stats.js unchanged):
 *  - P13 late caffeine → sleep: X(E) = 0/1 late flag per caffeine-logged evening E (D6),
 *    Y = usable sleep on WAKE-DATE E+1, so the stored-date lag is +1 (R-001 §6.1, 18:00
 *    boundary; same offset as P5). Run as a tag (split, W state, ≥ 5 / ≥ 5 gate). Needs a
 *    bedtime from 18:00 to 05:59 (states noBed / bedRange are never tested).
 *  - P14 caffeine → anxiety: daily mg vs same-day anxiety, lag 0, median split shown as ceil.
 *  - Both appear only if the window has at least one caffeine-logged day. BH runs over every
 *    pair that reached state C (m ≤ 14).
 * Classic script. Exposes window.HT.patterns = { render(container), analyze, ... }.
 * Never logs health data.
 */
(function (HT) {
  'use strict';

  var WINDOW_DAYS = 90;
  var MIN_TAG_DAYS = 5;        // ≥ 5 present and ≥ 5 absent days in the window (§5.2)
  var FOOTER = 'Days you didn’t log may be different from days you did, which can affect these results.';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmt1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function fmtInt(n) { try { return Math.round(n).toLocaleString(); } catch (e) { return String(Math.round(n)); } }
  function fmt2(n) { return (Math.round(n * 100) / 100).toFixed(2); }
  function longDate(s) { try { return HT.dates.formatLong(s); } catch (e) { return s; } }
  /** Minutes → "7 h 05 min" (the app's own sleep format, shared with trends.js). */
  function fmtHM(min) {
    if (HT.trends && HT.trends.fmt && HT.trends.fmt.hm) return HT.trends.fmt.hm(min);
    var m = Math.round(min), h = Math.floor(m / 60), r = m - h * 60;
    return h + ' h ' + (r < 10 ? '0' : '') + r + ' min';
  }
  /**
   * Sleep median split point (hours) in "H h MM min" (A-004 §3 item 5 / L1).
   * mMin = nearest half-minute (removes float noise); shown = ceil(mMin). Sleep minutes are
   * integers (health-agg.js toMin), so x < mMin ⇔ x < ceil(mMin): the cut is never misstated.
   */
  function fmtSplitSleep(h) {
    var mMin = Math.round(h * 120) / 2;
    return fmtHM(Math.ceil(mMin));
  }
  /** Steps are whole numbers, so "x < m" is "x < ceil(m)" and "x ≥ m" is "x ≥ ceil(m)". */
  function fmtSplitSteps(m) { return fmtInt(Math.ceil(m - 1e-9)); }

  // ---------------- the fixed pair set (A-003 §5.2) ----------------
  var RATING_NAMES = { anxiety: 'anxiety', mood: 'mood', energy: 'energy', stress: 'stress' };
  var TAG_PAIRS = [
    ['sensory', 'Sensory'], ['schedule-change', 'Schedule change'], ['social', 'Social'],
    ['work-school', 'Work / school'], ['caregiving', 'Caregiving']
  ]; // "Other" is never analysed.

  function ratingY(k) {
    return { key: k, name: RATING_NAMES[k], meanWord: RATING_NAMES[k], plusWord: RATING_NAMES[k] + ' rating',
      up: 'higher', down: 'lower', fmt: fmt1 };
  }
  var SLEEP_X = {
    key: 'sleepH', name: 'Sleep',
    low: function (m) { return 'you slept less than ' + fmtSplitSleep(m); },
    high: function (m) { return 'you slept ' + fmtSplitSleep(m) + ' or more'; },
    phrase: 'after nights with more sleep'
  };
  var STEPS_X = {
    key: 'steps', name: 'Steps',
    low: function (m) { return 'you walked fewer than ' + fmtSplitSteps(m) + ' steps'; },
    high: function (m) { return 'you walked ' + fmtSplitSteps(m) + ' steps or more'; },
    phrase: 'on days with more steps'
  };

  var PAIRS = [];
  ['anxiety', 'mood', 'energy', 'stress'].forEach(function (k, i) {
    PAIRS.push({ id: 'P' + (i + 1), x: SLEEP_X, y: ratingY(k), lag: 0 });
  });
  PAIRS.push({ id: 'P5', lag: 1,
    x: { key: 'steps', name: 'Steps', low: STEPS_X.low, high: STEPS_X.high, phrase: 'on nights after days with more steps' },
    y: { key: 'sleepH', name: 'sleep', meanWord: 'sleep the following night', plusWord: 'sleep',
      up: 'longer', down: 'shorter', fmt: function (h) { return fmtHM(h * 60); } } });   // A-004 §3 item 2 / L1
  PAIRS.push({ id: 'P6', x: STEPS_X, y: ratingY('mood'), lag: 0 });
  TAG_PAIRS.forEach(function (t, i) {
    PAIRS.push({ id: 'P' + (7 + i), lag: 0, tag: t[0], tagLabel: t[1],
      x: { key: 'tag:' + t[0], name: '“' + t[1] + '” days',
        low: function () { return 'you did not mark “' + t[1] + '”'; },
        high: function () { return 'you marked “' + t[1] + '”'; },
        phrase: 'on days you marked “' + t[1] + '”' },
      y: ratingY('anxiety') });
  });
  // ---------------- caffeine pairs (A-010 §8.5 templates, exact) ----------------
  var SLEEP_NEXT_Y = { key: 'sleepH', name: 'sleep', meanWord: 'sleep that night', plusWord: 'sleep',
    up: 'longer', down: 'shorter', fmt: function (h) { return fmtHM(h * 60); } };
  /** P13 with the current cut-off N and bedtime baked into its wording. */
  function lateCaffeinePair(N, bedtime) {
    var w = 'within ' + N + ' hours of your usual bedtime';
    return { id: 'P13', lag: 1, late: true, cutoffHours: N, bedtime: bedtime || null,
      x: { key: 'lateCaffeine', name: 'Late caffeine',
        low: function () { return 'you had no caffeine ' + w; },
        high: function () { return 'you had caffeine ' + w; },
        phrase: 'on nights after caffeine ' + w },
      y: SLEEP_NEXT_Y };
  }
  var CAFFEINE_PAIR = { id: 'P14', lag: 0, caffeine: true,
    x: { key: 'caffeineMg', name: 'Caffeine',
      // mg are whole numbers, so "x < m" ⇔ "x < ceil(m)" (same rule as steps).
      low: function (m) { return 'you logged less than ' + fmtSplitSteps(m) + ' mg of caffeine'; },
      high: function (m) { return 'you logged ' + fmtSplitSteps(m) + ' mg of caffeine or more'; },
      phrase: 'on days you logged more caffeine' },
    y: ratingY('anxiety') };
  var CUTOFF_DEFAULT = 8;
  function isHHMM(t) { return typeof t === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t); }
  /** Bedtimes 18:00–05:59 keep "the night after evening E" on wake-date E+1 (A-010 §8, D6). */
  function bedtimeInRange(t) { var m = +t.slice(0, 2) * 60 + +t.slice(3, 5); return m >= 1080 || m < 360; }
  function cutoffOf(settings) {
    var n = settings && settings.caffeineCutoffHours;
    return typeof n === 'number' && Math.floor(n) === n && n >= 4 && n <= 12 ? n : CUTOFF_DEFAULT;
  }
  /** One daily pair through the engine, with the pair's own lag and tag mode. */
  function runPair(pair, x, y, start, end) {
    return HT.stats.analyzeDaily({ x: x, y: y, lag: pair.lag, start: start, end: end, tag: !!(pair.tag || pair.late) });
  }
  function flagCounts(flags) {
    var c = { present: 0, absent: 0 };
    Object.keys(flags).forEach(function (d) { if (flags[d] === 1) c.present++; else c.absent++; });
    return c;
  }
  /** P13 result: noBed / bedRange / tagGate states before the engine (A-010 §8.1). */
  function analyzeLate(pair, days, ser) {
    if (!isHHMM(pair.bedtime)) return { state: 'noBed', n: 0 };
    if (!bedtimeInRange(pair.bedtime)) return { state: 'bedRange', n: 0 };
    var flags = HT.trends.data.lateFlags(days, pair.bedtime, pair.cutoffHours), c = flagCounts(flags);
    if (c.present < MIN_TAG_DAYS || c.absent < MIN_TAG_DAYS) return { state: 'tagGate', present: c.present, absent: c.absent, n: 0 };
    return runPair(pair, flags, ser.sleepH, days.start, days.end);
  }
  function anyCaffeineLogged(days) {
    return days.dates.some(function (d) { var c = days.byDate[d].caffeine; return !!(c && c.logged); });
  }

  var MEAL_PAIR = { id: 'P12', meal: true,
    x: { name: 'Carb level', phrase: 'after meals you marked as higher-carb' },
    y: { name: 'glucose', plusWord: 'glucose reading', up: 'higher', down: 'lower' } };

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function title(pair) { return cap(pair.x.name) + ' and ' + pair.y.name; }

  // ---------------- series from merged days (HT.trends.data.buildDays output) ----------------
  function buildSeries(days) {
    var D = HT.trends.data, out = {
      sleepH: D.series(days, 'sleepH'), steps: D.series(days, 'steps'),
      anxiety: D.series(days, 'anxiety'), mood: D.series(days, 'mood'),
      energy: D.series(days, 'energy'), stress: D.series(days, 'stress'), tags: {}, tagCounts: {},
      caffeineMg: D.series(days, 'caffeineMg')
    };
    TAG_PAIRS.forEach(function (t) {
      var s = {}, yes = 0, no = 0;
      days.dates.forEach(function (d) {
        var day = days.byDate[d];
        if (!day.logged) return;              // day not logged → missing (not 0)
        var on = day.tags.indexOf(t[0]) >= 0 ? 1 : 0;
        s[d] = on; if (on) yes++; else no++;
      });
      out.tags[t[0]] = s; out.tagCounts[t[0]] = { present: yes, absent: no };
    });
    return out;
  }

  // ---------------- sentences (A-003 §5.6, exact text; {braces} filled) ----------------
  function sentence(pair, r, unit) {
    var T = title(pair);
    if (pair.meal) return mealSentence(pair, r, unit);
    if (pair.late) {   // P13 special states, A-010 §8.1 and §8.5 (exact text)
      var within = 'within ' + pair.cutoffHours + ' hours of your usual bedtime';
      if (r.state === 'noBed') return 'Late caffeine and sleep: set your usual bedtime in Settings to see this comparison.';
      if (r.state === 'bedRange') return 'Late caffeine and sleep: this comparison needs a usual bedtime between 6 PM and 6 AM. Each night is dated by the day you wake up.';
      if (r.state === 'tagGate') {
        return 'Late caffeine and sleep: not enough days yet (' + r.present + ' evenings with caffeine ' + within + ' and ' +
          r.absent + ' without; at least ' + MIN_TAG_DAYS + ' of each are needed).';
      }
      if (r.state === 'W') return 'Late caffeine and sleep: your evenings with late caffeine fell on the same days of the week every week, so this can’t be told apart from the day of the week.';
      if (r.state === 'V' && r.constant === 'x') {
        return 'Late caffeine and sleep: ' + (r.constantValue === 1 ? 'every' : 'no') + ' evening with sleep recorded the next night had caffeine ' +
          within + ', so there is nothing to compare yet.';
      }
    }
    if (r.state === 'tagGate') {
      return T + ': not enough days yet (' + r.present + ' marked and ' + r.absent + ' not marked; at least ' +
        MIN_TAG_DAYS + ' of each are needed).';   // A-004 §3 item 3 / L3
    }
    if (r.state === 'A') return T + ': not enough days yet (' + r.n + ' of 14 days with both recorded).';
    if (r.state === 'W') {   // A-003 step 5c / A-004 M2: tag fixed by weekday, never tested
      return T + ': you marked “' + pair.tagLabel + '” on the same days of the week every week, so this can’t be told apart from the day of the week.';
    }
    if (r.state === 'V') {   // A-004 L4
      if (r.constant === 'residual') return T + ': the values do not vary enough to compare yet.';
      if (pair.tag && r.constant === 'x') {
        return T + (r.constantValue === 1
          ? ': you marked “' + pair.tagLabel + '” on every day that has anxiety recorded, so there is nothing to compare yet.'
          : ': you did not mark “' + pair.tagLabel + '” on any day that has anxiety recorded, so there is nothing to compare yet.');
      }
      var which = r.constant === 'y' ? pair.y.name : pair.x.name.toLowerCase();
      return T + ': ' + which + ' was the same on every recorded day, so there is nothing to compare yet.';
    }
    var range = '(' + longDate(r.firstDate) + ' to ' + longDate(r.lastDate) + ')';
    if (r.state === 'B') {
      if (!r.groupsOk) return T + ': ' + r.n + ' days recorded. There are too few days in one of the groups to compare yet.';
      return T + ', ' + r.n + ' days: on the ' + r.nL + ' days when ' + pair.x.low(r.median) + ', your average ' + pair.y.meanWord +
        ' was ' + pair.y.fmt(r.meanL) + '. On the ' + r.nH + ' days when ' + pair.x.high(r.median) + ', it was ' + pair.y.fmt(r.meanH) +
        '. This is too few days to tell whether the difference is more than chance.';
    }
    if (r.state === 'C0') {
      return T + ': no clear pattern in the last ' + r.n + ' days with both recorded ' + range +
        '. This does not mean they are unrelated. There may not be enough days yet to tell.';
    }
    if (r.state === 'C+') {
      return T + ': over the last ' + r.n + ' days with both recorded ' + range + ', your ' + pair.y.plusWord + ' tended to be ' +
        (r.rho > 0 ? pair.y.up : pair.y.down) + ' ' + pair.x.phrase +
        '. This is a pattern in your own records. It does not show that one causes the other.';
    }
    return T + ': not enough days yet.';
  }

  var CARB_WORDS = { low: 'low', med: 'medium', high: 'high' };
  function mealSentence(pair, r, unit) {
    var T = title(pair);
    unit = unit || 'mg/dL';
    if (r.state === 'A') return T + ': not enough meals yet (' + r.n + ' of 14 meals with both recorded).';
    if (r.state === 'V') return T + ': ' + (r.constant === 'y' ? 'glucose' : 'carb level') + ' was the same for every recorded meal, so there is nothing to compare yet.';
    var range = '(' + longDate(r.firstDate) + ' to ' + longDate(r.lastDate) + ')';
    if (r.state === 'B') {
      // §5.5: show the mean for each carb level that has ≥ 5 meals, in the display unit.
      var parts = ['low', 'med', 'high'].filter(function (k) { return r.byCarb[k].n >= 5; }).map(function (k, i) {
        return 'after the ' + r.byCarb[k].n + ' ' + CARB_WORDS[k] + '-carb meals, ' + (i === 0 ? 'your average glucose reading was ' : 'it was ') +
          HT.units.formatMgdlIn(r.byCarb[k].meanMgdl, unit) + ' ' + unit;
      });
      if (parts.length < 2) return T + ': ' + r.n + ' meals recorded. There are too few meals in one of the groups to compare yet.';
      return T + ', ' + r.n + ' meals: ' + parts.join('; ') +
        '. This is too few meals to tell whether the difference is more than chance.';
    }
    if (r.state === 'C0') {
      return T + ': no clear pattern in the last ' + r.n + ' meals with both recorded ' + range +
        '. This does not mean they are unrelated. There may not be enough meals yet to tell.';
    }
    if (r.state === 'C+') {
      return T + ': over the last ' + r.n + ' meals with both recorded ' + range + ', your glucose reading tended to be ' +
        (r.rho > 0 ? 'higher' : 'lower') + ' ' + pair.x.phrase +
        '. This is a pattern in your own records. It does not show that one causes the other.';
    }
    return T + ': not enough meals yet.';
  }

  /** Optional details line (C0 and C+ only). */
  function detail(pair, r) {
    if (r.state !== 'C0' && r.state !== 'C+') return null;
    return 'Rank correlation ' + fmt2(r.rho) + ' (95% range ' + fmt2(r.lo) + ' to ' + fmt2(r.hi) + '), ' + r.n + (pair.meal ? ' meals.' : ' days.');
  }

  /**
   * P12 card note (A-005 Part 2). The 60–120 minute window is a timing rule from A-003 §5.5
   * (R-003 G3), not a glucose threshold, so it may be shown (Architect, decisions.md
   * 2026-09-23). r.noTime = meals with a carb level and a glucose value but no reading time.
   */
  function mealNote(r) {
    var t = 'Uses only readings marked as taken 60 to 120 minutes after you started eating.';
    var k = r && typeof r.noTime === 'number' ? r.noTime : 0;
    if (k > 0) t += ' ' + k + ' meal reading' + (k === 1 ? '' : 's') + ' without a time ' + (k === 1 ? 'was' : 'were') + ' not used.';
    return t;
  }

  /**
   * P13 card note (A-010 §8.5), shown once a bedtime in range is set. The bedtime is shown in
   * the app's time format (HT.dates.formatTime).
   */
  function lateNote(pair, r) {
    if (!pair || !pair.late || !r || r.state === 'noBed' || r.state === 'bedRange') return null;
    var t = pair.bedtime;
    try { if (HT.dates && HT.dates.formatTime) t = HT.dates.formatTime(pair.bedtime); } catch (e) { /* keep HH:MM */ }
    return 'Uses your current bedtime (' + t + ') and ' + pair.cutoffHours + '-hour setting for every day shown. Each evening is matched with the night that follows it.';
  }

  // ---------------- run every pair, then BH across the tested ones ----------------
  /**
   * days: HT.trends.data.buildDays output covering the window.
   * opts: { unit, settings } (settings default to HT.state.settings; used for P13's bedtime and
   * cut-off). Returns [{ pair, result, sentence, detail }] in PAIRS order, then P12, then P13
   * and P14 when the window has at least one caffeine-logged day (A-010 §8.3).
   */
  function analyze(days, opts) {
    var S = HT.stats, ser = buildSeries(days), results = [];
    PAIRS.forEach(function (p) {
      var r;
      if (p.tag) {
        var c = ser.tagCounts[p.tag];
        if (c.present < MIN_TAG_DAYS || c.absent < MIN_TAG_DAYS) r = { state: 'tagGate', present: c.present, absent: c.absent, n: 0 };
        else r = runPair(p, ser.tags[p.tag], ser[p.y.key], days.start, days.end);
      } else {
        r = runPair(p, ser[p.x.key], ser[p.y.key], days.start, days.end);
      }
      results.push({ pair: p, result: r });
    });
    var meals = [];
    days.dates.forEach(function (d) { days.byDate[d].meals.forEach(function (m) { meals.push(m); }); });
    results.push({ pair: MEAL_PAIR, result: S.analyzeMeals(meals, HT.units ? HT.units.MGDL_PER_MMOL : 18.0156) });
    if (anyCaffeineLogged(days)) {                                        // A-010 §8.3 visibility
      var st = (opts && opts.settings) || (HT.state && HT.state.settings) || {};
      var p13 = lateCaffeinePair(cutoffOf(st), st.caffeineBedtime);
      results.push({ pair: p13, result: analyzeLate(p13, days, ser) });
      results.push({ pair: CAFFEINE_PAIR, result: runPair(CAFFEINE_PAIR, ser.caffeineMg, ser.anxiety, days.start, days.end) });
    }
    // A-003 §5.4 step 11 / A-010 §8.4: one BH family of every pair (P1–P14) that reached state C
    // in this run, so m ≤ 14. noBed / bedRange / tagGate / W never enter it.
    S.applyBH(results.map(function (x) { return x.result; }));
    var unit = (opts && opts.unit) || 'mg/dL';
    results.forEach(function (x) { x.sentence = sentence(x.pair, x.result, unit); x.detail = detail(x.pair, x.result); });
    return results;
  }

  /** Days in the window with a daily log entry (drives the "keep logging" message). */
  function loggedDayCount(days) {
    var n = 0;
    days.dates.forEach(function (d) { if (days.byDate[d].logged) n++; });
    return n;
  }

  // ---------------- screen ----------------
  var GROUPS = [
    { states: ['C+'], id: 'pt-found', heading: 'Patterns in your records' },
    { states: ['C0'], id: 'pt-c0', heading: 'No clear pattern yet' },
    { states: ['B'], id: 'pt-b', heading: 'Early look (too few days to tell)' },
    // W: A-004 M2. noBed / bedRange: P13 without a usable bedtime (A-010 §8.1).
    { states: ['V', 'W', 'A', 'tagGate', 'noBed', 'bedRange'], id: 'pt-a', heading: 'Still collecting days' }
  ];

  function render(container) {
    var T = HT.trends, el = T.el, alive = true;
    T.ensureCss();
    var root = el('div', { class: 'patterns' });
    container.appendChild(root);
    var status = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: 'Looking at your last 90 days…' });
    root.appendChild(status);

    T.ensureScript('js/stats.js', function () { return !!(HT.stats && HT.stats.analyzeDaily); }).then(function (ok) {
      if (!alive) return null;
      if (!ok) { status.textContent = 'Patterns could not be loaded.'; return null; }
      return T.data.loadDays(WINDOW_DAYS);
    }).then(function (days) {
      if (!alive || !days) return;
      var unit = (HT.state && HT.state.settings && HT.state.settings.glucoseUnit) || 'mg/dL';
      var res = analyze(days, { unit: unit });
      status.textContent = 'Based on ' + longDate(days.start) + ' to ' + longDate(days.end) + ' (last 90 days).';
      var logged = loggedDayCount(days);
      if (logged < 14) {
        var more = 14 - logged;
        root.appendChild(el('div', { class: 'banner', role: 'note' }, [
          el('p', null, [el('strong', { text: 'Keep logging — ' + more + ' more day' + (more === 1 ? '' : 's') + '.' })]),
          el('p', { text: 'You have logged ' + logged + ' of the 14 days needed before your ratings and tags can be compared with anything. Each card below counts the days that have both things recorded.' })
        ]));
      }
      root.appendChild(el('p', { class: 'small', text: 'Each card compares two things you track, on days that have both. “No clear pattern yet” means there is not enough evidence yet — not that they are unrelated.' }));
      GROUPS.forEach(function (g) {
        var items = res.filter(function (x) { return g.states.indexOf(x.result.state) >= 0; });
        if (!items.length) return;
        var sec = el('section', { 'aria-labelledby': g.id }, [el('h2', { id: g.id, text: g.heading + ' (' + items.length + ')' })]);
        var list = el('ul', { class: 'pattern-list' });
        items.forEach(function (x) {
          var li = el('li', { class: 'card pattern-card' }, [
            el('h3', { text: title(x.pair) }),
            el('p', { text: x.sentence })
          ]);
          if (x.pair.meal) li.appendChild(el('p', { class: 'small muted', text: mealNote(x.result) }));
          var ln = lateNote(x.pair, x.result);
          if (ln) li.appendChild(el('p', { class: 'small muted', text: ln }));
          if (x.detail) li.appendChild(el('details', null, [el('summary', { text: 'More detail' }), el('p', { class: 'small', text: x.detail })]));
          list.appendChild(li);
        });
        sec.appendChild(list);
        root.appendChild(sec);
      });
      root.appendChild(el('p', { class: 'small', text: FOOTER }));
      root.appendChild(el('div', { class: 'disclaimer' }, [el('p', { text: 'Not medical advice. Patterns are associations in your own records, not proof of cause, and watch measurements are estimates. Talk with a qualified health professional about health questions.' })]));
    }).catch(function () {
      if (alive) status.textContent = 'Your data could not be read on this device, so patterns can’t be shown.';
    });

    return function cleanup() { alive = false; };
  }

  HT.patterns = {
    render: render,
    analyze: analyze,
    buildSeries: buildSeries,
    sentence: sentence,
    detail: detail,
    mealNote: mealNote,
    lateNote: lateNote,
    loggedDayCount: loggedDayCount,
    runPair: runPair,
    lateCaffeinePair: lateCaffeinePair,
    bedtimeInRange: bedtimeInRange,
    PAIRS: PAIRS,
    MEAL_PAIR: MEAL_PAIR,
    CAFFEINE_PAIR: CAFFEINE_PAIR,
    FOOTER: FOOTER,
    WINDOW_DAYS: WINDOW_DAYS
  };
})(window.HT = window.HT || {});
