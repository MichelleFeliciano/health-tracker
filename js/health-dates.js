/* Health Tracker — health-dates.js
 * Date handling for the Apple Health importers.
 *  - parseHealthDate: export.xml dates "yyyy-MM-dd HH:mm:ss ±HHMM" -> UTC epoch ms.
 *    Exactly the parser in docs/team/research/R-001-apple-health-export.md §6.0.1 (R-9).
 *    Date.parse / new Date(string) are never used (ECMA-262 allows implementation-specific
 *    fallbacks for non-ISO strings; A-001 Re-review 1 RR.4).
 *  - parseIsoOffset: Shortcut CSV timestamps, ISO 8601 with a numeric offset or Z only
 *    (A-002 item 12; R-002 §6.1).
 *  - Zones: all "which local day" decisions go through a zone object
 *    { dateKey(ms), minuteOfDay(ms), wallMs(key, hour) } (R-001 §6.0.2). The app uses
 *    localZone (the device's current time zone via JS Date local getters). Tests use
 *    tzZone('America/Los_Angeles') so the R-001 §6.4 examples give the same answers on
 *    any machine. The offset written in a date string is used ONLY to get the instant (E7).
 * Classic script; works in a page (window.HT) and in a Worker (self.HT).
 */
(function (HT) {
  'use strict';

  var HEALTH_DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;
  var ISO_OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
  var DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Shared range + round-trip check. Returns the wall-clock time read as if UTC, or NaN.
  function wallAsUtc(y, mo, d, h, mi, se) {
    if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return NaN;
    var wall = Date.UTC(y, mo - 1, d, h, mi, se);
    var chk = new Date(wall);
    if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return NaN; // e.g. 02-30
    return wall;
  }

  /** R-001 §6.0.1. Returns UTC epoch ms, or NaN if s is not a valid export date. */
  function parseHealthDate(s) {
    var m = HEALTH_DATE_RE.exec(s);
    if (m === null) return NaN;
    var oh = +m[8], om = +m[9];
    if (oh > 14 || om > 59) return NaN;
    var wall = wallAsUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    if (wall !== wall) return NaN;
    var sign = m[7] === '-' ? -1 : 1;
    return wall - sign * (oh * 60 + om) * 60000; // "-0700" -> add 7 h to get UTC
  }

  /** Shortcut CSV timestamp "YYYY-MM-DDTHH:mm:ss±HH:MM" or "...Z" -> UTC epoch ms, or NaN. */
  function parseIsoOffset(s) {
    var m = ISO_OFFSET_RE.exec(s);
    if (m === null) return NaN;
    var wall = wallAsUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    if (wall !== wall) return NaN;
    if (m[7] === 'Z') return wall;
    var oh = +m[9], om = +m[10];
    if (oh > 14 || om > 59) return NaN;
    var sign = m[8] === '-' ? -1 : 1;
    return wall - sign * (oh * 60 + om) * 60000;
  }

  /** True for a real calendar date "YYYY-MM-DD". */
  function isDateKey(s) {
    if (typeof s !== 'string') return false;
    var m = DATE_KEY_RE.exec(s);
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1970 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
    var t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  }

  /** Pure calendar arithmetic on "YYYY-MM-DD" (no time zone involved). R-001 §6.0.2. */
  function addDaysKey(key, n) {
    var p = key.split('-');
    var t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }

  // ---------- zones ----------

  /** The device's current zone, through JS Date local getters (historical DST rules apply). */
  var localZone = {
    name: 'local',
    dateKey: function (ms) {
      var t = new Date(ms);
      return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
    },
    minuteOfDay: function (ms) { var t = new Date(ms); return t.getHours() * 60 + t.getMinutes(); },
    // Instant of local wall time key@hour:00. A skipped (DST) wall time moves forward,
    // which never affects our boundary hours 00:00 / 18:00 in zones changing at 02:00.
    wallMs: function (key, hour) {
      var p = key.split('-');
      return new Date(+p[0], +p[1] - 1, +p[2], hour, 0, 0, 0).getTime();
    }
  };

  /**
   * A fixed IANA zone via Intl (built into every supported browser; no data files).
   * Used by the unit tests; behaves like localZone would on a device set to that zone,
   * including the "earlier instant" choice for repeated wall times and "move forward"
   * for skipped ones (ECMA-262 LocalTime rules).
   */
  function tzZone(tz) {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    function parts(ms) {
      var o = {};
      fmt.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
      var h = +o.hour; if (h === 24) h = 0;
      return { y: +o.year, mo: +o.month, d: +o.day, h: h, mi: +o.minute, s: +o.second };
    }
    function offsetMin(ms) {
      var sec = Math.floor(ms / 1000) * 1000;
      var p = parts(sec);
      return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - sec) / 60000);
    }
    return {
      name: tz,
      dateKey: function (ms) { var p = parts(ms); return p.y + '-' + pad(p.mo) + '-' + pad(p.d); },
      minuteOfDay: function (ms) { var p = parts(ms); return p.h * 60 + p.mi; },
      wallMs: function (key, hour) {
        var k = key.split('-');
        var target = Date.UTC(+k[0], +k[1] - 1, +k[2], hour, 0, 0);
        var before = offsetMin(target - 14 * 3600000), after = offsetMin(target + 14 * 3600000);
        var valid = [];
        [before, after].forEach(function (o) {
          var c = target - o * 60000;
          if (offsetMin(c) === o && valid.indexOf(c) < 0) valid.push(c);
        });
        if (valid.length) return Math.min.apply(null, valid);  // repeated time: earlier instant
        return target - before * 60000;                          // skipped time: move forward
      }
    };
  }

  /** Error with a stable code and a plain-language message that is safe to show the user
   *  (it never contains record contents). Shared by all importer modules. */
  function importError(code, message) {
    var e = new Error(message);
    e.code = code;
    e.userMessage = message;
    return e;
  }

  HT.healthDates = {
    importError: importError,
    HEALTH_DATE_RE: HEALTH_DATE_RE,
    parseHealthDate: parseHealthDate,
    parseIsoOffset: parseIsoOffset,
    isDateKey: isDateKey,
    addDaysKey: addDaysKey,
    pad: pad,
    localZone: localZone,
    tzZone: tzZone
  };
})(self.HT = self.HT || {});
