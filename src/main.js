/**
 * Wiring. The only file that owns a clock.
 */

import { createSession, STATES } from './engine/session.js';
import { createRng, buildPool } from './engine/selector.js';
import { createSpeech } from './audio/speech.js';
import { createAudio } from './audio/context.js';
import { createWakeLock } from './audio/wakelock.js';
import { createStorage } from './store/storage.js';
import { createSettingsStore } from './store/settings.js';
import { createLibrary } from './store/library.js';
import { createHistory, newSessionId, comboFrequency } from './store/history.js';
import { TAG_LABEL } from './store/library.js';
import { createRouter } from './ui/router.js';
import { createHomeScreen } from './ui/screens/home.js';
import { createWorkoutScreen } from './ui/screens/workout.js';
import { createSettingsScreen } from './ui/screens/settings.js';
import { createCombosScreen } from './ui/screens/combos.js';
import { createHistoryScreen } from './ui/screens/history.js';

const TICK_MS = 100;

const app = {
  config: null,
  combos: [],
  storage: null,
  settings: null,
  speech: null,
  audio: null,
  wakeLock: null,
  router: null,
  screens: {},
  session: null,
  timer: null,
  lastTab: 'home',
};

async function boot() {
  const [config, library] = await Promise.all([
    fetch('./data/config.json').then((r) => r.json()),
    fetch('./data/combos.json').then((r) => r.json()),
  ]);
  app.config = config;
  app.combos = library.combos;

  app.storage = createStorage();
  app.settings = createSettingsStore({ config, storage: app.storage });
  app.library = createLibrary({ shipped: app.combos, storage: app.storage });
  app.history = createHistory({ storage: app.storage });

  applyTheme(app.settings.get('darkMode'));

  // The live store, not app.settings.all — a copy freezes voice and speed.
  app.speech = createSpeech({ config, settings: app.settings });
  app.audio = createAudio({ config });
  app.wakeLock = createWakeLock({ onChange: updateWakeStatus });

  app.router = createRouter({
    onEnter: (id) => {
      if (id !== 'workout') app.lastTab = id;
      app.screens[id]?.refresh?.();
    },
  });

  app.screens.home = createHomeScreen({
    root: document.getElementById('screen-home'),
    settings: app.settings,
    config,
    library: app.library,
    history: app.history,
    onStart: startWorkout,
  });

  app.screens.workout = createWorkoutScreen({
    root: document.getElementById('screen-workout'),
    onPause: togglePause,
    onAbort: abortWorkout,
  });

  app.screens.combos = createCombosScreen({
    root: document.getElementById('screen-combos'),
    library: app.library,
    settings: app.settings,
    history: app.history,
    onChange: () => app.screens.home.refresh(),
  });

  app.screens.history = createHistoryScreen({
    root: document.getElementById('screen-history'),
    history: app.history,
    onRepeat: repeatSession,
  });

  app.screens.settings = createSettingsScreen({
    root: document.getElementById('screen-settings'),
    settings: app.settings,
    speech: app.speech,
    onThemeChange: applyTheme,
    onReset: resetAll,
    app,
  });

  app.router.show('home');

  if (!app.storage.available) {
    app.screens.home.notice(
      'Storage is unavailable, so settings will not be remembered. ' +
      'This usually means Safari private browsing.'
    );
  } else if (!app.wakeLock.supported) {
    app.screens.home.notice(
      'Screen wake lock is unavailable here, so the screen may sleep mid-workout. ' +
      'Raise Settings &rsaquo; Display &amp; Brightness &rsaquo; Auto-Lock.'
    );
  }
}

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/* ------------------------------------------------------------------ *
 * Workout lifecycle
 * ------------------------------------------------------------------ */

async function startWorkout() {
  const settings = app.settings.all;

  // The engine draws from the merged library, not the shipped file, so
  // disabling a combo actually removes it from the workout.
  const focus = app.settings.get('focus') || null;
  const pool = buildPool(app.library.activePool(), {
    sport: settings.sport,
    tier: settings.tier,
    focus,
  });
  if (!pool.length) {
    const reason = focus
      ? `No combos match the "${focus}" filter for ${settings.sport}. Change the focus or add more combos.`
      : `No active combos for ${settings.sport}. Turn some back on in Combos.`;
    app.screens.home.notice(reason);
    return;
  }
  if (focus && pool.length < 3) {
    app.screens.home.notice(
      `Only ${pool.length} combo${pool.length === 1 ? '' : 's'} match "${focus}" — add more or change the filter.`
    );
  }

  // Everything iOS gates behind a user gesture happens synchronously here.
  app.speech.prime();
  await app.audio.prime();
  app.audio.startKeepAlive();

  const focusWeak = app.settings.get('focusWeak');
  const comboFrequencyMap = focusWeak
    ? comboFrequency(app.history.all(), { sport: settings.sport })
    : null;

  app.session = createSession({
    config: app.config,
    settings,
    combos: app.library.activePool(),
    rng: createRng(Date.now() >>> 0),
    intensity: app.settings.resolveIntensity(),
    focusWeak,
    comboFrequencyMap,
    focus,
  });

  // The session clock is performance.now(), which says nothing about the date.
  // Capture the wall clock separately for the history record.
  app.startedAtISO = new Date().toISOString();
  app.combosCalledIds = [];
  app.workoutFocus = focus;
  app.workoutFocusWeak = focusWeak;

  app.screens.workout.clearCombo();
  app.screens.workout.setStatus('');
  app.router.show('workout');

  handle(app.session.start(now()));
  // Not awaited: the screen lock is desirable but not a prerequisite, and
  // nothing should be able to delay the first bell. Status updates arrive via
  // the wake lock's own callback.
  app.wakeLock.request();
  handle(app.session.ready(now()));

  clearInterval(app.timer);
  app.timer = setInterval(loop, TICK_MS);
}

function loop() {
  if (!app.session) return;
  handle(app.session.tick(now()));
  // handle() may have ended the workout — the last tick of the last round
  // emits 'finished', which clears the session out from under us.
  if (!app.session) return;
  app.screens.workout.render(app.session.snapshot(now()));
}

function handle(events) {
  for (const e of events) {
    switch (e.type) {
      case 'say':
        app.speech.speak(e.text).then(() => {
          if (e.tag === 'combo' && app.session) handle(app.session.speechEnded(now()));
        });
        break;
      case 'bell':
        app.audio.bell();
        break;
      case 'combo':
        app.screens.workout.setCombo(e.combo.display);
        app.combosCalledIds.push(e.combo.id);
        break;
      case 'cancelSpeech':
        app.speech.cancel();
        break;
      case 'state':
        if (e.to === STATES.REST || e.to === STATES.COUNTDOWN) {
          app.screens.workout.clearCombo();
        }
        break;
      case 'finished':
        finished(e.summary);
        break;
      default:
        break;
    }
  }
}

function finished(summary) {
  clearInterval(app.timer);
  app.timer = null;
  app.audio.stopKeepAlive();
  app.speech.cancel();
  app.wakeLock.release();
  app.session = null;

  // Spec 6.3: an abandoned workout is only recorded if a round actually
  // finished. history.add applies that rule and returns null if it discarded it.
  const saved = app.history.add({
    id: newSessionId(),
    startedAt: app.startedAtISO ?? new Date().toISOString(),
    sport: summary.sport,
    tier: summary.tier,
    intensity: summary.intensity,
    rounds: summary.rounds,
    roundLengthSec: summary.roundLengthSec,
    restSec: summary.restSec,
    durationSec: summary.durationSec,
    combosCalled: summary.combosCalled,
    combosCalledIds: app.combosCalledIds ?? [],
    completed: summary.completed,
    roundsPlanned: summary.roundsPlanned,
    focus: app.workoutFocus ?? undefined,
    focusWeak: app.workoutFocusWeak,
  });
  app.screens.history.refresh();

  app.router.show(app.lastTab === 'workout' ? 'home' : app.lastTab);
  app.screens.home.notice(
    `${summary.completed ? 'Workout complete' : 'Workout stopped'} — ` +
    `${summary.rounds} round${summary.rounds === 1 ? '' : 's'}, ` +
    `${summary.combosCalled} combos, ${Math.round(summary.durationSec)}s.` +
    (saved ? '' : ' Not saved to history — no round was finished.')
  );
}

/**
 * Load a past session's settings onto Home (spec 8).
 *
 * Uses the rounds that were PLANNED — a workout stopped after 3 of 8 should
 * repeat as 8. Records from before roundsPlanned existed fall back to the
 * rounds finished. Focus is always written, even as null: leaving the old one
 * in place after switching sport can produce an empty pool.
 */
function repeatSession(record) {
  const rounds = record.roundsPlanned ?? record.rounds;
  app.settings.set('sport', record.sport);
  app.settings.set('tier', record.tier);
  app.settings.set('intensity', record.intensity);
  app.settings.set('roundLengthMin', Math.round(record.roundLengthSec / 60));
  app.settings.set('roundsPerWorkout', rounds);
  app.settings.set('restBetweenRoundsSec', record.restSec);
  app.settings.set('focus', record.focus ?? null);
  if (typeof record.focusWeak === 'boolean') app.settings.set('focusWeak', record.focusWeak);

  app.screens.home.refresh();
  app.screens.settings.refresh();
  app.router.show('home');
  app.screens.home.notice(
    `Loaded that session: ${record.sport}, ${record.tier}, ${record.intensity}, ` +
    `${rounds} &times; ${Math.round(record.roundLengthSec / 60)} min` +
    (record.focus ? `, ${TAG_LABEL[record.focus] ?? record.focus} focus.` : '.')
  );
}

function togglePause() {
  if (!app.session) return;
  const snap = app.session.snapshot(now());
  handle(snap.paused ? app.session.resume(now()) : app.session.pause(now()));
  app.screens.workout.render(app.session.snapshot(now()));
  updateStatus();
}

function abortWorkout() {
  if (app.session) handle(app.session.abort(now()));
}

function resetAll() {
  app.storage.clearAll();
  app.settings.reset();
  app.library.reset();
  app.history.clear();
  applyTheme(app.settings.get('darkMode'));
  app.screens.home.refresh();
  app.screens.combos.refresh();
  app.screens.history.refresh();
  app.screens.settings.refresh();
  app.screens.home.notice('All data reset to defaults.');
}

/* Spec 7.3 — timers and speech are unreliable in the background. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !app.session) return;
  const snap = app.session.snapshot(now());
  if (snap.paused) return;
  handle(app.session.pause(now()));
  updateStatus();
});

/**
 * One place decides what the status line says, because backgrounding the app
 * fires the auto-pause and the wake lock release together — and whichever
 * arrived second used to wipe the other's message.
 */
function updateStatus() {
  if (!app.session) return;
  const paused = app.session.snapshot(now()).paused;
  if (paused) {
    app.screens.workout.setStatus(
      document.visibilityState === 'hidden' || document.hidden
        ? 'Auto-paused when the app went to the background.'
        : 'Paused.'
    );
  } else if (app.wakeLock.supported && !app.wakeLock.held) {
    app.screens.workout.setStatus('Screen lock released — the screen may sleep.');
  } else {
    app.screens.workout.setStatus('');
  }
}

const updateWakeStatus = updateStatus;

function now() { return performance.now(); }

/**
 * Offline support. Registered after boot so a failure here can never stop the
 * app loading — worst case you simply need a connection.
 * Not available over plain http on a LAN address, which is why serve.py
 * defaults to https.
 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    app.swStatus = 'unavailable';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    app.swStatus = reg.active ? 'active' : 'installing';
    reg.addEventListener('updatefound', () => { app.swStatus = 'updating'; });

    const sw = reg.installing || reg.waiting || reg.active;
    if (sw && sw.state !== 'activated') {
      await new Promise((resolve) => {
        sw.addEventListener('statechange', (e) => {
          if (e.target.state === 'activated') { app.swStatus = 'active'; resolve(); }
        });
      });
    }

    await primeCacheFromPage();
    readSwVersion();
  } catch (err) {
    app.swStatus = `error: ${err.message}`;
  }
}

/** The SW already answers 'cache-status'; its version is the build number. */
function readSwVersion() {
  const sw = navigator.serviceWorker.controller;
  if (!sw) return;
  const handler = (e) => {
    if (e.data?.type !== 'cache-status') return;
    navigator.serviceWorker.removeEventListener('message', handler);
    app.swVersion = e.data.version;
    app.screens.settings?.refresh();
  };
  navigator.serviceWorker.addEventListener('message', handler);
  sw.postMessage('cache-status');
}

async function primeCacheFromPage() {
  const sw = navigator.serviceWorker.controller;
  if (!sw) {
    app.swCacheCount = 0;
    return;
  }
  return new Promise((resolve) => {
    const handler = (e) => {
      if (e.data?.type === 'prime-result') {
        navigator.serviceWorker.removeEventListener('message', handler);
        app.swCacheCount = e.data.total;
        app.swStatus = e.data.total >= e.data.expected ? 'active' : 'active (incomplete)';
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    sw.postMessage('prime-cache');
    setTimeout(() => { resolve(); }, 5000);
  });
}

boot().catch((err) => {
  const el = document.getElementById('app');
  el.innerHTML = `<div style="color:#fff;padding:2rem;font:1rem/1.5 system-ui">
    <p><b>Failed to start:</b> ${err.message}</p>
    <p style="margin-top:1rem;color:#999">If you are offline, the app's cache may
    not have been set up. Open the app once while on the same Wi-Fi as your Mac,
    check Settings → About for "Offline ready: yes", then try again.</p>
  </div>`;
});

window.addEventListener('load', () => { registerServiceWorker(); });
