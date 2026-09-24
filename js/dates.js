/* Health Tracker — dates.js
 * Local-date helpers. A "day" in this app is a local calendar date string YYYY-MM-DD.
 * Rules:
 *  - Never Date.parse() a non-ISO string (locale strings parse differently per browser).
 *  - "YYYY-MM-DD" is built from its numeric parts with new Date(y, m-1, d) = LOCAL midnight
 *    (Date.parse("2026-09-23") would give UTC midnight, which is the previous day in the US).
 *  - Day arithmetic goes through Date.UTC so DST changes never skip or repeat a day.
 * Exposes window.HT.dates.
 */
(function (HT) {
  'use strict';

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  // ISO 8601 date-time with a mandatory offset or Z (what toISOString and Shortcuts emit).
  var ISO_DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/;
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** True for a real calendar date "YYYY-MM-DD" (rejects 2026-02-30). */
  function isValidDateStr(s) {
    if (typeof s !== 'string') return false;
    var m = DATE_RE.exec(s);
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || y < 1900 || y > 2999) return false;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  /** Local calendar date of a Date object. */
  function toLocalDateStr(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function todayLocal() { return toLocalDateStr(new Date()); }

  /** "YYYY-MM-DD" -> Date at LOCAL midnight. Throws on invalid input. */
  function parseLocalDate(s) {
    if (!isValidDateStr(s)) throw new Error('Invalid date string');
    var m = DATE_RE.exec(s);
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  function utcDayNumber(s) {
    var m = DATE_RE.exec(s);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  }

  /** Add n calendar days to "YYYY-MM-DD" (DST-safe). */
  function addDays(s, n) {
    if (!isValidDateStr(s)) throw new Error('Invalid date string');
    var d = new Date((utcDayNumber(s) + n) * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /** Whole calendar days from a to b (b - a). */
  function daysBetween(a, b) {
    if (!isValidDateStr(a) || !isValidDateStr(b)) throw new Error('Invalid date string');
    return Math.round(utcDayNumber(b) - utcDayNumber(a));
  }

  /** Current time as ISO UTC, e.g. 2026-09-23T14:05:00.000Z (used for updatedAt). */
  function nowIso() { return new Date().toISOString(); }

  /**
   * Strict ISO 8601 date-time (with Z or numeric offset) -> epoch ms. Returns NaN otherwise.
   * Only strings that pass the regex ever reach Date.parse, whose behaviour for this
   * exact format is defined by the ECMAScript spec.
   */
  function isoToMs(s) {
    if (typeof s !== 'string') return NaN;
    var m = ISO_DT_RE.exec(s);
    if (!m) return NaN;
    var mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = m[6] ? +m[6] : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return NaN;
    var frac = m[7] ? Number(('0.' + m[7]).slice(0, 5)) * 1000 : 0; // ms precision
    var ms = Date.UTC(+m[1], mo - 1, d, h, mi, se, Math.round(frac));
    var dt = new Date(Date.UTC(+m[1], mo - 1, d));
    if (dt.getUTCDate() !== d) return NaN; // e.g. Feb 30
    var off = m[8];
    if (off !== 'Z') {
      var sign = off[0] === '-' ? -1 : 1;
      var digits = off.slice(1).replace(':', '');
      var offH = +digits.slice(0, 2), offM = +digits.slice(2, 4);
      // T001-07: real UTC offsets run from -12:00 to +14:00, minutes 00–59.
      if (offH > 14 || offM > 59 || (offH === 14 && offM > 0)) return NaN;
      var offMin = offH * 60 + offM;
      ms -= sign * offMin * 60000;
    }
    return ms;
  }

  function isIso(s) { return !isNaN(isoToMs(s)); }

  /** Current local time "HH:MM". */
  function nowHHMM() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function isValidTime(s) { return typeof s === 'string' && TIME_RE.test(s); }

  /** Human label for a date string, e.g. "Wed 23 Sep 2026", using the device locale. */
  function formatLong(s) {
    var d = parseLocalDate(s);
    try {
      return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return s; }
  }

  /** "Today", "Yesterday", or the long format. */
  function formatRelative(s, today) {
    today = today || todayLocal();
    var diff = daysBetween(s, today);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return formatLong(s);
  }

  /** "HH:MM" -> localized short time for display (e.g. "1:05 PM" or "13:05"). */
  function formatTime(hhmm) {
    if (!isValidTime(hhmm)) return hhmm || '';
    var p = hhmm.split(':');
    var d = new Date(2000, 0, 1, +p[0], +p[1]);
    try { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return hhmm; }
  }

  HT.dates = {
    DATE_RE: DATE_RE,
    isValidDateStr: isValidDateStr,
    toLocalDateStr: toLocalDateStr,
    todayLocal: todayLocal,
    parseLocalDate: parseLocalDate,
    addDays: addDays,
    daysBetween: daysBetween,
    nowIso: nowIso,
    isoToMs: isoToMs,
    isIso: isIso,
    nowHHMM: nowHHMM,
    isValidTime: isValidTime,
    formatLong: formatLong,
    formatRelative: formatRelative,
    formatTime: formatTime,
    pad2: pad2
  };
})(window.HT = window.HT || {});
