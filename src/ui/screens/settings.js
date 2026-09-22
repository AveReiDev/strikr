/**
 * Settings.
 *
 * Deliberately omits the account, subscription, notification and support
 * sections visible in the reference screenshots — spec section 2 rules them out.
 */

import { CHOICES, GOAL_INTENSITIES, GOAL_ROUNDS, GOAL_ROUND_LENGTHS } from '../../store/settings.js';
import { openPicker } from '../components/picker.js';

export const APP_VERSION = '1.0.0';

export function createSettingsScreen({ root, settings, speech, onReset, onThemeChange, app: appRef }) {
  root.innerHTML = `
    <h1 class="page-title">Settings</h1>

    <div class="section-label">Appearance</div>
    <div class="card">
      <div class="row">
        <span>
          <span class="row-title">Dark mode</span>
          <span class="row-sub">Switch between light and dark theme</span>
        </span>
        <span class="row-value">
          <span class="row-icon" aria-hidden="true">&#9789;</span>
          <button class="toggle" id="dark-mode" aria-label="Dark mode"></button>
        </span>
      </div>
    </div>

    <div class="section-label">Workout</div>
    <div class="card">
      <button class="row" data-pick="roundsPerWorkout">
        <span>
          <span class="row-title">Rounds per workout</span>
          <span class="row-sub">Number of rounds in each session</span>
        </span>
        <span class="row-value"><span data-val="roundsPerWorkout"></span><span class="chev">&rsaquo;</span></span>
      </button>

      <button class="row" data-pick="restBetweenRoundsSec">
        <span>
          <span class="row-title">Rest between rounds</span>
          <span class="row-sub">Recovery time between each round</span>
        </span>
        <span class="row-value"><span data-val="restBetweenRoundsSec"></span><span class="chev">&rsaquo;</span></span>
      </button>

      <button class="row" data-pick="countdownSec">
        <span>
          <span class="row-title">Countdown timer</span>
          <span class="row-sub">Seconds before round starts</span>
        </span>
        <span class="row-value"><span data-val="countdownSec"></span><span class="chev">&rsaquo;</span></span>
      </button>

      <div class="row">
        <span>
          <span class="row-title">Voice</span>
          <span class="row-sub">Callout voice during workouts</span>
        </span>
        <span class="segment">
          <button data-voice="male">Male</button>
          <button data-voice="female">Female</button>
        </span>
      </div>

      <div class="slider-row">
        <div class="row-title">Voice speed</div>
        <div class="slider-wrap">
          <span aria-hidden="true">&#128034;</span>
          <input type="range" id="voice-speed" min="0" max="100" step="5">
          <span aria-hidden="true">&#128007;</span>
          <span class="slider-val" id="voice-speed-val"></span>
        </div>
        <button class="row" id="voice-test" style="min-height:44px;border-bottom:0;padding-left:0">
          <span class="row-title" style="color:var(--fg-dim)">Test voice</span>
        </button>
      </div>
    </div>

    <div class="section-label">Training goal</div>
    <div class="card" id="goal-card">
      <button class="row" data-pick-goal="rounds">
        <span>
          <span class="row-title">Target rounds</span>
          <span class="row-sub">Rounds per session to work toward</span>
        </span>
        <span class="row-value"><span data-goal-val="rounds"></span><span class="chev">&rsaquo;</span></span>
      </button>
      <button class="row" data-pick-goal="intensity">
        <span>
          <span class="row-title">Target intensity</span>
          <span class="row-sub">Intensity level to work toward</span>
        </span>
        <span class="row-value"><span data-goal-val="intensity"></span><span class="chev">&rsaquo;</span></span>
      </button>
      <button class="row" data-pick-goal="roundLengthMin">
        <span>
          <span class="row-title">Target round length</span>
          <span class="row-sub">Minutes per round to work toward</span>
        </span>
        <span class="row-value"><span data-goal-val="roundLengthMin"></span><span class="chev">&rsaquo;</span></span>
      </button>
    </div>
    <button class="danger" id="clear-goal" style="margin-top:var(--sp-2)">
      <span class="row-title">Clear goal</span>
      <span class="row-sub">Remove training goal and suggestions</span>
    </button>

    <div class="section-label">About</div>
    <div class="card">
      <div class="row">
        <span class="row-title">About STRIKR</span>
        <span class="row-value muted">v${APP_VERSION}</span>
      </div>
      <div class="row">
        <span>
          <span class="row-title">Offline ready</span>
          <span class="row-sub" id="offline-status">checking…</span>
        </span>
      </div>
      <div class="row">
        <span>
          <span class="row-title">Voice in use</span>
          <span class="row-sub" id="voice-name">—</span>
        </span>
      </div>
    </div>

    <div class="section-label danger-label">Danger zone</div>
    <button class="danger" id="reset-all">
      <span class="row-title">Reset all data</span>
      <span class="row-sub">Clears settings, your combo library and all history</span>
    </button>
  `;

  const fmt = {
    roundsPerWorkout: (v) => String(v),
    restBetweenRoundsSec: (v) => `${v}s`,
    countdownSec: (v) => (v === 0 ? 'Off' : `${v}s`),
  };

  const PICKER_TITLE = {
    roundsPerWorkout: 'Rounds per workout',
    restBetweenRoundsSec: 'Rest between rounds',
    countdownSec: 'Countdown timer',
  };

  const goalFmt = {
    rounds: (v) => String(v),
    intensity: (v) => v ? v[0].toUpperCase() + v.slice(1) : '—',
    roundLengthMin: (v) => `${v} min`,
  };

  function renderGoal() {
    const goal = settings.get('goal');
    const defaults = { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
    root.querySelector('[data-goal-val="rounds"]').textContent = goal ? goalFmt.rounds(goal.rounds) : goalFmt.rounds(defaults.rounds);
    root.querySelector('[data-goal-val="intensity"]').textContent = goal ? goalFmt.intensity(goal.intensity) : goalFmt.intensity(defaults.intensity);
    root.querySelector('[data-goal-val="roundLengthMin"]').textContent = goal ? goalFmt.roundLengthMin(goal.roundLengthMin) : goalFmt.roundLengthMin(defaults.roundLengthMin);
    root.querySelector('#clear-goal').style.display = goal ? '' : 'none';
  }

  function render() {
    for (const key of Object.keys(CHOICES)) {
      root.querySelector(`[data-val="${key}"]`).textContent = fmt[key](settings.get(key));
    }
    for (const b of root.querySelectorAll('[data-voice]')) {
      b.setAttribute('aria-pressed', String(b.dataset.voice === settings.get('voiceGender')));
    }
    const speed = settings.get('voiceSpeedPct');
    root.querySelector('#voice-speed').value = String(speed);
    root.querySelector('#voice-speed-val').textContent = `${speed}%`;
    root.querySelector('#dark-mode').setAttribute('aria-pressed', String(settings.get('darkMode')));
    root.querySelector('#voice-name').textContent = speech?.voiceName ?? '—';
    renderGoal();

    const offlineEl = root.querySelector('#offline-status');
    if (appRef) {
      const sw = appRef.swStatus ?? 'checking…';
      const count = appRef.swCacheCount;
      if (sw === 'active' && count >= 20) {
        offlineEl.textContent = `Yes — ${count} files cached`;
      } else if (sw === 'active') {
        offlineEl.textContent = `Service worker active but only ${count ?? '?'} files cached — reload to retry`;
      } else if (sw === 'unavailable') {
        offlineEl.textContent = 'No — service workers unavailable (needs trusted HTTPS)';
      } else if (sw.startsWith('error')) {
        offlineEl.textContent = `No — ${sw}`;
      } else {
        offlineEl.textContent = `${sw} (${count ?? '?'} files cached)`;
      }
    }
  }

  const GOAL_PICKER_OPTIONS = {
    rounds: GOAL_ROUNDS,
    intensity: GOAL_INTENSITIES,
    roundLengthMin: GOAL_ROUND_LENGTHS,
  };
  const GOAL_PICKER_TITLE = {
    rounds: 'Target rounds',
    intensity: 'Target intensity',
    roundLengthMin: 'Target round length',
  };
  const GOAL_PICKER_FMT = {
    rounds: (v) => String(v),
    intensity: (v) => v[0].toUpperCase() + v.slice(1),
    roundLengthMin: (v) => `${v} min`,
  };

  root.addEventListener('click', (e) => {
    const picker = e.target.closest('[data-pick]');
    if (picker) {
      const key = picker.dataset.pick;
      openPicker({
        title: PICKER_TITLE[key],
        options: CHOICES[key],
        value: settings.get(key),
        format: fmt[key],
        onSelect: (v) => { settings.set(key, v); render(); },
      });
      return;
    }

    const goalPicker = e.target.closest('[data-pick-goal]');
    if (goalPicker) {
      const field = goalPicker.dataset.pickGoal;
      const goal = settings.get('goal') || { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
      openPicker({
        title: GOAL_PICKER_TITLE[field],
        options: GOAL_PICKER_OPTIONS[field],
        value: goal[field],
        format: GOAL_PICKER_FMT[field],
        onSelect: (v) => {
          settings.set('goal', { ...goal, [field]: v });
          render();
        },
      });
      return;
    }

    const voice = e.target.closest('[data-voice]');
    if (voice) {
      settings.set('voiceGender', voice.dataset.voice);
      speech?.refreshVoice();
      render();
      speech?.speak('Jab, Cross');
      return;
    }
  });

  root.querySelector('#clear-goal').addEventListener('click', () => {
    settings.set('goal', null);
    render();
  });

  root.querySelector('#voice-speed').addEventListener('input', (e) => {
    settings.set('voiceSpeedPct', Number(e.target.value));
    root.querySelector('#voice-speed-val').textContent = `${e.target.value}%`;
  });

  root.querySelector('#voice-test').addEventListener('click', () => {
    speech?.speak('Jab, Cross, Lead hook, Rear body kick');
  });

  root.querySelector('#dark-mode').addEventListener('click', () => {
    settings.set('darkMode', !settings.get('darkMode'));
    onThemeChange?.(settings.get('darkMode'));
    render();
  });

  root.querySelector('#reset-all').addEventListener('click', () => {
    const ok = confirm(
      'Reset all data?\n\nThis clears your settings, your combo library and all ' +
      'workout history. It cannot be undone.'
    );
    if (ok) { onReset?.(); render(); }
  });

  render();
  return { refresh: render };
}
