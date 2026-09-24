/* Health Tracker — history.js
 * List of past days (anything with a daily log or a meal), newest first.
 * Tap a day to open it in the day editor (#day/YYYY-MM-DD). Simple search over note text,
 * meal notes and tag names. "Open another date" lets the user fill in a missed day.
 * Exposes window.HT.history = { render(container) }.
 */
(function (HT) {
  'use strict';

  var PAGE = 60;

  function render(container) {
    var A = HT.app, D = HT.dates, el = A.el;
    var alive = true;
    var today = D.todayLocal();
    var days = [];       // [{date, log, meals:[]}]
    var shown = PAGE;

    var searchId = A.nextId('hs');
    var dateId = A.nextId('hd');
    var search = el('input', { type: 'search', id: searchId, placeholder: 'Words in notes, or a tag like “social”', autocomplete: 'off' });
    var dateIn = el('input', { type: 'date', id: dateId, max: today });
    var countEl = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    var listEl = el('ul', { class: 'history-list' });
    var moreBtn = el('button', { type: 'button', text: 'Show more', hidden: true });

    container.appendChild(el('div', { class: 'card' }, [
      el('label', { for: dateId, style: 'margin-top:0', text: 'Open another date' }),
      el('div', { class: 'row' }, [
        el('div', { style: 'flex:1 1 180px' }, [dateIn]),
        el('button', { type: 'button', class: 'primary', text: 'Open', onclick: function () {
          var v = dateIn.value;
          if (D.isValidDateStr(v) && D.daysBetween(v, today) >= 0) A.go(v === today ? '#today' : '#day/' + v);
          else dateIn.focus();
        } })
      ])
    ]));
    container.appendChild(el('label', { for: searchId, text: 'Search' }));
    container.appendChild(search);
    container.appendChild(countEl);
    container.appendChild(listEl);
    container.appendChild(moreBtn);

    function tagLabel(t) { return (HT.today && HT.today.TAG_LABELS[t]) || t; }

    function hardToTell(l, key) { return Array.isArray(l.hardToTell) && l.hardToTell.indexOf(key) >= 0; }

    // T001-10: "Hard to tell" is an answer, so it is listed ("Mood: hard to tell").
    function summary(d) {
      var parts = [];
      var l = d.log;
      if (l) {
        (HT.today ? HT.today.METRICS : []).forEach(function (m) {
          if (typeof l[m.key] === 'number') parts.push(m.name + ' ' + l[m.key]);
          else if (hardToTell(l, m.key)) parts.push(m.name + ': hard to tell');
        });
      }
      if (d.meals.length) parts.push(d.meals.length + (d.meals.length === 1 ? ' meal' : ' meals'));
      if (l && l.tags && l.tags.length) parts.push(l.tags.map(tagLabel).join(', '));
      if (l && l.notes) parts.push('has notes');
      return parts.length ? parts.join(' · ') : 'Nothing filled in';
    }

    /** A day with nothing left in it (everything cleared, no meals) is not listed. */
    function isEmptyDay(d) {
      if (d.meals.length) return false;
      var l = d.log;
      if (!l) return true;
      if (l.notes || (l.tags && l.tags.length) || (l.hardToTell && l.hardToTell.length)) return false;
      return !(HT.db.RATINGS || []).some(function (k) { return typeof l[k] === 'number'; });
    }

    function matches(d, q) {
      if (!q) return true;
      var hay = [];
      if (d.log) {
        hay.push(d.log.notes || '');
        (d.log.tags || []).forEach(function (t) { hay.push(t, tagLabel(t)); });
      }
      d.meals.forEach(function (m) { hay.push(m.note || ''); });
      return hay.join('\n').toLowerCase().indexOf(q) >= 0;
    }

    function draw() {
      var q = search.value.trim().toLowerCase();
      var filtered = days.filter(function (d) { return matches(d, q); });
      listEl.textContent = '';
      if (!days.length) {
        countEl.textContent = '';
        listEl.appendChild(el('li', { class: 'muted', text: 'No days logged yet. Days you fill in on Today will appear here.' }));
        moreBtn.hidden = true;
        return;
      }
      countEl.textContent = q
        ? filtered.length + (filtered.length === 1 ? ' day matches.' : ' days match.')
        : days.length + (days.length === 1 ? ' day logged.' : ' days logged.');
      filtered.slice(0, shown).forEach(function (d) {
        listEl.appendChild(el('li', null, [
          el('a', { href: d.date === today ? '#today' : '#day/' + d.date }, [
            el('div', { class: 'h-date', text: D.formatRelative(d.date, today) }),
            el('div', { class: 'h-sum', text: summary(d) })
          ])
        ]));
      });
      moreBtn.hidden = filtered.length <= shown;
    }

    var t = null;
    search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { shown = PAGE; draw(); }, 150); });
    moreBtn.addEventListener('click', function () { shown += PAGE; draw(); });

    Promise.all([HT.db.getAll('dailyLog'), HT.db.getAll('meals')]).then(function (res) {
      if (!alive) return;
      var byDate = {};
      res[0].forEach(function (l) { byDate[l.date] = { date: l.date, log: l, meals: [] }; });
      res[1].forEach(function (m) {
        if (!byDate[m.date]) byDate[m.date] = { date: m.date, log: null, meals: [] };
        byDate[m.date].meals.push(m);
      });
      days = Object.keys(byDate).sort().reverse().map(function (k) { return byDate[k]; })
        .filter(function (d) { return !isEmptyDay(d); });
      draw();
    }).catch(function () {
      if (!alive) return;
      listEl.appendChild(el('li', { class: 'notice', role: 'alert', text: 'Could not load your history. Try reloading.' }));
    });

    return function () { alive = false; clearTimeout(t); };
  }

  HT.history = { render: render };
})(window.HT = window.HT || {});
