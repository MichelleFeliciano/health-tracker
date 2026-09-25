/* Health Tracker — caffeine-core.js
 * PURE caffeine logic (no DOM, no IndexedDB, no clock): presets, mg arithmetic, units,
 * input parsing, day totals and the baseline phase. Dates always come in as parameters
 * ('YYYY-MM-DD' strings), so every result is reproducible in tests.
 *
 * Sources (all Analyst-verified):
 *  - Presets: docs/team/analysis/A-008-caffeine-content.md §7 (build source of truth,
 *    decisions.md 2026-09-25), encoded per docs/team/analysis/A-010-caffeine-spec.md §2.
 *  - Unit factor: 1 US fl oz = 29.5735295625 mL exactly (A-008 §3; NIST HB 44 App. C).
 *  - Scaling and rounding: A-010 §2 (V6–V8: JavaScript Math.round equals exact half-up).
 *  - Baseline: A-010 §3 (V5) and decisions.md 2026-09-25 "Caffeine baseline period".
 *  - Wording W1–W3 (A-008 §5) and W12–W13 (A-010 §6) are verbatim.
 *  - Batch B: taper plan (A-009 §3(a); A-010 §4), late-caffeine window (A-010 §5), withdrawal
 *    marks (A-010 §10), wording W4–W11 (A-009 §3; A-010 §6), verbatim.
 * Classic script. Exposes window.HT.caffeineCore. Never logs entries.
 */
(function (HT) {
  'use strict';

  // 1 US fl oz = 231 in³ / 128 × 2.54³ cm³ = 29.5735295625 mL, exact (A-008 §3). FDA's 30 mL
  // labelling convention is never used for conversions.
  var FL_OZ_ML = 29.5735295625;
  var CHECKED = '2026-09-25';              // checkedDate of every preset (A-008 §7)
  var MG_MAX = 3000;                       // per-entry typo guard (D7), never shown as guidance
  var NAME_MAX = 80;
  var DRINKS_MAX = 50;                     // UI cap on adding saved drinks (A-010 §1.4)
  var QUICK_MAX = 6;                       // quick-add buttons on Today (A-010 §6)
  var BASELINE_DAYS = 7;                   // recommended baseline (decisions.md 2026-09-25)
  var BASELINE_MIN = 3;                    // minimum before a plan can start (user's choice)

  // Approved wording, verbatim. W1–W3: A-008 §5. W12, W13: A-010 §6.
  var TEXT = {
    W1: 'Caffeine amounts are estimates from public food databases and product labels. Drinks vary, sometimes a lot, so edit any amount if you know your drink. This app is a personal wellness log. It does not diagnose, treat or prevent any condition and does not give medical advice. If you are pregnant, trying to become pregnant or breastfeeding, take any medicines, or have a health condition, it may be helpful to talk with a healthcare professional about caffeine.',
    W2: 'Some medicines that contain caffeine also contain other active ingredients. This app counts only the caffeine. Follow the package label, and ask a pharmacist if you have questions.',
    W3: 'Enter mg from the label. In one survey of 100 popular pre-workouts, the average caffeine listed was about 254 mg per serving, with a wide spread.',
    W12: 'Enter mg from the label.',
    W13: 'estimate, check your label'
  };

  // Validation messages (A-010 §6). W12 is used for an empty label-only mg field.
  var MSG = {
    time: 'Enter a time for this drink.',
    name: 'Enter a name for this drink.',
    flOz: 'Enter the amount in fl oz, like 12 or 8.4.',
    mL: 'Enter the amount in mL, like 355.',
    count: 'Enter how many, in halves if needed, like 1 or 1.5.',
    mg: 'Enter the caffeine as a whole number of mg.',
    mgMax: 'That’s more than 3,000 mg in one entry. Check the number.'
  };

  // Picker groups, in display order (A-008 §7 table order).
  var GROUPS = ['Coffee', 'Coffee shop sizes', 'Tea', 'Soft drinks', 'Energy drinks and shots',
    'Chocolate and cocoa', 'Other', 'Medicines and caffeine tablets'];

  // ---------- presets (A-008 §7; A-010 §2) ----------
  // kind 'volume': mg = Math.round(mgRef * amountMl / mLRef), mLRef an integer.
  // kind 'count':  mg = Math.round(mgRef * count), count in halves 0.5–20, default 1.
  // mgRef null = label-only: the user enters mg (volume) or mg per unit (count).
  // def: 'prefill' | 'estimate' ("estimate, check your label" + range shown) | 'label'.
  // Brand sizes and espresso are count-based and never scale by volume (A-008 RC-3).
  function V(id, label, group, mLRef, mgRef, range, conf, source, def, extra) {
    return mk({ id: id, label: label, group: group, kind: 'volume', mLRef: mLRef, mgRef: mgRef, range: range, confidence: conf, source: source, def: def }, extra);
  }
  function C(id, label, group, unit, mgRef, range, conf, source, def, extra) {
    return mk({ id: id, label: label, group: group, kind: 'count', unit: unit, mgRef: mgRef, range: range, confidence: conf, source: source, def: def }, extra);
  }
  function mk(o, extra) {
    o.checkedDate = CHECKED;
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  var SB = 'starbucks.com product nutrition data (“Caffeine is an approximate value”)';
  var DK = 'Dunkin’ newsroom, 2020-09-22 (cup size not stated)';
  var PRESETS = [
    // Coffee
    V('coffee-brewed', 'Brewed coffee', 'Coffee', 237, 135, '75–179 mg', 'Medium', 'Health Canada, Caffeine in foods (Table 2); FDA, Spilling the Beans (113–247 mg per 12 fl oz); USDA FoodData Central 171890 (lab average 95 mg)', 'prefill'),
    V('coffee-instant', 'Instant coffee, made', 'Coffee', 237, 76, '62–106 mg', 'Medium', 'Health Canada, Caffeine in foods; USDA FoodData Central 174130', 'prefill'),
    C('coffee-instant-powder', 'Instant coffee powder', 'Coffee', 'teaspoon, about 1 g', 31, null, 'Medium', 'USDA FoodData Central 171893', 'prefill'),
    C('espresso-single', 'Espresso, 1 shot', 'Coffee', 'shot', 63, 'up to 322 mg measured', 'Medium (range Low)', 'USDA FoodData Central 171891; Crozier 2012', 'estimate'),
    C('espresso-double', 'Espresso, 2 shots', 'Coffee', 'double shot', 126, 'up to 322 mg per shot measured', 'Medium (range Low)', 'USDA FoodData Central 171891', 'estimate'),
    V('coffee-decaf', 'Decaf coffee', 'Coffee', 237, 3, '2–15 mg', 'High', 'Health Canada; FDA; McCusker 2006', 'prefill'),
    C('espresso-decaf', 'Decaf espresso, 1 shot', 'Coffee', 'shot', 9, '0–16 mg', 'Low', 'McCusker 2006 (3.0–15.8 mg); USDA FoodData Central 174125', 'estimate'),
    V('coffee-cold-brew', 'Cold brew (other)', 'Coffee', 355, null, null, 'Low', 'No verified value; check your label', 'label'),
    // Coffee shop sizes
    C('sbux-pike-short', 'Starbucks Pike Place, Short (8 fl oz)', 'Coffee shop sizes', 'cup', 155, '155–195 mg', 'Medium', SB, 'estimate'),
    C('sbux-pike-tall', 'Starbucks Pike Place, Tall (12 fl oz)', 'Coffee shop sizes', 'cup', 235, '235–290 mg', 'Medium', SB, 'estimate'),
    C('sbux-pike-grande', 'Starbucks Pike Place, Grande (16 fl oz)', 'Coffee shop sizes', 'cup', 315, '315–390 mg', 'Medium', SB, 'estimate'),
    C('sbux-pike-venti', 'Starbucks Pike Place, Venti (20 fl oz)', 'Coffee shop sizes', 'cup', 390, '390–490 mg', 'Medium', SB, 'estimate'),
    C('sbux-coldbrew-tall', 'Starbucks Cold Brew, Tall (12 fl oz)', 'Coffee shop sizes', 'cup', 155, null, 'Medium', SB, 'estimate'),
    C('sbux-coldbrew-grande', 'Starbucks Cold Brew, Grande (16 fl oz)', 'Coffee shop sizes', 'cup', 205, null, 'Medium', SB, 'estimate'),
    C('sbux-coldbrew-venti', 'Starbucks Cold Brew, Venti (24 fl oz)', 'Coffee shop sizes', 'cup', 310, null, 'Medium', SB, 'estimate'),
    C('sbux-coldbrew-trenta', 'Starbucks Cold Brew, Trenta (30 fl oz)', 'Coffee shop sizes', 'cup', 360, null, 'Medium', SB, 'estimate'),
    C('dunkin-hot-small', 'Dunkin’ hot coffee, small', 'Coffee shop sizes', 'cup', 180, null, 'Low', DK, 'estimate'),
    C('dunkin-hot-xl', 'Dunkin’ hot coffee, extra-large', 'Coffee shop sizes', 'cup', 330, null, 'Low', DK, 'estimate'),
    C('dunkin-iced-small', 'Dunkin’ iced coffee, small', 'Coffee shop sizes', 'cup', 198, null, 'Low', DK, 'estimate'),
    C('dunkin-iced-large', 'Dunkin’ iced coffee, large', 'Coffee shop sizes', 'cup', 398, null, 'Low', DK, 'estimate'),
    // Tea
    V('tea-black', 'Black tea', 'Tea', 237, 47, '14–61 mg', 'High', 'USDA FoodData Central 173227; FDA; Health Canada; Chin 2008', 'prefill'),
    V('tea-green', 'Green tea', 'Tea', 237, 28, '19–43 mg', 'High', 'USDA FoodData Central 171917 (8 fl oz basis); FDA; Health Canada', 'prefill'),
    V('tea-oolong', 'Oolong tea', 'Tea', 237, 38, '33–45 mg', 'Low', 'USDA FoodData Central 174120 (2 samples)', 'estimate'),
    V('tea-white', 'White tea', 'Tea', 237, 28, '14–61 mg', 'Low', 'Chin 2008 (no trend by tea type); green-tea value used', 'estimate'),
    C('tea-matcha', 'Matcha', 'Tea', 'serving', null, null, 'Low', 'No verified value; check your label', 'label'),
    V('tea-herbal', 'Herbal tea (not yerba mate, guayusa or guarana)', 'Tea', 237, 0, '0 mg', 'High', 'Chin 2008; USDA FoodData Central 171946', 'prefill'),
    V('tea-decaf', 'Decaf tea', 'Tea', 237, 0, '0 to under 12 mg', 'Medium', 'Health Canada; Chin 2008', 'prefill'),
    V('tea-iced-bottled', 'Bottled iced tea', 'Tea', 355, 39, '7–39 mg', 'Low', 'USDA FoodData Central 174144 and related entries (derived values)', 'estimate'),
    // Soft drinks
    V('cola', 'Cola (Coca-Cola or similar)', 'Soft drinks', 355, 34, '33–46 mg', 'High', 'Coca-Cola US FAQ; Chou 2007; USDA FoodData Central 174852; Health Canada', 'prefill'),
    V('diet-coke', 'Diet Coke', 'Soft drinks', 355, 46, '39–50 mg', 'High', 'Coca-Cola US FAQ; Chou 2007; Health Canada', 'prefill'),
    V('pepsi', 'Pepsi', 'Soft drinks', 355, 38, null, 'High', 'PepsiCo Product Facts; Chou 2007 (38.9 mg)', 'prefill'),
    V('diet-pepsi', 'Diet Pepsi', 'Soft drinks', 355, 35, null, 'High', 'PepsiCo Product Facts; Chou 2007 (36.7 mg)', 'prefill'),
    V('mountain-dew', 'Mountain Dew', 'Soft drinks', 355, 54, '54–55 mg', 'High', 'PepsiCo Product Facts; Chou 2007', 'prefill'),
    V('dr-pepper', 'Dr Pepper', 'Soft drinks', 355, 43, null, 'Medium (2007 data)', 'Chou 2007', 'estimate'),
    V('root-beer', 'Root beer', 'Soft drinks', 355, 0, 'some brands contain caffeine', 'Medium', 'USDA FoodData Central 171871 (1 sample, 1986)', 'estimate'),
    // Energy drinks and shots
    C('red-bull', 'Red Bull, 8.4 fl oz can', 'Energy drinks and shots', '8.4 fl oz can', 80, '75–80 mg', 'High', 'Red Bull US label; USDA FoodData Central 173210', 'prefill'),
    V('energy-generic', 'Energy drink (other)', 'Energy drinks and shots', 473, null, '54–328 mg per 16 fl oz (FDA)', 'Low', 'FDA, Spilling the Beans', 'label'),
    C('five-hour-regular', '5-hour ENERGY Regular', 'Energy drinks and shots', '1.93 fl oz shot', 200, null, 'Medium (label)', '5-hour ENERGY, Caffeine Facts', 'prefill'),
    C('five-hour-extra', '5-hour ENERGY Extra Strength', 'Energy drinks and shots', '1.93 fl oz shot', 230, null, 'Medium (label)', '5-hour ENERGY, Caffeine Facts', 'prefill'),
    // Chocolate and cocoa (portion counts, D4)
    C('choc-dark-60', 'Dark chocolate 60–69%', 'Chocolate and cocoa', '1 oz piece, 28 g', 24, '20–28 mg', 'Medium', 'USDA FoodData Central 170272', 'prefill'),
    C('choc-dark-70', 'Dark chocolate 70–85%', 'Chocolate and cocoa', '1 oz piece, 28 g', 23, null, 'Medium', 'USDA FoodData Central 170273 (2 samples)', 'prefill'),
    C('choc-milk', 'Milk chocolate', 'Chocolate and cocoa', '1 oz piece, 28 g', 7, null, 'Medium', 'Health Canada', 'prefill'),
    V('hot-cocoa', 'Hot cocoa (1 packet)', 'Chocolate and cocoa', 237, 5, null, 'Medium', 'Health Canada', 'prefill'),
    V('chocolate-milk', 'Chocolate milk', 'Chocolate and cocoa', 237, 8, null, 'Medium', 'Health Canada', 'prefill'),
    // Other (label-only)
    C('gum', 'Caffeinated gum', 'Other', 'piece', null, null, 'Low', 'FDA lists gum as a source; no verified value', 'label'),
    C('water-caffeinated', 'Caffeinated water', 'Other', 'bottle', null, null, 'Low', 'No verified value; check your label', 'label'),
    C('preworkout', 'Pre-workout', 'Other', 'serving', null, null, 'Low', 'Jagim 2019', 'label', { hint: 'preworkout' }),
    // Medicines and caffeine tablets (OTC; count default 1, never the label's dose — A-008 W6)
    C('nodoz-max', 'NoDoz Maximum Strength caplet', 'Medicines and caffeine tablets', 'caplet', 200, null, 'High', 'DailyMed, NoDoz Maximum Strength (SPL v6, effective 2022-04-20)', 'prefill', { otc: true }),
    C('excedrin-es', 'Excedrin Extra Strength caplet', 'Medicines and caffeine tablets', 'caplet', 65, null, 'High', 'DailyMed, Excedrin Extra Strength (effective 2024-04-22)', 'prefill', { otc: true }),
    C('caffeine-tablet-200', 'Caffeine tablet 200 mg', 'Medicines and caffeine tablets', 'tablet', 200, null, 'High', 'DailyMed, Alertness Aid 200 mg tablets', 'prefill', { otc: true })
  ];
  var BY_ID = {};
  PRESETS.forEach(function (p) { BY_ID[p.id] = p; });
  function presetById(id) { return (typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id)) ? BY_ID[id] : null; }
  function isLabelOnly(p) { return !!p && p.mgRef === null; }

  // ---------- arithmetic (A-010 §2) ----------
  /** fl oz → mL stored to 0.1 mL (exact half-up in doubles, V7). */
  function flOzToMl(flOz) { return Math.round(flOz * FL_OZ_ML * 10) / 10; }
  /** mL → fl oz for display, 1 decimal (V7; a one-decimal tie is impossible for 0.1 mL steps). */
  function mlToFlOz(ml) { return Math.round(ml / FL_OZ_ML * 10) / 10; }
  /** Volume preset: mg = round(mgRef × mL / mLRef) (V6). */
  function volumeMg(p, ml) { return Math.round(p.mgRef * ml / p.mLRef); }
  /** Count preset: mg = round(mgRef × count) (V8), also mg per unit × count for label-only. */
  function countMg(mgRef, count) { return Math.round(mgRef * count); }
  /** Prefill mg for a preset and an amount { amountMl } | { count }; null for label-only. */
  function presetMg(p, amount) {
    if (!p || p.mgRef === null) return null;
    if (p.kind === 'volume') return volumeMg(p, amount && typeof amount.amountMl === 'number' ? amount.amountMl : p.mLRef);
    return countMg(p.mgRef, amount && typeof amount.count === 'number' ? amount.count : 1);
  }
  /** The amount an untouched preset stores: amountMl = mLRef exactly (237, not 236.6), count 1. */
  function defaultAmount(p) { return p.kind === 'volume' ? { amountMl: p.mLRef } : { count: 1 }; }

  // ---------- input parsing (A-010 §6 validation) ----------
  function norm(text) { return String(text == null ? '' : text).trim(); }
  function num(t) { return Number(t.replace(',', '.')); }
  /** Volume in the chosen unit → { ok, ml } | { ok:false, error }. Up to 1 decimal; '.' or ','. */
  function parseVolume(text, unit) {
    var t = norm(text);
    if (unit === 'mL') {
      if (!/^[0-9]{1,4}([.,][0-9])?$/.test(t)) return { ok: false, error: MSG.mL };
      var ml = num(t);
      if (!(ml >= 0.1 && ml <= 3000)) return { ok: false, error: MSG.mL };
      return { ok: true, ml: Math.round(ml * 10) / 10 };
    }
    if (!/^[0-9]{1,3}([.,][0-9])?$/.test(t)) return { ok: false, error: MSG.flOz };
    var fl = num(t);
    if (!(fl >= 0.1 && fl <= 101.4)) return { ok: false, error: MSG.flOz };
    return { ok: true, ml: flOzToMl(fl) };
  }
  /** Count in halves, 0.5–20. */
  function parseCount(text) {
    var t = norm(text);
    if (!/^[0-9]{1,2}([.,][05])?$/.test(t)) return { ok: false, error: MSG.count };
    var c = num(t);
    if (!(c >= 0.5 && c <= 20)) return { ok: false, error: MSG.count };
    return { ok: true, count: c };
  }
  /** Whole mg, ASCII digits only; empty → { ok:false, empty:true }. */
  function parseMg(text) {
    var t = norm(text);
    if (t === '') return { ok: false, empty: true, error: MSG.mg };
    if (!/^[0-9]{1,6}$/.test(t)) return { ok: false, error: MSG.mg };
    var n = parseInt(t, 10);
    if (n > MG_MAX) return { ok: false, error: MSG.mgMax };
    return { ok: true, mg: n };
  }
  function parseName(text) {
    var t = norm(text).slice(0, NAME_MAX);
    return t ? { ok: true, name: t } : { ok: false, error: MSG.name };
  }
  /** Text shown in an amount field for a stored mL value. */
  function volumeText(ml, unit) { return unit === 'mL' ? String(ml) : mlToFlOz(ml).toFixed(1); }
  function countText(c) { return String(c); }

  // ---------- display ----------
  function fmtInt(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }
  function mgText(mg) { return 'about ' + fmtInt(mg) + ' mg'; }
  /** Amount of an entry or drink for display, or '' when unknown. unit: 'fl oz' | 'mL'. */
  function formatAmount(rec, unit) {
    if (!rec) return '';
    if (typeof rec.amountMl === 'number') return unit === 'mL' ? rec.amountMl + ' mL' : mlToFlOz(rec.amountMl).toFixed(1) + ' fl oz';
    if (typeof rec.amountG === 'number') return rec.amountG + ' g';
    if (typeof rec.count === 'number') {
      var p = presetById(rec.presetId), u = p && p.unit ? p.unit : null;
      if (!u) return '× ' + rec.count;
      return rec.count === 1 ? '1 ' + u : rec.count + ' × ' + u;
    }
    return '';
  }
  /** "{label} · {amount} · about {mg} mg" (amount left out when unknown). */
  function describe(rec, unit) {
    var a = formatAmount(rec, unit);
    return rec.label + (a ? ' · ' + a : '') + ' · ' + mgText(rec.mg);
  }

  // ---------- day totals (A-010 §1.3 precedence) ----------
  /**
   * entries: that day's entries; dayRec: its caffeineDays record or null/undefined.
   * A date with at least one entry is an entries day, whatever `none` says; `none` only
   * matters on a date with no entries (then mg = 0). Unlogged → logged:false, mg:null.
   */
  function dayTotal(entries, dayRec) {
    var list = entries || [], d = dayRec || {};
    var sum = 0;
    list.forEach(function (e) { sum += e.mg; });
    var none = list.length === 0 && d.none === true;
    var logged = list.length > 0 || none;
    return { logged: logged, mg: logged ? sum : null, none: none, count: list.length,
      headache: d.headache === true, tired: d.tired === true };
  }

  // ---------- baseline phase (A-010 §3) ----------
  /**
   * The counted baseline days: local dates d with start <= d <= today − 1 that are
   * caffeine-logged (an entry, or a caffeineDays record with none === true), in date order,
   * FIRST 7 only (D3). Today never counts; unlogged dates never count (a gap just isn't
   * counted). String comparison is safe for 'YYYY-MM-DD'.
   */
  function countedBaselineDays(start, today, entries, dayRecs) {
    var seen = {};
    (entries || []).forEach(function (e) { if (e.date >= start && e.date < today) seen[e.date] = true; });
    (dayRecs || []).forEach(function (d) { if (d && d.none === true && d.date >= start && d.date < today) seen[d.date] = true; });
    return Object.keys(seen).sort().slice(0, BASELINE_DAYS);
  }
  /** Integer half-up average floor((2·sum + n)/(2·n)) (V5; equals exact half-up for n ≤ 7). */
  function baselineAverage(sum, n) { return n > 0 ? Math.floor((2 * sum + n) / (2 * n)) : null; }
  /** { days, n, sum, avg } for a baseline starting on `start`, computed live. */
  function baselineSummary(start, today, entries, dayRecs) {
    var days = countedBaselineDays(start, today, entries, dayRecs);
    var inWindow = {};
    days.forEach(function (d) { inWindow[d] = true; });
    var sum = 0;
    (entries || []).forEach(function (e) { if (inWindow[e.date]) sum += e.mg; });   // a `none` day adds 0
    return { days: days, n: days.length, sum: sum, avg: baselineAverage(sum, days.length) };
  }
  var BASE_TEXT = {
    n0: 'Tracking your usual amount. A day counts once it\'s over, if you logged caffeine or tapped “No caffeine today”.',
    zero: 'Your usual amount is 0 mg, so there is nothing to cut down.',
    startNow: 'Start my plan now',
    keep: 'Keep tracking to 7 days (recommended)',
    start: 'Start my plan'
  };
  /**
   * What the baseline status shows (§3 UI states). opts.offerHidden = the user chose "Keep
   * tracking" today (the offer is hidden for the rest of that local date; Settings passes false).
   * Returns { text, buttons: [] of 'startNow' | 'keep' | 'start' }.
   */
  function baselineView(sum, opts) {
    var n = sum.n, X = sum.avg;
    if (n === 0) return { text: BASE_TEXT.n0, buttons: [] };
    if (n >= BASELINE_MIN && X === 0) return { text: BASE_TEXT.zero, buttons: [] };   // B4: no plan is possible
    if (n >= BASELINE_DAYS) return { text: 'Your usual amount: about ' + fmtInt(X) + ' mg a day, from 7 days.', buttons: ['start'] };
    var line = 'Your usual amount so far: about ' + fmtInt(X) + ' mg a day (' + n + ' of 7 days).';
    if (n < BASELINE_MIN) return { text: line + ' You can start a plan after 3 days.', buttons: [] };
    return { text: line, buttons: (opts && opts.offerHidden) ? [] : ['startNow', 'keep'] };
  }
  /** A new plan record in the baseline phase, starting today (D2: no backdating). */
  function newBaselinePlan(today) {
    return { key: 'plan', status: 'baseline', baselineStartDate: today, baselineDays: [], baselineMg: null,
      goalMg: null, pct: 25, targets: [], currentTargetMg: null, targetSince: null, startDate: null, endDate: null,
      history: [{ date: today, action: 'baseline-start', fromMg: null, toMg: null }] };
  }
  /** "Start the baseline again": baselineStartDate = today, history baseline-start; nothing else kept. */
  function restartBaseline(plan, today) {
    var p = newBaselinePlan(today);
    var hist = plan && Array.isArray(plan.history) ? plan.history.slice() : [];
    p.history = hist.concat(p.history);
    // A-011 item 3: same cap as pushHist (oldest dropped), so the new baseline-start survives sanitize.
    if (p.history.length > HISTORY_MAX) p.history.splice(0, p.history.length - HISTORY_MAX);
    if (plan && plan.createdAt) p.createdAt = plan.createdAt;
    return p;
  }

  // ---------- My drinks ----------
  function amountOf(rec) {
    var o = {};
    ['amountMl', 'amountG', 'count'].some(function (k) { if (typeof rec[k] === 'number') { o[k] = rec[k]; return true; } return false; });
    return o;
  }
  /** Quick add: one tap logs the drink as a USER entry (A-010 §6 item 4). */
  function entryFromDrink(drink, date, time, id) {
    var e = { id: id, date: date, time: time, presetId: drink.presetId || null, label: drink.label, mg: drink.mg,
      source: 'user', checkedDate: null };
    var a = amountOf(drink);
    Object.keys(a).forEach(function (k) { e[k] = a[k]; });
    return e;
  }
  /** "Save to My drinks": label, presetId, amount (never amountG, §1.4) and mg of an entry. */
  function drinkFromEntry(entry, id) {
    var d = { id: id, label: entry.label, presetId: entry.presetId || null, mg: entry.mg };
    var a = amountOf(entry);
    if (typeof a.amountMl === 'number') d.amountMl = a.amountMl;
    else if (typeof a.count === 'number') d.count = a.count;
    return d;
  }

  // =====================================================================================
  // Batch B: calendar-day arithmetic, taper plan, late-caffeine window, withdrawal marks.
  // =====================================================================================

  // ---------- calendar days (no Date objects; A-010 §4 "Week boundaries", §5) ----------
  // Proleptic Gregorian day number of a 'YYYY-MM-DD' string (days since 1970-01-01), using
  // integer arithmetic only (H. Hinnant's days_from_civil). Local clock changes (DST) cannot
  // shift it, and leap days are counted exactly — the spec requires calendar-date strings only.
  function dayNum(s) {
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (m <= 2) y -= 1;
    var era = Math.floor(y / 400), yoe = y - era * 400;
    var doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  /** Inverse of dayNum (civil_from_days). */
  function dateOfDayNum(n) {
    var z = n + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
    var y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
  }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
  function addDays(s, n) { return dateOfDayNum(dayNum(s) + n); }

  // ---------- approved wording, Batch B (A-009 §3; A-010 §6 table) ----------
  // W4 plan label, W5 withdrawal note, W6 hold note, W7 end (template), W8 late notice
  // (template), W9 bedtime hint, W10 medicines line, W11 reference wording. Verbatim.
  TEXT.W4 = 'The weekly steps in this plan are a starting point chosen for this app, not a medically tested schedule. You can change them or pause at any time.';
  TEXT.W5 = 'Stopping caffeine or cutting down a lot at once can cause headache, tiredness, low mood or trouble concentrating. In studies, these usually started 12 to 24 hours after stopping and lasted 2 to 9 days. The FDA suggests cutting back gradually.';
  TEXT.W6 = 'Some people get headaches or feel tired for a few days after cutting down. You can stay at this amount for another week.';
  TEXT.W7 = 'You\'ve reached your goal of {X} mg a day. You can change your goal at any time.';
  TEXT.W8 = 'Logged within {N} hours of your usual bedtime. Caffeine can shorten sleep even when taken many hours before bed, and people often don\'t notice it. Larger amounts can last longer.';
  TEXT.W9 = 'Caffeine can shorten sleep even when taken many hours before bed, and people often don\'t notice it.';
  TEXT.W10 = 'Some medicines, including birth control pills, can slow how fast the body clears caffeine. A pharmacist can tell you whether any of yours do.';
  TEXT.W11 = 'For healthy adults, health agencies in the US, Canada and the EU use 400 mg a day as a general reference amount that is not usually linked to negative effects. The EU agency also says up to 200 mg at one time raises no concern for healthy adults. These amounts don\'t apply during pregnancy or breastfeeding, and they are not personal limits. You choose your own daily goal.';
  function w7(goalMg) { return TEXT.W7.replace('{X}', fmtInt(goalMg)); }
  function w8(hours) { return TEXT.W8.replace('{N}', String(hours)); }

  // ---------- taper plan (A-009 §3(a) rule, A-010 §4) ----------
  // The weekly steps are a DESIGN CONSTANT, not evidence (A-009 §3(a); decisions.md 2026-09-25):
  // 25% default (10/15/20/25 allowed — 30%+ can exceed a one-third cut after rounding), 10 mg
  // minimum step, final stop from 25 mg or less, never below the goal, never automatic.
  var PCTS = [10, 15, 20, 25];
  var PCT_DEFAULT = 25;
  var STEP_DAYS = 7;
  var HISTORY_MAX = 2000;                  // same cap as sanitize (A-010 §1.6)
  var TARGET_ACTIONS = ['plan-start', 'next', 'back', 'goal', 'done'];
  var PLAN_MSG = {
    goalWhole: 'Enter your goal as a whole number of mg.',
    goalLow: 'Your goal needs to be lower than your usual amount (about {X} mg a day) for a plan to lower it.'
  };
  /**
   * next(current) exactly as A-009 §3(a) rule 2: at 25 mg or less the next target is the goal;
   * otherwise max(goal, min(round5(current × (100 − pct)/100), current − 10)), where round5 is
   * Math.round(current*(100-pct)/500)*5 (half-up to 5 mg; equals exact arithmetic, A-010 V1–V2).
   */
  function nextTarget(current, goal, pct) {
    if (current <= 25) return goal;
    return Math.max(goal, Math.min(Math.round(current * (100 - pct) / 500) * 5, current - 10));
  }
  /** The whole weekly series baseline → goal (for tests and the preview). */
  function taperSeries(baseline, goal, pct) {
    var s = [baseline];
    for (var i = 0; i < 1000 && s[s.length - 1] > goal; i++) s.push(nextTarget(s[s.length - 1], goal, pct));
    return s;
  }
  /** Goal validation (A-010 §4): ASCII digits only, 0 ≤ goal < baselineMg. The app never suggests one. */
  function parseGoal(text, baselineMg) {
    var t = norm(text);
    if (!/^[0-9]+$/.test(t)) return { ok: false, error: PLAN_MSG.goalWhole };
    var g = Number(t);
    if (!(g < baselineMg)) return { ok: false, error: PLAN_MSG.goalLow.replace('{X}', fmtInt(baselineMg)) };
    return { ok: true, goal: g };
  }
  function clonePlan(p) { return JSON.parse(JSON.stringify(p)); }
  function lastTarget(p) { return p.targets.length ? p.targets[p.targets.length - 1] : null; }
  function pushHist(p, h) {
    p.history = Array.isArray(p.history) ? p.history : [];
    p.history.push(h);
    if (p.history.length > HISTORY_MAX) p.history.splice(0, p.history.length - HISTORY_MAX);
  }
  function hist(date, action, fromMg, toMg, extra) {
    var h = { date: date, action: action, fromMg: fromMg, toMg: toMg };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }
  /** Finish: status done, current target = goal, endDate = today, history `done`. */
  function finish(p, today, fromMg) {
    p.status = 'done';
    p.currentTargetMg = p.goalMg;
    p.endDate = today;
    pushHist(p, hist(today, 'done', fromMg, p.goalMg));
  }
  /**
   * Start the plan from the baseline phase (A-010 §4 "Start"). base = baselineSummary (frozen
   * here: baselineDays and baselineMg). goalText is validated; pct must be 10/15/20/25.
   * targets = [baselineMg, next(baselineMg)]; if that first step already equals the goal the
   * plan is done at once (250 → 245, 12 → 0). Returns { ok, plan } | { ok:false, error }.
   */
  function startPlan(plan, base, goalText, pct, today) {
    if (!base || base.n < BASELINE_MIN || !(base.avg > 0)) return { ok: false, error: BASE_TEXT.zero };
    var g = parseGoal(goalText, base.avg);
    if (!g.ok) return g;
    var p = clonePlan(plan);
    var step = PCTS.indexOf(pct) >= 0 ? pct : PCT_DEFAULT;
    var first = nextTarget(base.avg, g.goal, step);
    p.status = 'active';
    p.baselineDays = base.days.slice();
    p.baselineMg = base.avg;
    p.goalMg = g.goal;
    p.pct = step;
    p.targets = [base.avg, first];
    p.currentTargetMg = first;
    p.targetSince = today;
    p.startDate = today;
    p.endDate = null;
    pushHist(p, hist(today, 'plan-start', base.avg, first, { pct: step, goalMg: g.goal }));
    if (first === g.goal) finish(p, today, first);
    return { ok: true, plan: p };
  }
  /** Step day: an active plan whose target took effect 7 or more calendar days ago. */
  function stepDue(plan, today) {
    return !!plan && plan.status === 'active' && typeof plan.targetSince === 'string' && daysBetween(plan.targetSince, today) >= STEP_DAYS;
  }
  /** "Next step": push next(current); reaching the goal finishes the plan (W7). */
  function applyNext(plan, today) {
    if (!plan || plan.status !== 'active') return { ok: false };
    var p = clonePlan(plan), cur = p.currentTargetMg;
    var n = nextTarget(cur, p.goalMg, p.pct);
    p.targets.push(n);
    p.currentTargetMg = n;
    p.targetSince = today;
    pushHist(p, hist(today, 'next', cur, n));
    if (n === p.goalMg) finish(p, today, n);
    return { ok: true, plan: p };
  }
  /** "Stay at this amount for another week" (also the Settings pause). Holds are unlimited. */
  function applyStay(plan, today) {
    if (!plan || plan.status !== 'active') return { ok: false };
    var p = clonePlan(plan);
    p.targetSince = today;
    pushHist(p, hist(today, 'stay', p.currentTargetMg, p.currentTargetMg));
    return { ok: true, plan: p };
  }
  /** "Go back to last week's amount": pop the stack (as far back as the baseline). */
  function applyBack(plan, today) {
    if (!plan || plan.status !== 'active' || plan.targets.length < 2) return { ok: false };
    var p = clonePlan(plan);
    var popped = p.targets.pop();
    p.currentTargetMg = lastTarget(p);
    p.targetSince = today;
    pushHist(p, hist(today, 'back', popped, p.currentTargetMg));
    return { ok: true, plan: p };
  }
  /** The amount "Go back" returns to, or null when there is nothing to go back to. */
  function backTarget(plan) {
    return plan && plan.status === 'active' && plan.targets.length >= 2 ? plan.targets[plan.targets.length - 2] : null;
  }
  /** Change weekly step (applies from the next step). */
  function changePct(plan, pct, today) {
    if (!plan || (plan.status !== 'active' && plan.status !== 'done') || PCTS.indexOf(pct) < 0) return { ok: false };
    if (plan.pct === pct) return { ok: true, plan: plan, unchanged: true };
    var p = clonePlan(plan);
    p.pct = pct;
    pushHist(p, hist(today, 'pct', p.currentTargetMg, p.currentTargetMg, { pct: pct }));
    return { ok: true, plan: p };
  }
  /**
   * What a goal change would do, before any confirm (A-010 §4 "Change goal"):
   *  'finish'     active and goal ≥ current target → needs the confirm, then done at the goal;
   *  'reactivate' done and goal < last target      → active again from today;
   *  'update'     any other valid change;          'same' nothing changes.
   */
  function goalChangeKind(plan, g) {
    if (!plan || (plan.status !== 'active' && plan.status !== 'done')) return null;
    if (g === plan.goalMg) return 'same';
    if (plan.status === 'active') return g >= plan.currentTargetMg ? 'finish' : 'update';
    return g < lastTarget(plan) ? 'reactivate' : 'update';
  }
  /**
   * Apply a validated goal. The history `goal` entry's toMg is the target after the change (so
   * targetOn() replays it correctly) and goalMg is the new goal.
   */
  function changeGoal(plan, g, today) {
    var kind = goalChangeKind(plan, g);
    if (!kind) return { ok: false };
    if (kind === 'same') return { ok: true, plan: plan, unchanged: true, kind: kind };
    var p = clonePlan(plan), before = p.currentTargetMg;
    p.goalMg = g;
    if (kind === 'reactivate') {
      p.status = 'active';
      p.currentTargetMg = lastTarget(p);
      p.targetSince = today;
      p.endDate = null;
    } else if (p.status === 'done') {
      p.currentTargetMg = g;        // done means the target is the goal
    }
    if (kind === 'finish') {
      pushHist(p, hist(today, 'goal', before, g, { goalMg: g }));
      finish(p, today, g);
    } else {
      pushHist(p, hist(today, 'goal', before, p.currentTargetMg, { goalMg: g }));
    }
    return { ok: true, plan: p, kind: kind };
  }
  /** End plan (after a confirm): status ended, endDate today, history `end`. */
  function endPlan(plan, today) {
    if (!plan || (plan.status !== 'active' && plan.status !== 'done')) return { ok: false };
    var p = clonePlan(plan);
    var from = p.currentTargetMg === undefined ? null : p.currentTargetMg;
    p.status = 'ended';
    p.endDate = today;
    pushHist(p, hist(today, 'end', from, null));
    return { ok: true, plan: p };
  }
  /**
   * The daily target on date d, for Trends (A-010 §4 "Target on date d"): replay the history in
   * array order; the target is the toMg of the last plan-start/next/back/goal/done entry dated
   * ≤ d. `end` and a later `baseline-start` (Start again) clear it, so there is none before the
   * start date and none on or after the end date of an ended plan.
   */
  function targetOn(plan, d) {
    if (!plan || !Array.isArray(plan.history)) return null;
    var t = null;
    plan.history.forEach(function (h) {
      if (!h || !(h.date <= d)) return;
      if (h.action === 'end' || h.action === 'baseline-start') t = null;
      else if (TARGET_ACTIONS.indexOf(h.action) >= 0 && typeof h.toMg === 'number') t = h.toMg;
    });
    if (plan.status === 'ended' && typeof plan.endDate === 'string' && d >= plan.endDate) return null;
    return t;
  }
  /** Today's status line for a started plan (A-010 §4 "Daily target shown"); [] otherwise. */
  function planStatusLines(plan) {
    if (!plan) return [];
    if (plan.status === 'active') return ['This week\'s target: ' + fmtInt(plan.currentTargetMg) + ' mg a day'];
    if (plan.status === 'done') return [w7(plan.goalMg), 'Your goal: ' + fmtInt(plan.goalMg) + ' mg a day'];
    return [];
  }

  // ---------- withdrawal marks (A-010 §10) ----------
  /** The headache/tiredness chips show while the plan is active, on dates from its start. */
  function marksShown(plan, date) {
    return !!plan && plan.status === 'active' && typeof plan.startDate === 'string' && date >= plan.startDate;
  }
  /** True when a headache or tiredness mark falls on a date in [targetSince, today]. */
  function holdSuggested(plan, dayRecs, today) {
    if (!plan || typeof plan.targetSince !== 'string') return false;
    return (dayRecs || []).some(function (d) {
      return d && d.date >= plan.targetSince && d.date <= today && (d.headache === true || d.tired === true);
    });
  }
  /**
   * The step-day offer (A-010 §4): null when not due. order is Next, Stay, Go back — or Stay,
   * Next, Go back with the hold note W6 when a mark falls in [targetSince, today] (§10).
   */
  function stepOffer(plan, dayRecs, today) {
    if (!stepDue(plan, today)) return null;
    var hold = holdSuggested(plan, dayRecs, today);
    var nextMg = nextTarget(plan.currentTargetMg, plan.goalMg, plan.pct);
    var back = backTarget(plan);
    var order = hold ? ['stay', 'next'] : ['next', 'stay'];
    if (back !== null) order.push('back');
    return { order: order, hold: hold, nextMg: nextMg, isGoal: nextMg === plan.goalMg, backMg: back };
  }
  function nextLabel(o) { return 'Next step: ' + fmtInt(o.nextMg) + ' mg a day' + (o.isGoal ? ' (your goal)' : ''); }
  var OFFER_TEXT = {
    stay: 'Stay at this amount for another week',
    back: 'Go back to last week\'s amount'
  };

  // ---------- plan history table (Settings) ----------
  var HIST_WHAT = {
    'baseline-start': 'Started tracking your usual amount',
    'plan-start': 'Plan started',
    next: 'Next step',
    stay: 'Stayed at this amount for another week',
    back: 'Went back to last week\'s amount',
    goal: 'Goal changed',
    pct: 'Weekly step changed',
    done: 'Reached your goal',
    end: 'Plan ended'
  };
  /** Rows { date, what, amount } in history order. */
  function historyRows(plan) {
    return (plan && Array.isArray(plan.history) ? plan.history : []).map(function (h) {
      var what = HIST_WHAT[h.action] || h.action;
      if (h.action === 'plan-start' && typeof h.fromMg === 'number') what += ' from about ' + fmtInt(h.fromMg) + ' mg a day';
      if ((h.action === 'plan-start' || h.action === 'goal') && typeof h.goalMg === 'number') what += (h.action === 'goal' ? ' to ' : ', goal ') + fmtInt(h.goalMg) + ' mg a day';
      if ((h.action === 'pct' || h.action === 'plan-start') && typeof h.pct === 'number') what += (h.action === 'pct' ? ' to ' : ', weekly step ') + h.pct + '%';
      var amount = typeof h.toMg === 'number' && h.action !== 'end' && h.action !== 'baseline-start' ? 'Target ' + fmtInt(h.toMg) + ' mg a day' : '—';
      return { date: h.date, what: what, amount: amount };
    });
  }

  // ---------- late-caffeine window (A-010 §5; A-009 §3(b)) ----------
  // Wall-clock arithmetic with no Date objects. A bedtime before 12:00 is read as after
  // midnight and belongs to the evening before (bedAbs adds a day). The window runs from
  // N hours before bedtime to 4 h after it (D1: the person is still up before that night's
  // sleep). Windows are at most 16 h long, so an entry matches at most one evening (V9).
  // On DST nights the clock hours differ from elapsed time by up to 1 h (documented limit).
  function minutesOf(t) { return +t.slice(0, 2) * 60 + +t.slice(3, 5); }
  function isHHMM(t) { return typeof t === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t); }
  function bedAbs(eDay, B) { return eDay * 1440 + B + (B < 720 ? 1440 : 0); }
  /** The evening E ('YYYY-MM-DD') whose late window contains date/time, or null. */
  function lateEvening(date, time, bedtime, cutoffHours) {
    if (!isHHMM(bedtime) || !isHHMM(time)) return null;
    var B = minutesOf(bedtime), n = dayNum(date), x = n * 1440 + minutesOf(time);
    for (var e = n - 1; e <= n; e++) {
      var b = bedAbs(e, B);
      if (x >= b - 60 * cutoffHours && x < b + 240) return dateOfDayNum(e);
    }
    return null;
  }
  /** An entry gets the W8 note when a bedtime is set, mg > 0 and it falls in a late window. */
  function isLateEntry(entry, settings) {
    var s = settings || {};
    if (!entry || !(entry.mg > 0) || !isHHMM(s.caffeineBedtime)) return false;
    var hours = typeof s.caffeineCutoffHours === 'number' ? s.caffeineCutoffHours : 8;
    return lateEvening(entry.date, entry.time, s.caffeineBedtime, hours) !== null;
  }

  HT.caffeineCore = {
    FL_OZ_ML: FL_OZ_ML,
    CHECKED_DATE: CHECKED,
    MG_MAX: MG_MAX,
    NAME_MAX: NAME_MAX,
    DRINKS_MAX: DRINKS_MAX,
    QUICK_MAX: QUICK_MAX,
    BASELINE_DAYS: BASELINE_DAYS,
    BASELINE_MIN: BASELINE_MIN,
    TEXT: TEXT,
    MSG: MSG,
    BASE_TEXT: BASE_TEXT,
    GROUPS: GROUPS,
    PRESETS: PRESETS,
    presetById: presetById,
    isLabelOnly: isLabelOnly,
    flOzToMl: flOzToMl,
    mlToFlOz: mlToFlOz,
    volumeMg: volumeMg,
    countMg: countMg,
    presetMg: presetMg,
    defaultAmount: defaultAmount,
    parseVolume: parseVolume,
    parseCount: parseCount,
    parseMg: parseMg,
    parseName: parseName,
    volumeText: volumeText,
    countText: countText,
    fmtInt: fmtInt,
    mgText: mgText,
    formatAmount: formatAmount,
    describe: describe,
    dayTotal: dayTotal,
    countedBaselineDays: countedBaselineDays,
    baselineAverage: baselineAverage,
    baselineSummary: baselineSummary,
    baselineView: baselineView,
    newBaselinePlan: newBaselinePlan,
    restartBaseline: restartBaseline,
    entryFromDrink: entryFromDrink,
    drinkFromEntry: drinkFromEntry,
    // Batch B
    PCTS: PCTS,
    PCT_DEFAULT: PCT_DEFAULT,
    STEP_DAYS: STEP_DAYS,
    PLAN_MSG: PLAN_MSG,
    OFFER_TEXT: OFFER_TEXT,
    dayNum: dayNum,
    dateOfDayNum: dateOfDayNum,
    daysBetween: daysBetween,
    addDays: addDays,
    w7: w7,
    w8: w8,
    nextTarget: nextTarget,
    taperSeries: taperSeries,
    parseGoal: parseGoal,
    startPlan: startPlan,
    stepDue: stepDue,
    applyNext: applyNext,
    applyStay: applyStay,
    applyBack: applyBack,
    backTarget: backTarget,
    changePct: changePct,
    goalChangeKind: goalChangeKind,
    changeGoal: changeGoal,
    endPlan: endPlan,
    targetOn: targetOn,
    planStatusLines: planStatusLines,
    marksShown: marksShown,
    holdSuggested: holdSuggested,
    stepOffer: stepOffer,
    nextLabel: nextLabel,
    historyRows: historyRows,
    lateEvening: lateEvening,
    isLateEntry: isLateEntry
  };
})(window.HT = window.HT || {});
