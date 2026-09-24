/**
 * History: what you have done, and a way to do it again.
 */

import {
  PERIODS, PERIOD_LABEL,
  formatDuration, formatTotal, formatTime, formatDayHeading,
} from '../../store/history.js';
import { SPORT_LABEL, TAG_LABEL } from '../../store/library.js';
import { openPicker } from '../components/picker.js';

export function createHistoryScreen({ root, history, onRepeat }) {
  let period = 'month';

  root.innerHTML = `
    <div class="combos-head">
      <h1 class="page-title">History</h1>
      <button class="period-btn" id="period-btn"></button>
    </div>
    <div class="tiles" id="history-tiles"></div>
    <div id="history-list"></div>
  `;

  const tilesEl = root.querySelector('#history-tiles');
  const listEl = root.querySelector('#history-list');
  const periodBtn = root.querySelector('#period-btn');

  periodBtn.addEventListener('click', () => {
    openPicker({
      title: 'Show',
      options: PERIODS,
      value: period,
      format: (p) => PERIOD_LABEL[p],
      onSelect: (p) => { period = p; render(); },
    });
  });

  function tile(value, label, accent = false) {
    return `<div class="tile">
      <div class="tile-value${accent ? ' accent' : ''}">${value}</div>
      <div class="tile-label">${label}</div>
    </div>`;
  }

  function render() {
    periodBtn.innerHTML = `${PERIOD_LABEL[period]} <span class="chev">&or;</span>`;

    const s = history.summary(period);
    tilesEl.innerHTML =
      tile(s.sessions, 'Sessions') +
      tile(s.rounds, 'Rounds') +
      tile(formatTotal(s.totalSec), 'Total time', true) +
      tile(s.streak, 'Day streak', true);

    const groups = history.groupedByDay(period);
    listEl.innerHTML = '';

    if (!groups.length) {
      listEl.innerHTML = `<div class="placeholder">
        ${history.all().length
          ? 'Nothing in this period'
          : 'No sessions yet — finish a workout and it will appear here'}
      </div>`;
      return;
    }

    for (const group of groups) {
      const head = document.createElement('div');
      head.className = 'day-head';
      head.innerHTML = `<span>${formatDayHeading(group.day)}</span><span class="rule"></span>`;
      listEl.appendChild(head);
      for (const record of group.records) listEl.appendChild(card(record));
    }
  }

  function card(r) {
    const el = document.createElement('div');
    el.className = 'session-card';
    if (!r.completed) el.classList.add('incomplete');

    // Every round is the same length, so the per-round chips are derived
    // rather than stored.
    const chips = Array.from({ length: r.rounds }, (_, i) =>
      `<span class="round-chip">R${i + 1} &middot; ${formatDuration(r.roundLengthSec)}</span>`
    ).join('');

    el.innerHTML = `
      <div class="session-top">
        <span class="session-meta">${SPORT_LABEL[r.sport]} &middot; ${r.tier} &middot; ${r.intensity}${r.focus ? ` &middot; ${TAG_LABEL[r.focus] ?? r.focus}` : ''}${r.focusWeak ? ' &middot; weak spots' : ''}${r.mode ? ` &middot; ${r.mode}` : ''}</span>
        <span class="session-time">${formatTime(r.startedAt)}</span>
      </div>
      <div class="session-title">
        ${SPORT_LABEL[r.sport]} session
        ${r.completed ? '' : '<span class="tag-incomplete">Stopped early</span>'}
      </div>
      <div class="session-stats">
        <div class="tile"><div class="tile-value">${formatDuration(r.durationSec)}</div><div class="tile-label">Duration</div></div>
        <div class="tile"><div class="tile-value">${r.rounds}</div><div class="tile-label">Rounds</div></div>
        <div class="tile"><div class="tile-value">${Math.round(r.roundLengthSec / 60)} min</div><div class="tile-label">Rd length</div></div>
        <div class="tile"><div class="tile-value">${formatDuration(r.restSec)}</div><div class="tile-label">Rest</div></div>
      </div>
      ${chips ? `<div class="round-chips">${chips}</div>` : ''}
      <div class="session-combos">${r.combosCalled} combos called</div>
      <button class="repeat" data-repeat="${r.id}">&#9654; Repeat session</button>
    `;
    return el;
  }

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-repeat]');
    if (!btn) return;
    const record = history.all().find((r) => r.id === btn.dataset.repeat);
    if (record) onRepeat?.(record);
  });

  render();
  return { refresh: render };
}
