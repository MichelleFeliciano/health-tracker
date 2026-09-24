/* Health Tracker — stats.js
 * Pure statistics for the personal pattern engine. No DOM, no storage, no logging.
 * Build spec: docs/team/analysis/A-003-metrics-evidence-and-patterns.md §5 (authoritative),
 * summarised in docs/team/research/R-003-metrics-evidence-and-patterns.md (Revision 1).
 *
 * What is here and why (A-003 check ids in brackets):
 *  - Spearman = Pearson correlation of AVERAGE ranks [C1]. The 1 − 6Σd²/(n(n²−1)) shortcut is
 *    wrong when there are ties (0–10 ratings tie a lot), so it is never used.
 *  - Pairing is by calendar-date arithmetic in STORED dates, never by array index [C10].
 *    Sleep is stored under its wake date (R-001 §6.1), so sleep(d)↔rating(d) is lag 0 and
 *    steps(d)↔sleep(d+1) is lag +1 (A-003 §1 "Additional check").
 *  - Residuals: OLS line on day index, then weekday means removed only when every weekday has
 *    ≥ 3 values [C11, C14]. A rolling/centred mean is NOT used (it does not remove weekday
 *    effects and inflates false positives [C11, C12]).
 *  - Effective n: Bartlett's AR(1) approximation n(1 − r₁ₓr₁ᵧ)/(1 + r₁ₓr₁ᵧ) [C13, M3].
 *  - p-value: Fisher z with Fieller's null variance 1.06/(n_eff − 3) [C5].
 *  - 95% interval: Bonett–Wright variance (1 + ρ²/2)/(n_eff − 3) [C6, M4].
 *  - Multiple testing: Benjamini–Hochberg step-up, q = 0.10 [C9].
 *  - Normal CDF: Numerical Recipes erfcc (|rel. error| < 1.2e−7); Φ(1.959964) = 0.975 [§1 note].
 *
 * Series are plain objects { 'YYYY-MM-DD': number }. A date that is absent, null or NaN is
 * MISSING — never 0, never imputed, never carried forward (A-003 §5.1).
 * Classic script. Exposes window.HT.stats.
 */
(function (HT) {
  'use strict';

  var MIN_DAYS_DESCRIPTIVE = 14;   // Gate A  [DESIGN, A-003 §5.4 step 2]
  var MIN_DAYS_TEST = 30;          // Gate B  [DESIGN, step 9]
  var MIN_NEFF_TEST = 20;          // Gate B  [DESIGN, step 9]
  var MIN_GROUP = 5;               // descriptive split, per group [DESIGN, step 4]
  var MIN_PER_WEEKDAY = 3;         // weekday-mean step applies only with ≥ 3 per weekday [step 5b]
  var BH_Q = 0.10;                 // [step 11]
  var FIELLER = 1.06;              // null variance factor [C5]
  var Z975 = 1.959964;
  var RHO_CLAMP = 0.9999;

  // ---------------- dates (pure calendar arithmetic, DST-proof) ----------------
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** Days since 1970-01-01 for a 'YYYY-MM-DD' string (UTC arithmetic, so DST never matters). */
  function dayNum(s) {
    var m = DATE_RE.exec(s);
    if (!m) return NaN;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  }
  function fromDayNum(n) {
    var d = new Date(n * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function addDays(s, k) { return fromDayNum(dayNum(s) + k); }
  /** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday (4). */
  function weekday(s) { return (((dayNum(s) + 4) % 7) + 7) % 7; }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function has(series, d) { return Object.prototype.hasOwnProperty.call(series, d) && isNum(series[d]); }

  // ---------------- basic helpers ----------------
  function mean(a) {
    if (!a.length) return NaN;
    var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  /** Median; for an even count, the mean of the two middle values (A-003 §5.4 step 4). */
  function median(a) {
    if (!a.length) return NaN;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var h = b.length >> 1;
    return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
  }
  function allEqual(a) {
    for (var i = 1; i < a.length; i++) if (a[i] !== a[0]) return false;
    return true;
  }

  // ---------------- normal CDF (Numerical Recipes erfcc) ----------------
  function erfc(x) {
    var z = Math.abs(x);
    var t = 1 / (1 + z / 2);
    var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
      t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  /** Standard normal CDF. Φ(z) = 1 − erfc(z/√2)/2 for z ≥ 0, erfc(|z|/√2)/2 for z < 0. */
  function normCdf(z) {
    var e = erfc(Math.abs(z) / Math.SQRT2);
    return z >= 0 ? 1 - e / 2 : e / 2;
  }

  // ---------------- ranks and correlations ----------------
  /** Average ranks (1-based); tied values get the mean of the ranks they span. */
  function averageRanks(a) {
    var idx = a.map(function (v, i) { return i; });
    idx.sort(function (i, j) { return a[i] - a[j] || i - j; });
    var r = new Array(a.length);
    var k = 0;
    while (k < idx.length) {
      var j = k;
      while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[k]]) j++;
      var avg = (k + j) / 2 + 1;
      for (var t = k; t <= j; t++) r[idx[t]] = avg;
      k = j + 1;
    }
    return r;
  }
  /** Pearson r. NaN when either series has zero variance (A-003 C2). */
  function pearson(x, y) {
    var n = x.length;
    if (n < 2 || y.length !== n) return NaN;
    var mx = mean(x), my = mean(y), sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < n; i++) {
      var dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    // Treat floating dust as zero variance (e.g. residuals of a constant series).
    var scale = Math.max(1, Math.abs(mx), Math.abs(my));
    if (sxx <= 1e-18 * scale * scale * n || syy <= 1e-18 * scale * scale * n) return NaN;
    return sxy / Math.sqrt(sxx * syy);
  }
  /** Spearman ρ = Pearson of average ranks (A-003 C1). NaN if a series is constant. */
  function spearman(x, y) { return pearson(averageRanks(x), averageRanks(y)); }

  // ---------------- residuals (A-003 §5.4 step 5) ----------------
  /**
   * Residual series for one variable over the window.
   * a. OLS line of value on day index (0 = window start). Residual = value − fitted.
   * b. If each of the 7 weekdays has ≥ 3 residuals, subtract that weekday's mean residual.
   * Uses ALL present days of this series inside the window, not only paired days.
   * Returns { resid: {date: e}, weekdayApplied: bool, count }.
   */
  function residuals(series, winStart, winEnd) {
    var s0 = dayNum(winStart), s1 = dayNum(winEnd);
    var dates = [], idx = [], vals = [];
    Object.keys(series).forEach(function (d) {
      var n = dayNum(d);
      if (!isNaN(n) && n >= s0 && n <= s1 && isNum(series[d])) { dates.push(d); idx.push(n - s0); vals.push(series[d]); }
    });
    var out = {}, N = vals.length;
    if (!N) return { resid: out, weekdayApplied: false, count: 0 };
    var mi = mean(idx), mv = mean(vals), sxy = 0, sxx = 0;
    for (var i = 0; i < N; i++) { sxy += (idx[i] - mi) * (vals[i] - mv); sxx += (idx[i] - mi) * (idx[i] - mi); }
    var slope = sxx > 0 ? sxy / sxx : 0;
    var e = vals.map(function (v, i) { return v - (mv + slope * (idx[i] - mi)); });

    var sums = [0, 0, 0, 0, 0, 0, 0], counts = [0, 0, 0, 0, 0, 0, 0];
    var wds = dates.map(weekday);
    for (var k = 0; k < N; k++) { sums[wds[k]] += e[k]; counts[wds[k]]++; }
    var apply = counts.every(function (c) { return c >= MIN_PER_WEEKDAY; });
    for (var q = 0; q < N; q++) out[dates[q]] = apply ? e[q] - sums[wds[q]] / counts[wds[q]] : e[q];
    return { resid: out, weekdayApplied: apply, count: N };
  }

  /**
   * Lag-1 autocorrelation of a residual series (A-003 §5.4 step 7).
   * m, v over all present days (v = Σ(e − m)²/N); numerator over dates where d−1 and d are both
   * present (count c). r₁ = 0 when c < 3 or v = 0.
   */
  function lag1(resid) {
    var dates = Object.keys(resid).filter(function (d) { return isNum(resid[d]); });
    var N = dates.length;
    if (!N) return 0;
    var vals = dates.map(function (d) { return resid[d]; });
    var m = mean(vals), v = 0;
    vals.forEach(function (x) { v += (x - m) * (x - m); });
    v /= N;
    var num = 0, c = 0;
    dates.forEach(function (d) {
      var p = addDays(d, -1);
      if (has(resid, p)) { num += (resid[d] - m) * (resid[p] - m); c++; }
    });
    if (c < 3 || !(v > 0)) return 0;
    return (num / c) / v;
  }

  /** Bartlett AR(1) effective n (A-003 §5.4 step 8). */
  function effectiveN(n, r1x, r1y) {
    var p1 = r1x * r1y;
    if (!(p1 > 0)) return n;
    return n * (1 - p1) / (1 + p1);
  }

  /** Two-sided p for ρ = 0 via Fisher z with Fieller's null variance 1.06/(n − 3). */
  function fisherP(rho, n) {
    if (!(n > 3)) return NaN;
    var r = Math.max(-RHO_CLAMP, Math.min(RHO_CLAMP, rho));
    var z = atanh(r);
    return 2 * (1 - normCdf(Math.abs(z) * Math.sqrt((n - 3) / FIELLER)));
  }
  /** 95% CI with the Bonett–Wright variance (1 + ρ²/2)/(n − 3). */
  function bonettWrightCI(rho, n) {
    if (!(n > 3)) return [NaN, NaN];
    var r = Math.max(-RHO_CLAMP, Math.min(RHO_CLAMP, rho));
    var z = atanh(r), se = Math.sqrt((1 + r * r / 2) / (n - 3));
    return [Math.tanh(z - Z975 * se), Math.tanh(z + Z975 * se)];
  }
  function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }

  /**
   * Benjamini–Hochberg step-up. Returns an array of booleans (true = rejected = "pattern"),
   * aligned with the input. Largest k with p(k) ≤ (k/m)·q; the k smallest p are rejected.
   */
  function benjaminiHochberg(pvals, q) {
    q = q == null ? BH_Q : q;
    var m = pvals.length, out = pvals.map(function () { return false; });
    if (!m) return out;
    var order = pvals.map(function (p, i) { return i; }).filter(function (i) { return isNum(pvals[i]); });
    order.sort(function (a, b) { return pvals[a] - pvals[b] || a - b; });
    var kmax = 0;
    for (var k = 1; k <= order.length; k++) if (pvals[order[k - 1]] <= (k / m) * q) kmax = k;
    for (var j = 0; j < kmax; j++) out[order[j]] = true;
    return out;
  }

  // ---------------- pairing (A-003 §5.4 step 1) ----------------
  /**
   * Every date d in the window where x(d) and y(d + lag) are both present and d + lag is in the
   * window too. Date arithmetic only. Returns [{d, dy, x, y}] in date order.
   */
  function pairByDate(x, y, lag, winStart, winEnd) {
    var s0 = dayNum(winStart), s1 = dayNum(winEnd), out = [];
    for (var n = s0; n <= s1; n++) {
      var d = fromDayNum(n), ny = n + lag;
      if (ny < s0 || ny > s1) continue;
      var dy = fromDayNum(ny);
      if (has(x, d) && has(y, dy)) out.push({ d: d, dy: dy, x: x[d], y: y[dy] });
    }
    return out;
  }

  /** Round to 9 decimal places (A-003 Errata 2 E2: tie-safe ranking of residuals). */
  function q9(v) { return Math.round(v * 1e9) / 1e9; }

  /**
   * True when, for every weekday, all of the tag's present values in the window are equal
   * (e.g. "Work / school" on every Mon–Fri). A-003 step 5c / A-004 M2.
   */
  function tagFixedByWeekday(series, winStart, winEnd) {
    var s0 = dayNum(winStart), s1 = dayNum(winEnd), seen = [null, null, null, null, null, null, null];
    var keys = Object.keys(series);
    for (var i = 0; i < keys.length; i++) {
      var d = keys[i], n = dayNum(d);
      if (isNaN(n) || n < s0 || n > s1 || !isNum(series[d])) continue;
      var w = weekday(d);
      if (seen[w] === null) seen[w] = series[d];
      else if (seen[w] !== series[d]) return false;
    }
    return true;
  }

  // ---------------- daily pair analysis (A-003 §5.4 steps 1–10) ----------------
  /**
   * opts: { x, y, lag, start, end, tag: bool }
   * Returns a result object; `state` is one of:
   *   'A' (n < 14), 'V' (no variation), 'W' (tag fixed by weekday; step 5c, never tested),
   *   'B' (descriptive), 'C' (tested; BH decides C+ / C0 later).
   * For tag X, the caller checks the ≥ 5 present / ≥ 5 absent rule first (A-003 §5.2).
   */
  function analyzeDaily(opts) {
    var lag = opts.lag || 0;
    var pairs = pairByDate(opts.x, opts.y, lag, opts.start, opts.end);
    var n = pairs.length;
    var res = { state: 'A', n: n, lag: lag, start: opts.start, end: opts.end,
      firstDate: n ? pairs[0].d : null, lastDate: n ? pairs[n - 1].d : null };
    if (n < MIN_DAYS_DESCRIPTIVE) return res;

    var px = pairs.map(function (p) { return p.x; }), py = pairs.map(function (p) { return p.y; });
    if (allEqual(px) || allEqual(py)) {
      res.state = 'V'; res.constant = allEqual(px) ? 'x' : 'y';
      res.constantValue = res.constant === 'x' ? px[0] : py[0];   // lets the tag V sentence say marked / not marked
      return res;
    }

    // Descriptive split on RAW paired values (step 4).
    var m = opts.tag ? 0.5 : median(px);
    var yl = [], yh = [];
    pairs.forEach(function (p) { if (p.x < m) yl.push(p.y); else yh.push(p.y); });
    res.median = opts.tag ? null : m;
    res.nL = yl.length; res.nH = yh.length;
    res.meanL = yl.length ? mean(yl) : NaN; res.meanH = yh.length ? mean(yh) : NaN;
    res.groupsOk = yl.length >= MIN_GROUP && yh.length >= MIN_GROUP;

    // Residuals of each whole series in the window (step 5).
    var rx = residuals(opts.x, opts.start, opts.end), ry = residuals(opts.y, opts.start, opts.end);
    // Step 5c (A-003 Errata 2 E4 / A-004 M2): a tag marked on the same weekdays every week is
    // removed entirely by the weekday step, so it can never be told apart from the weekday.
    // More days would not change that, so it gets its own state instead of C0.
    if (opts.tag && rx.weekdayApplied && tagFixedByWeekday(opts.x, opts.start, opts.end)) {
      res.state = 'W'; return res;
    }
    // Step 6 with E2: round residuals to 9 decimals so exact ties (integer 0–10 ratings tie a
    // lot) are not broken by floating-point noise (A-004 M1/K13). Residual noise is ≤ 1e−12;
    // genuine differences in this data are ≥ ~1e−6.
    var ex = pairs.map(function (p) { return q9(rx.resid[p.d]); });
    var ey = pairs.map(function (p) { return q9(ry.resid[p.dy]); });
    var rho = spearman(ex, ey);                                         // step 6
    if (!isNum(rho)) { res.state = 'V'; res.constant = 'residual'; return res; }
    res.rho = rho;
    res.weekdayApplied = { x: rx.weekdayApplied, y: ry.weekdayApplied };
    res.r1x = lag1(rx.resid); res.r1y = lag1(ry.resid);               // step 7
    res.nEff = effectiveN(n, res.r1x, res.r1y);                        // step 8
    if (n < MIN_DAYS_TEST || res.nEff < MIN_NEFF_TEST) { res.state = 'B'; return res; } // step 9
    res.p = fisherP(rho, res.nEff);                                    // step 10
    var ci = bonettWrightCI(rho, res.nEff);
    res.lo = ci[0]; res.hi = ci[1];
    res.state = 'C';
    res.direction = rho > 0 ? 'higher' : 'lower';                      // step 12
    return res;
  }

  // ---------------- meal pair P12 (A-003 §5.5) ----------------
  var CARB_CODE = { low: 1, med: 2, high: 3 };
  var LINK_MIN = 60, LINK_MAX = 120;   // minutes after meal start (ADA post-meal timing, G3)

  function hhmmToMin(s) {
    var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s || '');
    return m ? +m[1] * 60 + +m[2] : NaN;
  }
  /**
   * The linked glucose reading of a meal, if it was taken 60–120 min after the meal start.
   * The reading time is read from glucose.time ("HH:MM") or glucose.minutesAfter (number).
   * A reading with no known time is NOT used ("No other readings are used", A-003 §5.5).
   * Returns exact mg/dL (for ranking; display converts with HT.units) or null.
   */
  function linkedGlucoseMgdl(meal, mgdlPerMmol) {
    var g = meal && meal.glucose;
    if (!g || !isNum(g.value)) return null;
    var after = NaN;
    if (isNum(g.minutesAfter)) after = g.minutesAfter;
    else if (typeof g.time === 'string') {
      var mt = hhmmToMin(meal.time), gt = hhmmToMin(g.time);
      if (isNum(mt) && isNum(gt)) { after = gt - mt; if (after < 0) after += 1440; }
    }
    if (!(after >= LINK_MIN && after <= LINK_MAX)) return null;
    if (g.unit === 'mg/dL') return g.value;
    if (g.unit === 'mmol/L') return g.value * mgdlPerMmol;
    return null;
  }

  /**
   * meals: meal records in the window. Gates counted in meals: < 14 → A; 14–29 → B; ≥ 30 → C.
   * No detrending and no n_eff (n_eff = n).
   */
  function analyzeMeals(meals, mgdlPerMmol) {
    var rows = [];
    (meals || []).forEach(function (m) {
      var c = CARB_CODE[m.carb];
      if (!c) return;
      var g = linkedGlucoseMgdl(m, mgdlPerMmol || 18.0156);
      if (g === null) return;
      rows.push({ date: m.date, carb: c, g: g });
    });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var n = rows.length;
    var res = { state: 'A', n: n, firstDate: n ? rows[0].date : null, lastDate: n ? rows[n - 1].date : null };
    if (n < MIN_DAYS_DESCRIPTIVE) return res;
    var cx = rows.map(function (r) { return r.carb; }), gy = rows.map(function (r) { return r.g; });
    if (allEqual(cx) || allEqual(gy)) { res.state = 'V'; res.constant = allEqual(cx) ? 'x' : 'y'; return res; }
    res.byCarb = {};
    [['low', 1], ['med', 2], ['high', 3]].forEach(function (k) {
      var vals = rows.filter(function (r) { return r.carb === k[1]; }).map(function (r) { return r.g; });
      res.byCarb[k[0]] = { n: vals.length, meanMgdl: vals.length ? mean(vals) : NaN };
    });
    var rho = spearman(cx, gy);
    if (!isNum(rho)) { res.state = 'V'; return res; }
    res.rho = rho; res.nEff = n;
    if (n < MIN_DAYS_TEST) { res.state = 'B'; return res; }
    res.p = fisherP(rho, n);
    var ci = bonettWrightCI(rho, n);
    res.lo = ci[0]; res.hi = ci[1];
    res.state = 'C';
    res.direction = rho > 0 ? 'higher' : 'lower';
    return res;
  }

  /**
   * Apply BH (q = 0.10) across every result that reached state C in this run (A-003 step 11).
   * Mutates each result: state becomes 'C+' (pattern) or 'C0' (no clear pattern yet).
   */
  function applyBH(results, q) {
    var tested = results.filter(function (r) { return r && r.state === 'C'; });
    var rej = benjaminiHochberg(tested.map(function (r) { return r.p; }), q);
    tested.forEach(function (r, i) { r.state = rej[i] ? 'C+' : 'C0'; r.bhM = tested.length; });
    return results;
  }

  HT.stats = {
    MIN_DAYS_DESCRIPTIVE: MIN_DAYS_DESCRIPTIVE,
    MIN_DAYS_TEST: MIN_DAYS_TEST,
    MIN_NEFF_TEST: MIN_NEFF_TEST,
    MIN_GROUP: MIN_GROUP,
    BH_Q: BH_Q,
    LINK_MIN: LINK_MIN,
    LINK_MAX: LINK_MAX,
    dayNum: dayNum,
    fromDayNum: fromDayNum,
    addDays: addDays,
    weekday: weekday,
    mean: mean,
    median: median,
    erfc: erfc,
    normCdf: normCdf,
    averageRanks: averageRanks,
    pearson: pearson,
    spearman: spearman,
    residuals: residuals,
    lag1: lag1,
    effectiveN: effectiveN,
    fisherP: fisherP,
    bonettWrightCI: bonettWrightCI,
    benjaminiHochberg: benjaminiHochberg,
    pairByDate: pairByDate,
    analyzeDaily: analyzeDaily,
    q9: q9,
    tagFixedByWeekday: tagFixedByWeekday,
    linkedGlucoseMgdl: linkedGlucoseMgdl,
    analyzeMeals: analyzeMeals,
    applyBH: applyBH
  };
})(window.HT = window.HT || {});
