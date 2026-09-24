/* Health Tracker — health-agg.js
 * Turns scanned Apple Health samples into one compact record per day.
 * Spec: docs/team/research/R-001-apple-health-export.md §6 Revision 2 (Analyst re-review:
 * docs/team/analysis/A-001-apple-health-export.md "Re-review 1"). The §6.4 worked examples
 * are the unit-test reference (tests/import-tests.js).
 *   §6.0.3 priority lists per data type, default order + user override (RR-4 "≥" insertion)
 *   §6.1   sleep per night: per-source sessions, one source per night, 18:00 boundary,
 *          bedWindow (RR-7), in-bed walk from rank 0 (RR-6), partial flag, naps,
 *          in-bed-only nights from the union of INBED samples (RR-5)
 *   §6.2   steps per day: epoch-minute slots, highest-priority source per slot,
 *          invariant topSourceSum ≤ total ≤ rawSum
 * These are design rules, not Apple's own algorithm (R-001 §6.2 "Known limits"): the app
 * says so in its help text. Nothing here logs record contents.
 *
 * Also exposes HT.healthData.getDays() (page only): the read API that other screens use.
 * Classic script; works in a page (window.HT) and in a Worker (self.HT).
 */
(function (HT) {
  'use strict';

  var HD = HT.healthDates;
  var MIN = 60000;

  // Design constants (R-001 §6.1 / §6.2; Low confidence as "truth", checked in AT-5/AT-6).
  var SESSION_GAP_MS = 60 * MIN;
  var SLEEP_DAY_BOUNDARY_MIN = 18 * 60;
  var NAP_MAX_ASLEEP_MS = 180 * MIN;
  var NAP_END_FROM_MIN = 10 * 60, NAP_END_TO_MIN = 20 * 60;
  var PARTIAL_THRESHOLD_MS = 60 * MIN;
  var SLOT_MS = MIN;

  var CLASS_NAMES = ['Entered manually', 'Apple Watch', 'iPhone', 'Other app or device'];

  // ---------- interval helpers (half-open [s, e), ms) ----------
  function union(list) {
    if (!list.length) return [];
    var a = list.slice().sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
    var out = [[a[0][0], a[0][1]]];
    for (var i = 1; i < a.length; i++) {
      var last = out[out.length - 1];
      if (a[i][0] <= last[1]) { if (a[i][1] > last[1]) last[1] = a[i][1]; }
      else out.push([a[i][0], a[i][1]]);
    }
    return out;
  }
  function totalLen(u) { var t = 0; for (var i = 0; i < u.length; i++) t += u[i][1] - u[i][0]; return t; }
  /** |A − B| where both are already unions. */
  function minusLen(A, B) {
    var t = 0, j = 0;
    for (var i = 0; i < A.length; i++) {
      var s = A[i][0], e = A[i][1], cur = s, covered = 0;
      while (j < B.length && B[j][1] <= s) j++;
      for (var k = j; k < B.length && B[k][0] < e; k++) {
        var cs = Math.max(cur, B[k][0]), ce = Math.min(e, B[k][1]);
        if (ce > cs) { covered += ce - cs; cur = ce; }
      }
      t += (e - s) - covered;
    }
    return t;
  }
  /** |U ∩ [w0, w1)| for a union U. */
  function clipLen(U, w0, w1) {
    var t = 0;
    for (var i = 0; i < U.length; i++) {
      var s = Math.max(U[i][0], w0), e = Math.min(U[i][1], w1);
      if (e > s) t += e - s;
    }
    return t;
  }
  /** Does [s, e) overlap any interval of a sorted union U? (binary search) */
  function overlapsUnion(U, s, e) {
    var lo = 0, hi = U.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (U[mid][1] <= s) lo = mid + 1;
      else if (U[mid][0] >= e) hi = mid - 1;
      else return true;
    }
    return false;
  }
  function overlapsAny(list, s, e) {
    for (var i = 0; i < list.length; i++) if (list[i][0] < e && list[i][1] > s) return true;
    return false;
  }
  function toMin(ms) { return Math.round(ms / MIN); }
  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; } // UTF-16 code-unit order

  // ---------- priority (R-001 §6.0.3) ----------
  function defaultOrder(sources, type) {
    return sources.filter(function (s) { return s.count[type] > 0; }).sort(function (a, b) {
      return (a.cls - b.cls) ||
        (b.firstSeenMs[type] - a.firstSeenMs[type]) ||   // later first sample ranks higher
        cmpStr(a.key, b.key);
    });
  }

  /**
   * Priority list for one type. saved = the user's saved order [{key, cls, name}] or null.
   * A key missing from the saved list goes directly before the first saved key whose class
   * seed is >= its own (top of its class, RR-4); several new keys keep default order.
   * Returns { order: [source], rankById: Int32Array (−1 = no data of this type) }.
   */
  function buildPriority(sources, type, saved) {
    var def = defaultOrder(sources, type);
    var order;
    if (saved && saved.length) {
      var savedKeys = Object.create(null);
      saved.forEach(function (x) { savedKeys[x.key] = true; });
      var byKey = Object.create(null);
      def.forEach(function (s) { byKey[s.key] = s; });
      var insertAt = saved.map(function () { return []; });
      insertAt.push([]);
      def.forEach(function (s) {
        if (savedKeys[s.key]) return;
        var idx = saved.length;
        for (var i = 0; i < saved.length; i++) if (saved[i].cls >= s.cls) { idx = i; break; }
        insertAt[idx].push(s);
      });
      order = [];
      for (var i = 0; i <= saved.length; i++) {
        insertAt[i].forEach(function (s) { order.push(s); });
        if (i < saved.length && byKey[saved[i].key]) order.push(byKey[saved[i].key]);
      }
    } else order = def;
    var rankById = new Int32Array(sources.length).fill(-1);
    order.forEach(function (s, r) { rankById[s.id] = r; });
    return { order: order, rankById: rankById };
  }

  /** Display names for one type: manual "(entered manually)"; shared names get the hardware. */
  function displayNames(sources, type) {
    var byName = Object.create(null), names = [];
    sources.forEach(function (s) {
      if (s.count[type] > 0 && !s.manual) byName[s.sourceName] = (byName[s.sourceName] || 0) + 1;
    });
    sources.forEach(function (s) {
      if (s.manual) names[s.id] = s.sourceName + ' (entered manually)';
      else if (byName[s.sourceName] > 1 && s.hardware) names[s.id] = s.sourceName + ' (' + s.hardware + ')';
      else names[s.id] = s.sourceName;
    });
    return names;
  }

  // ---------- sleep per night (R-001 §6.1) ----------
  function isAsleep(code) { return code >= 2; }

  function emptySleepFields() {
    return {
      kind: null, asleepMin: null, inBedMin: null, awakeMin: null, coreMin: null, deepMin: null,
      remMin: null, unspecifiedMin: null, hasStages: false, sessionCount: 0, sleepStart: null,
      sleepEnd: null, sourceUsed: null, inBedSource: null, partial: false, uncoveredMin: 0,
      altSource: null, altAsleepMin: null, napMin: 0, napCount: 0, napSources: []
    };
  }

  /**
   * store: ColumnStore('sleep'); sources: source list; rankById from buildPriority;
   * zone: HT.healthDates zone. Returns { rows: [SleepDay], diag: { partialNights } }.
   */
  function resolveSleep(store, sources, rankById, zone) {
    var names = displayNames(sources, 'sleep');
    var n = store.length;
    // Step 3: group by source, sorted by start then end.
    var bySrc = [];
    for (var i = 0; i < n; i++) {
      var sid = store.src(i);
      (bySrc[sid] || (bySrc[sid] = [])).push({ s: store.startMs(i), e: store.endMs(i), c: store.code(i) });
    }
    var srcIds = [];
    bySrc.forEach(function (list, id) {
      if (!list) return;
      list.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
      srcIds.push(id);
    });
    srcIds.sort(function (a, b) { return rankById[a] - rankById[b]; });

    var mains = Object.create(null);   // date -> { srcId -> [session] }
    var naps = [];
    var inBedBySrc = [];               // srcId -> sorted INBED samples
    var allAsleep = [];

    srcIds.forEach(function (id) {
      var list = bySrc[id], sessions = [], cur = null;
      inBedBySrc[id] = [];
      // Step 4: sessions from this source's ASLEEP + AWAKE samples (INBED not used).
      list.forEach(function (x) {
        if (x.c === 0) { inBedBySrc[id].push([x.s, x.e]); return; }
        if (isAsleep(x.c)) allAsleep.push([x.s, x.e]);
        if (cur && x.s <= cur.end + SESSION_GAP_MS) {
          if (x.e > cur.end) cur.end = x.e;
          cur.samples.push(x);
        } else {
          cur = { src: id, start: x.s, end: x.e, samples: [x] };
          sessions.push(cur);
        }
      });
      sessions.forEach(function (ss) {
        var asl = [], core = [], deep = [], rem = [], uns = [], awk = [];
        ss.samples.forEach(function (x) {
          var iv = [x.s, x.e];
          if (x.c === 1) awk.push(iv);
          else {
            asl.push(iv);
            if (x.c === 2) core.push(iv); else if (x.c === 3) deep.push(iv);
            else if (x.c === 4) rem.push(iv); else uns.push(iv);
          }
        });
        if (!asl.length) return;                         // awake-only session: discard
        var aslU = union(asl);
        // Step 5: unions, so overlapping same-source samples are not double-counted.
        ss.asleepMs = totalLen(aslU);
        ss.asleepU = aslU;
        ss.coreMs = totalLen(union(core)); ss.deepMs = totalLen(union(deep));
        ss.remMs = totalLen(union(rem)); ss.unsMs = totalLen(union(uns));
        ss.awakeMs = minusLen(union(awk), aslU);
        // Step 6: classify by the local wake time.
        var endLocal = zone.minuteOfDay(ss.end);
        var endKey = zone.dateKey(ss.end);
        if (ss.asleepMs < NAP_MAX_ASLEEP_MS && endLocal >= NAP_END_FROM_MIN && endLocal < NAP_END_TO_MIN) {
          ss.date = endKey;
          naps.push(ss);
        } else {
          ss.date = endLocal < SLEEP_DAY_BOUNDARY_MIN ? endKey : HD.addDaysKey(endKey, 1);
          var m = mains[ss.date] || (mains[ss.date] = Object.create(null));
          (m[id] || (m[id] = [])).push(ss);
        }
      });
    });

    var rows = Object.create(null);
    var allChosen = [];
    var partialNights = 0;

    // Steps 7–10: one source per night date.
    Object.keys(mains).forEach(function (D) {
      var m = mains[D];
      var ids = Object.keys(m).map(Number).sort(function (a, b) { return rankById[a] - rankById[b]; });
      var chosen = ids[0], ss = m[chosen];
      var r = emptySleepFields();
      var asleep = 0, core = 0, deep = 0, rem = 0, uns = 0, awake = 0, st = Infinity, en = -Infinity;
      var spans = [];
      ss.forEach(function (x) {
        asleep += x.asleepMs; core += x.coreMs; deep += x.deepMs; rem += x.remMs; uns += x.unsMs; awake += x.awakeMs;
        if (x.start < st) st = x.start;
        if (x.end > en) en = x.end;
        spans.push([x.start, x.end]);
      });
      var spansU = union(spans);
      spansU.forEach(function (sp) { allChosen.push(sp); });
      // Step 9: time in bed from one source, clipped to bedWindow(D) (RR-7).
      var w0 = zone.wallMs(HD.addDaysKey(D, -1), 18), w1 = zone.wallMs(D, 18);
      var b0 = Math.min(w0, st), b1 = Math.max(w1, en);
      var inBedSrc = -1, inBedList = null;
      var pick = function (id) {
        var l = (inBedBySrc[id] || []).filter(function (iv) { return overlapsAny(spansU, iv[0], iv[1]); });
        return l.length ? l : null;
      };
      inBedList = pick(chosen);
      if (inBedList) inBedSrc = chosen;
      else {
        // RR-6: the highest-ranked OTHER source, walking from rank 0 and skipping chosen.
        for (var k = 0; k < srcIds.length; k++) {
          if (srcIds[k] === chosen) continue;
          var l = pick(srcIds[k]);
          if (l) { inBedList = l; inBedSrc = srcIds[k]; break; }
        }
      }
      // Step 10: partial coverage (other sources' ASLEEP outside the chosen spans).
      var others = [], best = -1, bestMs = -1;
      ids.slice(1).forEach(function (id) {
        var sum = 0;
        m[id].forEach(function (x) { x.asleepU.forEach(function (iv) { others.push(iv); }); sum += x.asleepMs; });
        if (sum > bestMs) { bestMs = sum; best = id; }   // ids are in rank order: tie keeps lower rank
      });
      var uncovered = minusLen(union(others), spansU);
      r.kind = 'night';
      r.asleepMin = toMin(asleep);
      r.coreMin = toMin(core); r.deepMin = toMin(deep); r.remMin = toMin(rem); r.unspecifiedMin = toMin(uns);
      r.awakeMin = toMin(awake);
      r.hasStages = (r.coreMin + r.deepMin + r.remMin) > 0;
      r.sessionCount = ss.length;
      r.sleepStart = st; r.sleepEnd = en;
      r.sourceUsed = names[chosen];
      r.inBedMin = inBedList ? toMin(clipLen(union(inBedList), b0, b1)) : null;
      r.inBedSource = inBedList ? names[inBedSrc] : null;
      r.uncoveredMin = toMin(uncovered);
      r.partial = uncovered >= PARTIAL_THRESHOLD_MS;
      if (r.partial) { r.altSource = names[best]; r.altAsleepMin = toMin(bestMs); partialNights++; }
      r.date = D;
      r._chosenSrc = chosen;
      rows[D] = r;
    });

    // Step 11: naps, per calendar date, by source rank then start.
    var chosenU = union(allChosen);
    var napsByDate = Object.create(null);
    naps.forEach(function (x) { (napsByDate[x.date] || (napsByDate[x.date] = [])).push(x); });
    Object.keys(napsByDate).forEach(function (E) {
      var list = napsByDate[E].sort(function (a, b) { return (rankById[a.src] - rankById[b.src]) || (a.start - b.start); });
      var accepted = [], min = 0, srcs = [];
      list.forEach(function (x) {
        if (overlapsAny(accepted, x.start, x.end) || overlapsUnion(chosenU, x.start, x.end)) return;
        accepted.push([x.start, x.end]);
        min += x.asleepMs;
        if (srcs.indexOf(x.src) < 0) srcs.push(x.src);
      });
      if (!accepted.length) return;
      var r = rows[E];
      if (!r) { r = emptySleepFields(); r.kind = 'napOnly'; r.date = E; rows[E] = r; }
      r.napMin = toMin(min);
      r.napCount = accepted.length;
      r.napSources = srcs.map(function (id) { return names[id]; });
    });

    // Step 12: in-bed-only nights.
    var asleepU = union(allAsleep);
    var ibo = Object.create(null);     // date -> { srcId -> [samples] }
    srcIds.forEach(function (id) {
      var list = inBedBySrc[id], block = null, blocks = [];
      list.forEach(function (iv) {
        if (block && iv[0] <= block.end + SESSION_GAP_MS) {
          if (iv[1] > block.end) block.end = iv[1];
          block.samples.push(iv);
        } else { block = { start: iv[0], end: iv[1], samples: [iv] }; blocks.push(block); }
      });
      blocks.forEach(function (b) {
        if (overlapsUnion(asleepU, b.start, b.end)) return;
        var endLocal = zone.minuteOfDay(b.end), endKey = zone.dateKey(b.end);
        if (b.end - b.start < NAP_MAX_ASLEEP_MS && endLocal >= NAP_END_FROM_MIN && endLocal < NAP_END_TO_MIN) return;
        var D = endLocal < SLEEP_DAY_BOUNDARY_MIN ? endKey : HD.addDaysKey(endKey, 1);
        var m = ibo[D] || (ibo[D] = Object.create(null));
        m[id] = (m[id] || []).concat(b.samples);
      });
    });
    Object.keys(ibo).forEach(function (D) {
      if (mains[D]) return;               // a main session from any source wins
      var ids = Object.keys(ibo[D]).map(Number).sort(function (a, b) { return rankById[a] - rankById[b]; });
      var id = ids[0];
      var w0 = zone.wallMs(HD.addDaysKey(D, -1), 18), w1 = zone.wallMs(D, 18);
      var r = rows[D];
      if (!r) { r = emptySleepFields(); r.date = D; rows[D] = r; }
      r.kind = 'inBedOnly';
      r.asleepMin = null; r.awakeMin = null; r.coreMin = null; r.deepMin = null; r.remMin = null;
      r.unspecifiedMin = null; r.hasStages = false; r.sessionCount = 0;
      r.inBedMin = toMin(clipLen(union(ibo[D][id]), w0, w1));
      r.sourceUsed = names[id];
      r.inBedSource = names[id];
    });

    var out = Object.keys(rows).sort().map(function (D) { var r = rows[D]; delete r._chosenSrc; return r; });
    return { rows: out, diag: { partialNights: partialNights } };
  }

  // ---------- steps per day (R-001 §6.2) ----------
  /**
   * Returns { rows: [StepDay], dayDiag: { date -> {rawSum, topSourceSum, total, sourcesPresent} } }.
   * hooks.onCommit(slot, amount, rank) is for unit tests (per-slot checks, ST3).
   */
  function resolveSteps(store, sources, rankById, zone, hooks) {
    var names = displayNames(sources, 'steps');
    var n = store.length;
    // Step 2: order by start, then rank (sort once, after the stream ended).
    var order = new Uint32Array(n), ck = new Float64Array(n);
    for (var i = 0; i < n; i++) { order[i] = i; ck[i] = (store.startMs(i) / 1000) * 65536 + rankById[store.src(i)]; }
    order.sort(function (a, b) { return ck[a] - ck[b]; });

    var days = Object.create(null);
    function day(key) {
      return days[key] || (days[key] = { total: 0, slots: 0, kept: Object.create(null), raw: Object.create(null) });
    }
    // Step 6: day(k) with a cache of the current local day's slot range.
    var cFrom = 1, cTo = 0, cKey = null;
    function dayOf(k) {
      if (k < cFrom || k >= cTo) {
        cKey = zone.dateKey(k * SLOT_MS);
        cFrom = zone.wallMs(cKey, 0) / SLOT_MS;
        cTo = zone.wallMs(HD.addDaysKey(cKey, 1), 0) / SLOT_MS;
      }
      return cKey;
    }
    var active = new Map(), minActive = Infinity;
    function commit(k, ent) {
      var d = day(dayOf(k));
      d.total += ent.amt;
      d.slots++;
      d.kept[ent.rank] = (d.kept[ent.rank] || 0) + ent.amt;
      if (hooks && hooks.onCommit) hooks.onCommit(k, ent.amt, ent.rank);   // tests only
    }
    function commitBelow(limit) {
      if (minActive >= limit) return;
      var nextMin = Infinity, done = [];
      active.forEach(function (ent, k) {
        if (k < limit) done.push(k);
        else if (k < nextMin) nextMin = k;
      });
      done.sort(function (a, b) { return a - b; });
      done.forEach(function (k) { commit(k, active.get(k)); active.delete(k); });
      minActive = nextMin;
    }
    function allocate(k, a, r) {
      var d = day(dayOf(k));
      d.raw[r] = (d.raw[r] || 0) + a;
      var ent = active.get(k);
      if (!ent) { active.set(k, { rank: r, amt: a }); if (k < minActive) minActive = k; }
      else if (r < ent.rank) { ent.rank = r; ent.amt = a; }     // higher priority takes the slot
      else if (r === ent.rank) ent.amt += a;                     // same source adds up
    }
    for (var j = 0; j < n; j++) {
      var idx = order[j];
      var s = store.startMs(idx), e = store.endMs(idx), v = store.value(idx), r = rankById[store.src(idx)];
      var k0 = Math.floor(s / SLOT_MS);
      commitBelow(k0);                                           // Step 5
      if (e === s) { allocate(k0, v, r); continue; }
      var k1 = Math.floor((e - 1) / SLOT_MS);
      for (var k = k0; k <= k1; k++) {                           // Step 3: proportional
        var ov = Math.min(e, (k + 1) * SLOT_MS) - Math.max(s, k * SLOT_MS);
        allocate(k, v * ov / (e - s), r);
      }
    }
    commitBelow(Infinity);

    var rows = [], dayDiag = Object.create(null);
    Object.keys(days).sort().forEach(function (key) {
      var d = days[key];
      var ranks = Object.keys(d.raw).map(Number).sort(function (a, b) { return a - b; });
      var rawSum = 0;
      ranks.forEach(function (rk) { rawSum += d.raw[rk]; });
      dayDiag[key] = { rawSum: rawSum, topSourceSum: ranks.length ? d.raw[ranks[0]] : 0, total: d.total, sourcesPresent: ranks.length };
      if (!d.slots) return;                                      // no kept slot: unknown, no row
      var keptRanks = Object.keys(d.kept).map(Number).sort(function (a, b) { return a - b; });
      var bestR = keptRanks[0], nonZero = 0;
      keptRanks.forEach(function (rk) {
        if (d.kept[rk] > d.kept[bestR]) bestR = rk;             // tie keeps the lower rank
        if (d.kept[rk] > 0) nonZero++;
      });
      rows.push({ date: key, steps: Math.round(d.total), stepsSource: nameOfRank(bestR), stepsMixed: nonZero > 1 });
    });
    function nameOfRank(rk) {
      for (var q = 0; q < rankById.length; q++) if (rankById[q] === rk) return names[q];
      return null;
    }
    return { rows: rows, dayDiag: dayDiag };
  }

  /** R-001 §6.2 step 8 invariant: topSourceSum − ε ≤ total ≤ rawSum + ε. */
  function checkStepInvariant(dd) {
    var eps = 1e-6 * Math.max(1, dd.rawSum);
    return dd.topSourceSum - eps <= dd.total && dd.total <= dd.rawSum + eps;
  }

  // ---------- merge + full resolve ----------
  /** R-001 §6.2 "Stored daily record": one record per date; a missing half is null. */
  function mergeDays(sleepRows, stepRows) {
    var by = Object.create(null);
    function rec(date) {
      if (!by[date]) {
        var r = emptySleepFields();
        r.date = date; r.steps = null; r.stepsSource = null; r.stepsMixed = false;
        by[date] = r;
      }
      return by[date];
    }
    sleepRows.forEach(function (s) { var r = rec(s.date); Object.keys(s).forEach(function (k) { r[k] = s[k]; }); });
    stepRows.forEach(function (s) { var r = rec(s.date); r.steps = s.steps; r.stepsSource = s.stepsSource; r.stepsMixed = s.stepsMixed; });
    return Object.keys(by).sort().map(function (d) { return by[d]; });
  }

  function sourceSummary(sources) {
    var nSteps = displayNames(sources, 'steps'), nSleep = displayNames(sources, 'sleep');
    return sources.map(function (s) {
      return { key: s.key, sourceName: s.sourceName, hardware: s.hardware, manual: s.manual, cls: s.cls,
        names: { steps: nSteps[s.id], sleep: nSleep[s.id] },
        firstSeenMs: { steps: isFinite(s.firstSeenMs.steps) ? s.firstSeenMs.steps : null, sleep: isFinite(s.firstSeenMs.sleep) ? s.firstSeenMs.sleep : null },
        count: { steps: s.count.steps, sleep: s.count.sleep } };
    });
  }

  /**
   * Resolve a finished Scanner. savedOrder = { steps: [..] | null, sleep: [..] | null }.
   * Returns { records, days, sources, priorities, diag }.
   */
  function resolveAll(scanner, savedOrder, zone) {
    var sources = scanner.sources.list;
    var pSteps = buildPriority(sources, 'steps', savedOrder && savedOrder.steps);
    var pSleep = buildPriority(sources, 'sleep', savedOrder && savedOrder.sleep);
    var sl = resolveSleep(scanner.sleep, sources, pSleep.rankById, zone);
    var st = resolveSteps(scanner.steps, sources, pSteps.rankById, zone);
    var violations = 0;
    Object.keys(st.dayDiag).forEach(function (k) { if (!checkStepInvariant(st.dayDiag[k])) violations++; });
    var days = mergeDays(sl.rows, st.rows);
    var toEntry = function (s) { return { key: s.key, cls: s.cls }; };
    return {
      days: days,
      sources: sourceSummary(sources),
      priorities: { steps: pSteps.order.map(toEntry), sleep: pSleep.order.map(toEntry) },
      diag: { partialNights: sl.diag.partialNights, stepInvariantViolations: violations,
        stepDays: st.rows.length, sleepDays: sl.rows.length }
    };
  }

  /** Stored IndexedDB record for a full-export day (store `steps`, origin 'export'). */
  function toExportRecord(day) {
    var r = JSON.parse(JSON.stringify(day));
    r.key = r.date + ':export';
    r.origin = 'export';
    r.value = day.steps;          // `value` is the steps field checked by HT.db sanitize
    delete r.steps;
    return r;
  }

  // ---------- Shortcut sleep samples -> nights (same §6.1 rules) ----------
  var STAGE_CODE = { inBed: 0, awake: 1, asleepCore: 2, asleepDeep: 3, asleepREM: 4, asleepUnspecified: 5 };

  /**
   * samples: [{stage, startMs, endMs, source}] (the Shortcut CSV gives only a source name,
   * so every key is "src:<name>|" and the class comes from the name). savedSleepOrder is the
   * export-based saved list; entries are matched to Shortcut sources by source name.
   */
  function resolveShortcutSleep(samples, savedSleepOrder, zone) {
    var S = HT.healthScan;
    var store = new S.ColumnStore('sleep'), table = new S.SourceTable();
    samples.forEach(function (x) {
      var code = STAGE_CODE[x.stage];
      if (code === undefined || !(x.endMs > x.startMs)) return;   // 'unknown' never counts as asleep
      var src = table.get(false, x.source || '', undefined, null);
      if (x.startMs < src.firstSeenMs.sleep) src.firstSeenMs.sleep = x.startMs;
      src.count.sleep++;
      store.push(Math.floor(x.startMs / 1000), Math.floor(x.endMs / 1000), code, src.id);
    });
    var saved = null;
    if (savedSleepOrder && savedSleepOrder.length) {
      var seen = Object.create(null);
      saved = [];
      savedSleepOrder.forEach(function (x) {
        if (!x.name || x.key.indexOf('manual:') === 0) return;
        var k = S.sourceKey(false, x.name, '');
        if (seen[k]) return;
        seen[k] = true;
        saved.push({ key: k, cls: x.cls });
      });
    }
    var p = buildPriority(table.list, 'sleep', saved);
    return resolveSleep(store, table.list, p.rankById, zone).rows;
  }

  HT.healthAgg = {
    SESSION_GAP_MS: SESSION_GAP_MS,
    SLEEP_DAY_BOUNDARY_MIN: SLEEP_DAY_BOUNDARY_MIN,
    NAP_MAX_ASLEEP_MS: NAP_MAX_ASLEEP_MS,
    PARTIAL_THRESHOLD_MS: PARTIAL_THRESHOLD_MS,
    CLASS_NAMES: CLASS_NAMES,
    union: union,
    totalLen: totalLen,
    minusLen: minusLen,
    defaultOrder: defaultOrder,
    buildPriority: buildPriority,
    displayNames: displayNames,
    resolveSleep: resolveSleep,
    resolveSteps: resolveSteps,
    checkStepInvariant: checkStepInvariant,
    mergeDays: mergeDays,
    resolveAll: resolveAll,
    toExportRecord: toExportRecord,
    emptySleepFields: emptySleepFields,
    resolveShortcutSleep: resolveShortcutSleep
  };

  // ---------- read API for screens (page only) ----------
  var SLEEP_FIELDS = Object.keys(emptySleepFields());

  function pickSleep(r) {
    if (!r || !r.kind) return null;
    var o = {};
    SLEEP_FIELDS.forEach(function (k) { o[k] = r[k]; });
    return o;
  }

  /**
   * HT.healthData.getDays({ from, to }) -> Promise<[DayHealth]> sorted by date, where
   * DayHealth = { date, steps, stepsOrigin, stepsSource, stepsMixed, stepsSuspect,
   *               sleep: SleepDay-fields | null, sleepOrigin }.
   * Steps: the Shortcut value is shown over the full-export value (decisions.md
   * 2026-09-23); a Shortcut day with empty steps (null) falls back to the export.
   * Sleep: the opposite — the full-export night is shown for a wake-date both cover, and a
   * night built from Shortcut samples only fills dates the export has no night for
   * (decisions.md 2026-09-23 "SLEEP precedence"): the export knows manual entries and
   * device keys, the CSV doesn't, so its night is the less accurate reconstruction.
   * Both stay stored with their origin. Days with no data are absent.
   */
  function getDays(opts) {
    opts = opts || {};
    if (!HT.db) return Promise.resolve([]);
    var zone = opts.zone || HD.localZone;
    var saved = (HT.importHealth && HT.importHealth.getSavedOrder) ? HT.importHealth.getSavedOrder() : null;
    return Promise.all([
      HT.db.getAll('steps'),
      HT.db.getAllByIndex('sleepSamples', 'origin', 'shortcut')
    ]).then(function (res) {
      var steps = res[0], samples = res[1];
      var nights = resolveShortcutSleep(samples, saved && saved.sleep, zone);
      var by = Object.create(null);
      function get(date) {
        return by[date] || (by[date] = { date: date, steps: null, stepsOrigin: null, stepsSource: null,
          stepsMixed: false, stepsSuspect: false, sleep: null, sleepOrigin: null, _exp: null });
      }
      steps.forEach(function (r) {
        var d = get(r.date);
        if (r.origin === 'export') {
          d._exp = r;
          if (d.stepsOrigin !== 'shortcut' && r.value !== null && r.value !== undefined) {
            d.steps = r.value; d.stepsOrigin = 'export'; d.stepsSource = r.stepsSource || null; d.stepsMixed = !!r.stepsMixed;
          }
          if (!d.sleep && r.kind) { d.sleep = pickSleep(r); d.sleepOrigin = 'export'; }
        } else if (r.origin === 'shortcut' && r.value !== null && r.value !== undefined) {
          d.steps = r.value; d.stepsOrigin = 'shortcut'; d.stepsSource = 'Shortcut';
          d.stepsMixed = false; d.stepsSuspect = !!r.suspect;
        }
      });
      nights.forEach(function (n) {
        var d = get(n.date);
        if (d.sleepOrigin === 'export') return;   // export night wins (decisions.md, T002-01)
        d.sleep = pickSleep(n);
        d.sleepOrigin = 'shortcut';
      });
      return Object.keys(by).sort().filter(function (k) {
        return (!opts.from || k >= opts.from) && (!opts.to || k <= opts.to);
      }).map(function (k) { var d = by[k]; delete d._exp; return d; })
        .filter(function (d) { return d.steps !== null || d.sleep !== null; });
    });
  }

  if (typeof window !== 'undefined') HT.healthData = { getDays: getDays };
})(self.HT = self.HT || {});
