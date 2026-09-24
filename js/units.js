/* Health Tracker — units.js
 * The ONLY place glucose unit conversion happens.
 * Factor: mmol/L = mg/dL ÷ 18.0156 (molar mass of glucose, NIST) — see
 * docs/team/research/R-003-metrics-evidence-and-patterns.md and
 * docs/team/knowledge/decisions.md (2026-09-23). Displayed to 1 decimal for mmol/L,
 * whole numbers for mg/dL.
 * Classic script (no modules) so the app runs from file://. Exposes window.HT.units.
 */
(function (HT) {
  'use strict';

  var MGDL_PER_MMOL = 18.0156;
  var MGDL = 'mg/dL';
  var MMOL = 'mmol/L';
  var UNITS = [MGDL, MMOL];

  // Input sanity limits. These are NOT health ranges and are never shown as guidance;
  // they only reject typos (e.g. 1200 typed for 120). Wide on purpose.
  var INPUT_LIMITS = {};
  INPUT_LIMITS[MGDL] = { min: 10, max: 1000 };
  INPUT_LIMITS[MMOL] = { min: 0.6, max: 55.5 };

  function round1(n) {
    // Round half away from zero to 1 decimal, avoiding binary drift (e.g. 1.05).
    var s = n < 0 ? -1 : 1;
    return s * Math.round((Math.abs(n) + 1e-9) * 10) / 10;
  }

  function isUnit(u) { return u === MGDL || u === MMOL; }

  /** mg/dL -> mmol/L, rounded to 1 decimal (display value). */
  function mgdlToMmol(mgdl) { return round1(mgdl / MGDL_PER_MMOL); }

  /** mmol/L -> mg/dL, rounded to a whole number (display value). */
  function mmolToMgdl(mmol) { return Math.round(mmol * MGDL_PER_MMOL); }

  /** Unrounded value in mg/dL, for comparisons (never for display). */
  function toMgdlExact(value, unit) {
    if (unit === MGDL) return value;
    if (unit === MMOL) return value * MGDL_PER_MMOL;
    throw new Error('Unknown glucose unit');
  }

  /** Convert a stored {value, unit} to a display number in the target unit. */
  function convert(value, fromUnit, toUnit) {
    if (!isUnit(fromUnit) || !isUnit(toUnit)) throw new Error('Unknown glucose unit');
    if (fromUnit === toUnit) return toUnit === MMOL ? round1(value) : Math.round(value);
    return toUnit === MMOL ? mgdlToMmol(value) : mmolToMgdl(value);
  }

  /** Formatted string with unit, e.g. "5.6 mmol/L" or "101 mg/dL". */
  function format(value, fromUnit, toUnit) {
    var n = convert(value, fromUnit, toUnit || fromUnit);
    var u = toUnit || fromUnit;
    return (u === MMOL ? n.toFixed(1) : String(n)) + ' ' + u;
  }

  /** Format an exact mg/dL number into the display unit, no unit suffix. */
  function formatMgdlIn(mgdl, unit) {
    return unit === MMOL ? mgdlToMmol(mgdl).toFixed(1) : String(Math.round(mgdl));
  }

  /**
   * Parse a user-typed glucose number. Accepts "5.6" and "5,6" (decimal comma).
   * Returns {ok:true, value} or {ok:false, error}. Blank -> {ok:true, value:null}.
   */
  function parseGlucose(text, unit) {
    if (!isUnit(unit)) return { ok: false, error: 'Unknown unit.' };
    var t = String(text == null ? '' : text).trim();
    if (t === '') return { ok: true, value: null };
    // mg/dL readings are whole numbers, so a comma there is a thousands separator
    // ("1,200"), not a decimal comma. Only mmol/L accepts "5,6".
    if (unit === MGDL && t.indexOf(',') >= 0) return { ok: false, error: 'Enter a whole number in mg/dL, like 100.' };
    t = t.replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: 'Enter a number, like ' + (unit === MMOL ? '5.6' : '100') + '.' };
    var v = Number(t);
    var lim = INPUT_LIMITS[unit];
    if (!isFinite(v) || v < lim.min || v > lim.max) {
      return { ok: false, error: 'That doesn’t look like a meter reading in ' + unit + '. Check the number and the unit.' };
    }
    v = unit === MMOL ? round1(v) : Math.round(v);
    return { ok: true, value: v };
  }

  /**
   * Is a reading outside the user's own range? Range bounds are stored as exact mg/dL
   * (either may be null). Returns false when no range is set.
   */
  function outsideRange(value, unit, lowMgdl, highMgdl) {
    if (value == null) return false;
    var mg = toMgdlExact(value, unit);
    // Compare at display precision so "3.9 mmol/L" vs a low of 3.9 isn't flagged by drift.
    var eps = 1e-6;
    if (lowMgdl != null && mg < lowMgdl - eps) return true;
    if (highMgdl != null && mg > highMgdl + eps) return true;
    return false;
  }

  HT.units = {
    MGDL_PER_MMOL: MGDL_PER_MMOL,
    MGDL: MGDL,
    MMOL: MMOL,
    UNITS: UNITS,
    INPUT_LIMITS: INPUT_LIMITS,
    isUnit: isUnit,
    round1: round1,
    mgdlToMmol: mgdlToMmol,
    mmolToMgdl: mmolToMgdl,
    toMgdlExact: toMgdlExact,
    convert: convert,
    format: format,
    formatMgdlIn: formatMgdlIn,
    parseGlucose: parseGlucose,
    outsideRange: outsideRange
  };
})(window.HT = window.HT || {});
