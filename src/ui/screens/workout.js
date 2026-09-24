/**
 * The workout screen.
 *
 * Read from three metres away with sweat in your eyes: huge type, high
 * contrast, minimal chrome. The next combo is shown nowhere — surprise is the
 * point.
 */

import { formatClock } from '../../engine/timing.js';
import { STATES } from '../../engine/session.js';

const PHASE_LABEL = {
  [STATES.PREPARING]: 'Get ready',
  [STATES.COUNTDOWN]: 'Starting',
  [STATES.ROUND]: 'Round',
  [STATES.REST]: 'Rest',
  [STATES.COMPLETE]: 'Done',
};

export function createWorkoutScreen({ root, onPause, onAbort }) {
  root.innerHTML = `
    <div class="wk-top">
      <span class="wk-phase" id="wk-phase"></span>
      <span class="wk-phase" id="wk-round"></span>
    </div>
    <div class="wk-clock" id="wk-clock">0:00</div>
    <div class="wk-track"><div class="wk-bar" id="wk-bar"></div></div>
    <div class="wk-combo" id="wk-combo"></div>
    <div class="wk-rung" id="wk-rung"></div>
    <div class="wk-actions">
      <button id="wk-pause">Pause</button>
      <button id="wk-abort" class="abort">Abort</button>
    </div>
    <div class="muted" id="wk-status" style="margin-top:var(--sp-4)"></div>
  `;

  const el = {
    phase: root.querySelector('#wk-phase'),
    round: root.querySelector('#wk-round'),
    clock: root.querySelector('#wk-clock'),
    bar: root.querySelector('#wk-bar'),
    combo: root.querySelector('#wk-combo'),
    rung: root.querySelector('#wk-rung'),
    pause: root.querySelector('#wk-pause'),
    status: root.querySelector('#wk-status'),
  };

  el.pause.addEventListener('click', onPause);
  root.querySelector('#wk-abort').addEventListener('click', onAbort);

  return {
    setCombo(text, sub = '') {
      el.combo.textContent = text;
      el.rung.textContent = sub;
    },
    clearCombo() {
      el.combo.textContent = '';
      el.rung.textContent = '';
    },
    setStatus(text) { el.status.textContent = text ?? ''; },

    render(snap) {
      el.phase.textContent = snap.paused
        ? 'Paused'
        : snap.finisher ? 'Finisher' : (PHASE_LABEL[snap.state] ?? snap.state);
      root.classList.toggle('finisher', Boolean(snap.finisher && !snap.paused));
      el.round.textContent =
        snap.state === STATES.ROUND || snap.state === STATES.REST
          ? `${snap.roundIndex} / ${snap.roundsPerWorkout}`
          : '';
      el.clock.textContent = formatClock(snap.remainingMs);
      el.pause.textContent = snap.paused ? 'Resume' : 'Pause';
      const pct = snap.totalMs ? (1 - snap.remainingMs / snap.totalMs) * 100 : 0;
      el.bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    },
  };
}
