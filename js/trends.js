/* Health Tracker — trends.js
 * Trends screen: 7 / 30 / 90-day inline-SVG charts for sleep, steps and the four 0–10 ratings,
 * each with a text summary and a data table. Also hosts the shared DATA ADAPTER
 * (HT.trends.data) that patterns.js and summary.js read from.
 *
 * Rules implemented here (sources in brackets):
 *  - Sleep is dated by WAKE date; a row is the R-001 §6.1 SleepDay. Total asleep time is the
 *    main metric; stages are shown only as "estimated" [R-003 §2; A-003 §6].
 *  - Partial nights are drawn differently (hatched + labelled) and EXCLUDED from averages,
 *    and the count of partial nights is stated [R-001 §6.1 step 10, Rev. 2].
 *  - 7-hour reference line, neutrally labelled; never "good/bad" [R-003 §2/§4 conflicts:
 *    AASM/SRS 2015 and CDC 2016, adults 18–60, ≥ 7 h, no upper limit; verified A-003 S1/S1b].
 *  - Steps: when a day has both a Shortcut value and a full-export value, the Shortcut value
 *    is shown [decisions.md 2026-09-23; A-002].
 *  - Missing days are gaps, never 0. "Hard to tell" is stored as null and counts as missing
 *    [A-003 §5.1].
 *  - No colour-only meaning: every chart has one series, a text summary and a data table.
 * Classic script. Exposes window.HT.trends = { render(container), data, ... }.
 * Never logs health data.
 */
(function (HT) {
  'use strict';

  var SLEEP_REF_H = 7;            // AASM/SRS 2015 + CDC 2016 adult reference, see header
  var RANGES = [7, 30, 90];
  var RATINGS = ['anxiety', 'mood', 'energy', 'stress'];
  var RATING_INFO = {
    anxiety: { name: 'Anxiety', dir: 'higher number = more anxious' },
    mood: { name: 'Mood', dir: 'higher number = better mood' },
    energy: { name: 'Energy', dir: 'higher number = more energy' },
    stress: { name: 'Stress', dir: 'higher number = more stressed' }
  };
  var TAG_LABELS = {
    'sensory': 'Sensory', 'schedule-change': 'Schedule change', 'social': 'Social',
    'work-school': 'Work / school', 'caregiving': 'Caregiving', 'other': 'Other'
  };
  var CARB_LABELS = { low: 'Low', med: 'Medium', high: 'High' };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // =====================================================================================
  // Date helpers (pure; UTC arithmetic so DST never skips a day)
  // =====================================================================================
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayNum(s) { var m = DATE_RE.exec(s); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN; }
  function fromDayNum(n) { var d = new Date(n * 86400000); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function addDays(s, k) { return fromDayNum(dayNum(s) + k); }
  /** Every date from start to end inclusive. */
  function dateList(start, end) {
    var out = [], a = dayNum(start), b = dayNum(end);
    for (var n = a; n <= b; n++) out.push(fromDayNum(n));
    return out;
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** Short, locale-free label "3 Sep" (used on axes where space is tight). */
  function shortDate(s) { var m = DATE_RE.exec(s); return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] : s; }
  function longDate(s) {
    try { return HT.dates && HT.dates.formatLong ? HT.dates.formatLong(s) : s; } catch (e) { return s; }
  }

  // =====================================================================================
  // Pure data preparation (unit-tested in tests/stats-tests.js)
  // =====================================================================================

  /**
   * Normalise one R-001 §6.1 SleepDay row. Returns
   * { date, kind, asleepH|null, usable, partial, inBedH, awakeMin, stages{core,deep,rem}|null,
   *   napMin, source, altSource, altAsleepMin }.
   * usable = counts toward averages/patterns: a 'night' with a number, and NOT partial.
   */
  function normalizeSleepRow(r) {
    if (!r || !DATE_RE.test(r.date || '')) return null;
    var kind = r.kind || (isNum(r.asleepMin) ? 'night' : null);
    var asleep = kind === 'night' && isNum(r.asleepMin) && r.asleepMin >= 0 ? r.asleepMin : null;
    var partial = !!r.partial;
    var hasStages = (r.coreMin || 0) + (r.deepMin || 0) + (r.remMin || 0) > 0;
    return {
      date: r.date,
      kind: kind,
      asleepMin: asleep,
      asleepH: asleep === null ? null : asleep / 60,
      usable: asleep !== null && !partial,
      partial: partial && asleep !== null,
      inBedMin: isNum(r.inBedMin) ? r.inBedMin : null,
      awakeMin: isNum(r.awakeMin) ? r.awakeMin : null,
      stages: hasStages ? { core: r.coreMin || 0, deep: r.deepMin || 0, rem: r.remMin || 0 } : null,
      napMin: isNum(r.napMin) ? r.napMin : 0,
      source: typeof r.sourceUsed === 'string' ? r.sourceUsed : null,
      altSource: typeof r.altSource === 'string' ? r.altSource : null,
      altAsleepMin: isNum(r.altAsleepMin) ? r.altAsleepMin : null
    };
  }

  /**
   * Choose one step value per date from stored step records. A record may carry its count in
   * `steps` (R-001 StepDay) or `value` (db.js sanitize). Shortcut beats full export for the same
   * date (decisions.md). A null/NaN count is missing, not 0.
   * Returns { 'YYYY-MM-DD': { steps, origin, source } }.
   */
  function pickSteps(records) {
    var out = {};
    (records || []).forEach(function (r) {
      if (!r || !DATE_RE.test(r.date || '')) return;
      var v = isNum(r.steps) ? r.steps : isNum(r.value) ? r.value : null;
      if (v === null || v < 0) return;
      var origin = r.origin || 'export';
      var cur = out[r.date];
      if (!cur || (origin === 'shortcut' && cur.origin !== 'shortcut')) {
        out[r.date] = { steps: Math.round(v), origin: origin, source: r.stepsSource || r.sourceName || r.source || null };
      }
    });
    return out;
  }

  /** True if a daily-log record holds anything the user entered. */
  function isLogged(log) {
    if (!log) return false;
    if (RATINGS.some(function (k) { return isNum(log[k]); })) return true;
    if (Array.isArray(log.hardToTell) && log.hardToTell.length) return true;
    if (Array.isArray(log.tags) && log.tags.length) return true;
    return typeof log.notes === 'string' && log.notes.trim() !== '';
  }

  /**
   * Merge raw inputs into one object per date in [start, end].
   * raw = { logs: dailyLog[], meals: meal[], steps: stepRecord[], sleep: SleepDay[] }
   * Returns { start, end, dates: [...], byDate: { date: Day } } where Day =
   * { date, log|null, logged, ratings{k: n|null}, hardToTell[], tags[], meals[], steps|null,
   *   stepsOrigin, stepsSource, sleep|null (normalised row) }.
   */
  function buildDays(raw, start, end) {
    var dates = dateList(start, end), byDate = {};
    dates.forEach(function (d) {
      byDate[d] = { date: d, log: null, logged: false, ratings: { anxiety: null, mood: null, energy: null, stress: null },
        hardToTell: [], tags: [], meals: [], steps: null, stepsOrigin: null, stepsSource: null, sleep: null };
    });
    (raw.logs || []).forEach(function (l) {
      var day = l && byDate[l.date];
      if (!day) return;
      day.log = l;
      day.logged = isLogged(l);
      RATINGS.forEach(function (k) {
        // "Hard to tell" is stored as null → missing. Only integers 0–10 count.
        day.ratings[k] = isNum(l[k]) && l[k] >= 0 && l[k] <= 10 ? l[k] : null;
      });
      day.hardToTell = Array.isArray(l.hardToTell) ? l.hardToTell.slice() : [];
      day.tags = Array.isArray(l.tags) ? l.tags.slice() : [];
    });
    (raw.meals || []).forEach(function (m) { var day = m && byDate[m.date]; if (day) day.meals.push(m); });
    dates.forEach(function (d) { byDate[d].meals.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; }); });
    var st = pickSteps(raw.steps);
    Object.keys(st).forEach(function (d) {
      var day = byDate[d]; if (!day) return;
      day.steps = st[d].steps; day.stepsOrigin = st[d].origin; day.stepsSource = st[d].source;
    });
    (raw.sleep || []).forEach(function (r) {
      var n = normalizeSleepRow(r);
      if (n && byDate[n.date]) byDate[n.date].sleep = n;
    });
    return { start: start, end: end, dates: dates, byDate: byDate };
  }

  /** Series { date: number } for a metric: 'sleepH' | 'steps' | rating key. Missing dates absent. */
  function series(days, metric) {
    var out = {};
    days.dates.forEach(function (d) {
      var day = days.byDate[d], v = null;
      if (metric === 'sleepH') v = day.sleep && day.sleep.usable ? day.sleep.asleepH : null;
      else if (metric === 'steps') v = day.steps;
      else v = day.ratings[metric];
      if (isNum(v)) out[d] = v;
    });
    return out;
  }

  /** { n, mean, min, max } of the numbers in a series object (NaN when empty). */
  function describe(obj) {
    var vals = Object.keys(obj).map(function (k) { return obj[k]; }).filter(isNum);
    if (!vals.length) return { n: 0, mean: NaN, min: NaN, max: NaN };
    var s = 0, lo = Infinity, hi = -Infinity;
    vals.forEach(function (v) { s += v; if (v < lo) lo = v; if (v > hi) hi = v; });
    return { n: vals.length, mean: s / vals.length, min: lo, max: hi };
  }

  /** Sleep stats for a period: averages use usable nights only; partial nights are counted. */
  function sleepStats(days) {
    var d = describe(series(days, 'sleepH'));
    d.partial = 0; d.inBedOnly = 0;
    days.dates.forEach(function (k) {
      var s = days.byDate[k].sleep;
      if (s && s.partial) d.partial++;
      if (s && s.kind === 'inBedOnly') d.inBedOnly++;
    });
    return d;
  }

  function hardToTellCount(days, key) {
    var c = 0;
    days.dates.forEach(function (d) { if (days.byDate[d].hardToTell.indexOf(key) >= 0 && days.byDate[d].ratings[key] === null) c++; });
    return c;
  }

  // ---------- number formatting ----------
  function fmtInt(n) { try { return Math.round(n).toLocaleString(); } catch (e) { return String(Math.round(n)); } }
  function fmt1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  /** Minutes → "7 h 05 min". */
  function fmtHM(min) {
    if (!isNum(min)) return '—';
    var m = Math.round(min), h = Math.floor(m / 60);
    return h + ' h ' + pad2(m - h * 60) + ' min';
  }
  function fmtHours(h) { return fmt1(h) + ' h'; }

  // =====================================================================================
  // Data adapter (IndexedDB via HT.db; sleep rows via the Health importer's hook)
  // =====================================================================================
  var injected = null; // tests / other modules may inject { load(start, end) -> Promise<raw> }

  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function rangeGetAll(store, indexName, lo, hi) {
    return HT.db.withTx([store], 'readonly', function (tx) {
      var os = tx.objectStore(store);
      var src = indexName ? os.index(indexName) : os;
      return reqP(src.getAll(IDBKeyRange.bound(lo, hi)));
    });
  }

  /**
   * Convert the Health importer's read API output (HT.healthData.getDays, js/health-agg.js,
   * B-002) into our raw shape. That API has already applied "Shortcut over export" for both
   * steps and sleep, so each date yields at most one step record and one SleepDay.
   */
  function fromHealthDays(list) {
    var steps = [], sleep = [];
    (list || []).forEach(function (d) {
      if (!d || !DATE_RE.test(d.date || '')) return;
      if (isNum(d.steps)) steps.push({ date: d.date, origin: d.stepsOrigin || 'export', value: d.steps, stepsSource: d.stepsSource || null });
      if (d.sleep) {
        var r = {}; Object.keys(d.sleep).forEach(function (k) { r[k] = d.sleep[k]; });
        r.date = d.date; sleep.push(r);
      }
    });
    return { steps: steps, sleep: sleep };
  }

  /**
   * Load raw records for [start, end] (inclusive local dates). Steps and sleep always come from
   * the importer's read API, HT.healthData.getDays (js/health-agg.js, loaded by index.html),
   * which applies the source and precedence rules and reads schema v3's `healthDays`. The old
   * fallback that read the `steps` store directly was removed (A-006 RC-4 note): since v3 that
   * store holds no sleep, and the fallback was unreachable. If the read API is ever missing
   * (e.g. an old cached index.html), steps and sleep are shown as "not imported yet".
   */
  function loadRaw(start, end) {
    if (injected && typeof injected.load === 'function') return Promise.resolve(injected.load(start, end));
    if (!HT.db) return Promise.reject(new Error('no db'));
    var hasApi = !!(HT.healthData && typeof HT.healthData.getDays === 'function');
    return Promise.all([
      rangeGetAll('dailyLog', null, start, end),
      rangeGetAll('meals', 'date', start, end),
      hasApi ? Promise.resolve(HT.healthData.getDays({ from: start, to: end })).catch(function () { return []; }) : []
    ]).then(function (r) {
      var h = fromHealthDays(r[2]);
      return { logs: r[0] || [], meals: r[1] || [], steps: h.steps, sleep: h.sleep, sleepProvider: hasApi };
    });
  }

  /** Load and merge the last `nDays` days ending at `end` (default today). */
  function loadDays(nDays, end) {
    end = end || (HT.dates ? HT.dates.todayLocal() : fromDayNum(Math.floor(Date.now() / 86400000)));
    var start = addDays(end, -(nDays - 1));
    return loadRaw(start, end).then(function (raw) {
      var days = buildDays(raw, start, end);
      days.sleepProvider = raw.sleepProvider !== false;
      return days;
    });
  }

  // =====================================================================================
  // DOM + SVG
  // =====================================================================================
  var SVG_NS = 'http://www.w3.org/2000/svg'; // XML namespace identifier, not a network request
  var svgUid = 0;
  function s(tag, attrs, text) {
    var n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, String(attrs[k])); });
    if (text != null) n.textContent = String(text);
    return n;
  }
  function el(tag, attrs, children) {
    if (HT.app && HT.app.el) return HT.app.el(tag, attrs, children);
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }

  /** "Nice" upper bound for an axis. */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), f = v / p;
    var steps = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10];   // even numbers so the half-way tick is round
    for (var i = 0; i < steps.length; i++) if (f <= steps[i] + 1e-9) return steps[i] * p;
    return 10 * p;
  }

  /**
   * Draw a one-series chart as inline SVG.
   * opts: { dates[], values{date:n}, type 'bar'|'line', yMax, yTicks[], fmtTick(n),
   *         partial{date:true}, refLine {value, label}, title, desc, width }
   * Missing dates are gaps (no bar; the line breaks). A real 0 bar gets a 2px stub so it is
   * visibly different from missing.
   */
  function drawChart(opts) {
    var W = Math.max(260, Math.floor(opts.width || 600)), H = 190;
    var ml = 44, mr = 10, mt = 12, mb = 26;
    var pw = W - ml - mr, ph = H - mt - mb, n = opts.dates.length;
    var step = pw / n, yMax = opts.yMax;
    function y(v) { return mt + ph - (Math.min(v, yMax) / yMax) * ph; }
    function xc(i) { return ml + step * (i + 0.5); }
    var id = 'ch' + (++svgUid);
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-labelledby': id + 't ' + id + 'd', class: 'chart-svg', focusable: 'false' });
    svg.appendChild(s('title', { id: id + 't' }, opts.title));
    svg.appendChild(s('desc', { id: id + 'd' }, opts.desc));
    var defs = s('defs');
    var pat = s('pattern', { id: id + 'h', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.appendChild(s('rect', { width: 6, height: 6, class: 'chart-hatch-bg' }));
    pat.appendChild(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'chart-hatch-line' }));
    defs.appendChild(pat); svg.appendChild(defs);

    // grid + y ticks
    (opts.yTicks || [0, yMax]).forEach(function (t) {
      svg.appendChild(s('line', { x1: ml, x2: W - mr, y1: y(t), y2: y(t), class: 'chart-grid' }));
      svg.appendChild(s('text', { x: ml - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'chart-tick' }, opts.fmtTick ? opts.fmtTick(t) : t));
    });
    // x labels: first, middle, last
    var idx = n <= 1 ? [0] : n <= 7 ? opts.dates.map(function (d, i) { return i; }) : [0, Math.floor((n - 1) / 2), n - 1];
    if (n <= 7 && W < 340) idx = [0, 3, 6].filter(function (i) { return i < n; });
    idx.forEach(function (i) {
      var anchor = n > 7 && i === 0 ? 'start' : n > 7 && i === n - 1 ? 'end' : 'middle';
      var x = n > 7 && i === 0 ? ml : n > 7 && i === n - 1 ? W - mr : xc(i);
      svg.appendChild(s('text', { x: x, y: H - 8, 'text-anchor': anchor, class: 'chart-tick' }, shortDate(opts.dates[i])));
    });
    svg.appendChild(s('line', { x1: ml, x2: W - mr, y1: mt + ph, y2: mt + ph, class: 'chart-axis' }));

    var g = s('g', { 'aria-hidden': 'true' });
    if (opts.type === 'bar') {
      var bw = Math.max(1, step * 0.72);
      opts.dates.forEach(function (d, i) {
        var v = opts.values[d];
        if (!isNum(v)) return; // gap
        var top = y(v), h = Math.max(2, mt + ph - top);
        var partial = opts.partial && opts.partial[d];
        g.appendChild(s('rect', { x: xc(i) - bw / 2, y: mt + ph - h, width: bw, height: h,
          class: partial ? 'chart-bar chart-bar-partial' : 'chart-bar', fill: partial ? 'url(#' + id + 'h)' : null }));
      });
    } else {
      var path = '', pen = false;
      opts.dates.forEach(function (d, i) {
        var v = opts.values[d];
        if (!isNum(v)) { pen = false; return; } // missing day breaks the line
        path += (pen ? 'L' : 'M') + xc(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
        pen = true;
      });
      if (path) g.appendChild(s('path', { d: path, class: 'chart-line' }));
      var r = n > 45 ? 2.2 : 3.2;
      opts.dates.forEach(function (d, i) {
        var v = opts.values[d];
        if (isNum(v)) g.appendChild(s('circle', { cx: xc(i), cy: y(v), r: r, class: 'chart-dot' }));
      });
    }
    svg.appendChild(g);
    if (opts.refLine) {
      var ry = y(opts.refLine.value);
      svg.appendChild(s('line', { x1: ml, x2: W - mr, y1: ry, y2: ry, class: 'chart-ref' }));
      svg.appendChild(s('text', { x: W - mr - 2, y: ry - 4, 'text-anchor': 'end', class: 'chart-ref-label' }, opts.refLine.label));
    }
    return svg;
  }

  function dataTable(caption, head, rows) {
    // The wrapper may scroll sideways on a phone, so it is focusable for keyboard scrolling.
    return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': caption }, [el('table', { class: 'data-table' }, [
      el('caption', { text: caption }),
      el('thead', null, el('tr', null, head.map(function (h) { return el('th', { scope: 'col', text: h }); }))),
      el('tbody', null, rows.map(function (r) {
        return el('tr', null, r.map(function (c, i) { return i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { text: c }); }));
      }))
    ])]);
  }

  function chartCard(o) {
    var headId = 'tr-' + o.key + '-h';
    var sec = el('section', { class: 'card chart-card', 'aria-labelledby': headId }, [
      el('h2', { id: headId, text: o.heading }),
      o.sub ? el('p', { class: 'small muted', text: o.sub }) : null,
      el('p', { class: 'chart-summary', text: o.summary })
    ]);
    if (o.empty) {
      sec.appendChild(el('p', { class: 'muted', text: o.empty }));
      return sec;
    }
    var fig = el('figure', { class: 'chart' });
    fig.appendChild(o.svg);
    if (o.legend) fig.appendChild(o.legend);
    sec.appendChild(fig);
    if (o.notes) o.notes.forEach(function (t) { sec.appendChild(el('p', { class: 'small muted', text: t })); });
    sec.appendChild(el('details', { class: 'chart-data' }, [el('summary', { text: 'Show the numbers as a table' }), o.table]));
    return sec;
  }

  function legendItem(cls, text) {
    return el('li', null, [el('span', { class: 'swatch ' + cls, 'aria-hidden': 'true' }), document.createTextNode(text)]);
  }

  // ---------- the three chart builders ----------
  function sleepCard(days, width) {
    var st = sleepStats(days), vals = {}, partial = {}, any = false;
    days.dates.forEach(function (d) {
      var sl = days.byDate[d].sleep;
      if (sl && sl.asleepH !== null) { vals[d] = sl.asleepH; any = true; if (sl.partial) partial[d] = true; }
    });
    var summary;
    if (!any) summary = 'No sleep recorded in these ' + days.dates.length + ' days.';
    else if (!st.n) summary = 'No full nights in these days' + (st.partial ? ' (' + st.partial + ' partial, not averaged).' : '.');
    else summary = 'Average ' + fmtHM(st.mean * 60) + ' asleep over ' + st.n + ' night' + (st.n === 1 ? '' : 's') +
      (st.partial ? ' (' + st.partial + ' partial night' + (st.partial === 1 ? '' : 's') + ' not included)' : '') +
      '. Shortest ' + fmtHM(st.min * 60) + ', longest ' + fmtHM(st.max * 60) + '.';
    var o = { key: 'sleep', heading: 'Sleep (hours asleep)', sub: 'Each night is shown on the date you woke up.', summary: summary };
    if (!any) {
      o.empty = days.sleepProvider === false
        ? 'Sleep appears here after you import Apple Health data (Settings).'
        : 'Gaps mean no sleep was recorded, for example when the watch was not worn.';
      return chartCard(o);
    }
    var maxV = 0; Object.keys(vals).forEach(function (d) { if (vals[d] > maxV) maxV = vals[d]; });
    var yMax = Math.max(10, Math.ceil(maxV / 2) * 2);
    var ticks = []; for (var t = 0; t <= yMax; t += yMax > 12 ? 4 : 2) ticks.push(t);
    o.svg = drawChart({ dates: days.dates, values: vals, partial: partial, type: 'bar', yMax: yMax, yTicks: ticks,
      fmtTick: function (v) { return v + ' h'; }, width: width,
      refLine: { value: SLEEP_REF_H, label: '7+ h reference' },
      title: 'Sleep, hours asleep per night, ' + shortDate(days.start) + ' to ' + shortDate(days.end),
      desc: summary + ' A dashed line marks 7 hours. Hatched bars are partial nights. Gaps are nights with no data.' });
    o.legend = el('ul', { class: 'chart-legend' }, [
      legendItem('sw-bar', 'Night'),
      legendItem('sw-partial', 'Partial night (hatched, not in the average)'),
      legendItem('sw-ref', '7+ h reference line'),
      el('li', { text: 'Gap = no data' })
    ]);
    o.notes = ['The 7-hour line is the general adult reference (AASM/SRS and CDC: 7 or more hours for adults 18–60). It is shown for context only.',
      'Sleep stages (core, deep, REM) are estimated by the watch and are less accurate than total sleep.'];
    var rows = days.dates.slice().reverse().map(function (d) {
      var sl = days.byDate[d].sleep;
      if (!sl) return [longDate(d), 'No data', '', '', ''];
      if (sl.asleepH === null) return [longDate(d), sl.kind === 'inBedOnly' ? 'In bed only, no sleep recorded' : 'No night recorded', '', sl.napMin ? fmtHM(sl.napMin) : '', ''];
      var note = sl.partial ? 'Partial, not averaged' + (sl.altSource && sl.altAsleepMin !== null ? ' (' + sl.altSource + ' recorded ' + fmtHM(sl.altAsleepMin) + ')' : '') : '';
      var stages = sl.stages ? fmtHM(sl.stages.core) + ' / ' + fmtHM(sl.stages.deep) + ' / ' + fmtHM(sl.stages.rem) : '';
      return [longDate(d), fmtHM(sl.asleepMin), stages, sl.napMin ? fmtHM(sl.napMin) : '', note];
    });
    o.table = dataTable('Sleep by wake date', ['Date', 'Asleep', 'Core / deep / REM (estimated)', 'Naps', 'Note'], rows);
    return chartCard(o);
  }

  function stepsCard(days, width) {
    var vals = series(days, 'steps'), st = describe(vals);
    var summary = st.n ? 'Average ' + fmtInt(st.mean) + ' steps a day over ' + st.n + ' day' + (st.n === 1 ? '' : 's') +
      ' with data. Lowest ' + fmtInt(st.min) + ', highest ' + fmtInt(st.max) + '.'
      : 'No steps recorded in these ' + days.dates.length + ' days.';
    var o = { key: 'steps', heading: 'Steps', summary: summary };
    if (!st.n) { o.empty = 'Steps appear here after you import Apple Health data or the daily Shortcut file (Settings).'; return chartCard(o); }
    var yMax = niceMax(Math.max(st.max, 1000));
    o.svg = drawChart({ dates: days.dates, values: vals, type: 'bar', yMax: yMax, yTicks: [0, yMax / 2, yMax],
      fmtTick: function (v) { return v >= 1000 ? (v / 1000) + 'k' : String(v); }, width: width,
      title: 'Steps per day, ' + shortDate(days.start) + ' to ' + shortDate(days.end),
      desc: summary + ' Gaps are days with no data.' });
    o.legend = el('ul', { class: 'chart-legend' }, [legendItem('sw-bar', 'Steps that day'), el('li', { text: 'Gap = no data' })]);
    o.notes = ['Step counts are estimates from your watch or phone.'];
    var rows = days.dates.slice().reverse().map(function (d) {
      var day = days.byDate[d];
      if (!isNum(day.steps)) return [longDate(d), 'No data', ''];
      return [longDate(d), fmtInt(day.steps), day.stepsOrigin === 'shortcut' ? 'Daily Shortcut' : 'Health export'];
    });
    o.table = dataTable('Steps by date', ['Date', 'Steps', 'From'], rows);
    return chartCard(o);
  }

  function ratingCard(days, key, width) {
    var info = RATING_INFO[key], vals = series(days, key), st = describe(vals), htt = hardToTellCount(days, key);
    var summary = st.n ? 'Average ' + fmt1(st.mean) + ' over ' + st.n + ' day' + (st.n === 1 ? '' : 's') + ' rated. Lowest ' + st.min + ', highest ' + st.max + '.'
      : 'No ' + info.name.toLowerCase() + ' ratings in these ' + days.dates.length + ' days.';
    if (htt) summary += ' ' + htt + ' day' + (htt === 1 ? '' : 's') + ' marked “hard to tell” (not counted).';
    var o = { key: key, heading: info.name + ' (0–10)', sub: '0–10, ' + info.dir + '.', summary: summary };
    if (!st.n) { o.empty = 'Ratings you log on the Today screen will appear here.'; return chartCard(o); }
    o.svg = drawChart({ dates: days.dates, values: vals, type: 'line', yMax: 10, yTicks: [0, 5, 10], width: width,
      title: info.name + ' rating per day, ' + shortDate(days.start) + ' to ' + shortDate(days.end),
      desc: summary + ' Gaps are days not rated or marked hard to tell.' });
    o.legend = el('ul', { class: 'chart-legend' }, [legendItem('sw-line', info.name + ' rating'), el('li', { text: 'Gap = not rated or “hard to tell”' })]);
    var rows = days.dates.slice().reverse().map(function (d) {
      var day = days.byDate[d], v = day.ratings[key];
      return [longDate(d), isNum(v) ? String(v) : day.hardToTell.indexOf(key) >= 0 ? 'Hard to tell' : 'Not rated'];
    });
    o.table = dataTable(info.name + ' by date', ['Date', info.name], rows);
    return chartCard(o);
  }

  // =====================================================================================
  // Screen
  // =====================================================================================
  function ensureCss() {
    try {
      if (document.querySelector('link[href$="css/charts.css"]')) return;
      var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/charts.css';
      document.head.appendChild(l);
    } catch (e) { /* ignore */ }
  }
  /** Load an app script once if the page did not include it (same-origin relative path). */
  var scriptLoads = {};
  function ensureScript(src, present) {
    if (present()) return Promise.resolve(true);
    if (scriptLoads[src]) return scriptLoads[src];
    scriptLoads[src] = new Promise(function (resolve) {
      var sc = document.createElement('script'); sc.src = src;
      sc.onload = function () { resolve(present()); };
      sc.onerror = function () { sc.remove(); delete scriptLoads[src]; resolve(false); };
      document.body.appendChild(sc);
    });
    return scriptLoads[src];
  }

  function render(container) {
    ensureCss();
    var alive = true, resizeTimer = null, lastWidth = 0, days = null, cleanupSummary = null;
    var range = +(HT.app && HT.app.prefGet ? HT.app.prefGet('trendsRange') : 0);
    if (RANGES.indexOf(range) < 0) range = 30;

    var root = el('div', { class: 'trends' });
    container.appendChild(root);

    var groupName = 'tr-range-' + (++svgUid);
    var rangeBox = el('fieldset', { class: 'range-picker' }, [el('legend', { text: 'Show the last' })]);
    var seg = el('div', { class: 'seg' });
    RANGES.forEach(function (r) {
      var inp = el('input', { type: 'radio', name: groupName, value: String(r), checked: r === range });
      inp.checked = r === range;
      inp.addEventListener('change', function () { if (inp.checked) { range = r; if (HT.app && HT.app.prefSet) HT.app.prefSet('trendsRange', String(r)); load(); } });
      seg.appendChild(el('label', { class: 'choice' }, [inp, el('span', { text: r + ' days' })]));
    });
    rangeBox.appendChild(seg);
    root.appendChild(rangeBox);

    var summaryBtn = el('button', { type: 'button', class: 'btn', text: 'Printable summary for a doctor' });
    root.appendChild(el('p', null, summaryBtn));
    var status = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: 'Loading…' });
    root.appendChild(status);
    var charts = el('div', { class: 'charts' });
    root.appendChild(charts);
    root.appendChild(el('div', { class: 'disclaimer' }, [
      el('p', { text: 'Not medical advice. This is a personal log of your own entries and watch estimates. It does not diagnose any condition. Talk with a qualified health professional about health questions.' })
    ]));

    function width() { return Math.max(260, Math.min(680, (charts.clientWidth || container.clientWidth || 340) - 28)); }

    function draw() {
      if (!alive || !days) return;
      charts.textContent = '';
      var w = width(); lastWidth = w;
      charts.appendChild(sleepCard(days, w));
      charts.appendChild(stepsCard(days, w));
      RATINGS.forEach(function (k) { charts.appendChild(ratingCard(days, k, w)); });
    }

    function load() {
      status.textContent = 'Loading…';
      loadDays(range).then(function (d) {
        if (!alive) return;
        days = d;
        status.textContent = 'Last ' + range + ' days: ' + longDate(d.start) + ' to ' + longDate(d.end) + '.';
        draw();
      }).catch(function () {
        if (!alive) return;
        status.textContent = 'Your data could not be read on this device, so trends can’t be shown.';
      });
    }

    summaryBtn.addEventListener('click', function () {
      ensureScript('js/summary.js', function () { return !!(HT.summary && HT.summary.render); }).then(function (ok) {
        if (!alive) return;
        if (!ok) { status.textContent = 'The summary could not be opened.'; return; }
        root.hidden = true;
        var holder = el('div', { class: 'summary-holder' });
        container.appendChild(holder);
        cleanupSummary = HT.summary.render(holder, {
          days: range === 7 ? 30 : range,
          onBack: function () {
            if (typeof cleanupSummary === 'function') cleanupSummary();
            cleanupSummary = null;
            holder.remove(); root.hidden = false;
            try { summaryBtn.focus(); } catch (e) { /* ignore */ }
          }
        });
      });
    });

    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (alive && !root.hidden && Math.abs(width() - lastWidth) > 24) draw(); }, 200);
    }
    window.addEventListener('resize', onResize);
    load();

    return function cleanup() {
      alive = false; clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      if (typeof cleanupSummary === 'function') { try { cleanupSummary(); } catch (e) { /* ignore */ } }
    };
  }

  HT.trends = {
    render: render,
    SLEEP_REF_H: SLEEP_REF_H,
    RATINGS: RATINGS,
    RATING_INFO: RATING_INFO,
    TAG_LABELS: TAG_LABELS,
    CARB_LABELS: CARB_LABELS,
    // shared helpers for patterns.js / summary.js
    ensureCss: ensureCss,
    ensureScript: ensureScript,
    el: el,
    dataTable: dataTable,
    fmt: { int: fmtInt, one: fmt1, hm: fmtHM, hours: fmtHours, shortDate: shortDate, longDate: longDate },
    data: {
      normalizeSleepRow: normalizeSleepRow,
      pickSteps: pickSteps,
      isLogged: isLogged,
      buildDays: buildDays,
      series: series,
      describe: describe,
      sleepStats: sleepStats,
      hardToTellCount: hardToTellCount,
      dateList: dateList,
      addDays: addDays,
      fromHealthDays: fromHealthDays,
      loadRaw: loadRaw,
      loadDays: loadDays,
      /** Tests/demo only: inject { load(start, end) -> raw }. Pass null to restore IndexedDB. */
      setSource: function (src) { injected = src || null; }
    },
    _drawChart: drawChart,
    _niceMax: niceMax
  };
})(window.HT = window.HT || {});
