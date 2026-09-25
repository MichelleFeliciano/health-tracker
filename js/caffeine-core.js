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
    notYet: 'The reduction plan is coming in the next update.',
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
    drinkFromEntry: drinkFromEntry
  };
})(window.HT = window.HT || {});
