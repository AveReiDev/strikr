/**
 * The round / rest state machine.
 *
 * This file owns no timers and never asks what time it is. It is *told* the
 * time by whoever is driving it — the real app does that ten times a second,
 * a test does it in whatever jumps it likes. Everything it wants doing comes
 * back as a list of events; it never speaks, beeps, or touches the screen
 * itself.
 *
 *   IDLE -> PREPARING -> COUNTDOWN -> ROUND -> REST -> ROUND ... -> COMPLETE
 */

import { createSelector } from './selector.js';
import { createLadderSelector, LADDER_MODES } from './ladder.js';
import {
  gapMsFor,
  voiceRate,
  estimateSpeechMs,
  canStartCallout,
  applyPronunciation,
} from './timing.js';

export const STATES = {
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  COUNTDOWN: 'COUNTDOWN',
  ROUND: 'ROUND',
  REST: 'REST',
  COMPLETE: 'COMPLETE',
};

/** Seconds remaining in a rest at which we announce something. */
const REST_ANNOUNCE_AT = [10, 3, 2, 1];

export function createSession({ config, settings, combos, rng, intensity: override, focusWeak, comboFrequencyMap, focus }) {
  // `override` lets Custom intensity supply the user's own numbers while
  // keeping the same shape as a built-in one.
  const intensity = override ?? config.intensity[settings.intensity];
  const rate = voiceRate(settings.voiceSpeedPct, config.voiceRateRange);
  const roundMs = settings.roundLengthMin * 60 * 1000;
  const restMs = settings.restBetweenRoundsSec * 1000;
  const countdownMs = settings.countdownSec * 1000;

  const selectorArgs = {
    combos,
    sport: settings.sport,
    tier: settings.tier,
    config,
    rng,
    focusWeak,
    comboFrequencyMap,
    focus,
  };
  const selector = LADDER_MODES.includes(settings.workoutMode)
    ? createLadderSelector({ ...selectorArgs, mode: settings.workoutMode, reps: settings.ladderReps ?? 1 })
    : createSelector(selectorArgs);

  let state = STATES.IDLE;
  let phaseStart = 0;
  let paused = false;
  let pausedAt = 0;

  let roundIndex = 0;            // 1-based once a round starts
  let roundsCompleted = 0;
  let combosCalled = 0;

  let awaitingSpeech = false;
  let gapStart = null;           // when the current gap began
  let currentGapMs = 0;
  let currentCombo = null;
  let pendingCombo = null;       // drawn but held back by the lookahead

  let startedAt = null;
  const said = new Set();        // announcements already made this phase

  const events = [];
  const emit = (e) => events.push(e);
  const drain = () => events.splice(0, events.length);

  function transition(to, now) {
    const from = state;
    state = to;
    phaseStart = now;
    said.clear();
    emit({ type: 'state', from, to });
  }

  /** While paused the clock is frozen at the moment pause was pressed. */
  function elapsed(now) {
    return (paused ? pausedAt : now) - phaseStart;
  }

  function remainingMs(now) {
    if (state === STATES.ROUND) return roundMs - elapsed(now);
    if (state === STATES.REST) return restMs - elapsed(now);
    if (state === STATES.COUNTDOWN) return countdownMs - elapsed(now);
    return 0;
  }

  function enterRound(now) {
    roundIndex += 1;
    transition(STATES.ROUND, now);
    emit({ type: 'bell' });
    // Give the base gap before the first callout so the bell is not talked over.
    awaitingSpeech = false;
    pendingCombo = null;
    currentCombo = null;
    selector.startRound?.();   // a ladder opens every round on rung one
    gapStart = now;
    currentGapMs = intensity.baseGapMs;
  }

  function finish(now, completed) {
    const summary = {
      startedAt,
      sport: settings.sport,
      tier: settings.tier,
      intensity: settings.intensity,
      rounds: roundsCompleted,
      roundsPlanned: settings.roundsPerWorkout,
      mode: settings.workoutMode ?? 'random',
      roundLengthSec: settings.roundLengthMin * 60,
      restSec: settings.restBetweenRoundsSec,
      durationSec: Math.round((now - (startedAt ?? now)) / 1000),
      combosCalled,
      completed,
    };
    transition(completed ? STATES.COMPLETE : STATES.IDLE, now);
    emit({ type: 'finished', summary });
  }

  function tickCountdown(now) {
    const left = countdownMs - elapsed(now);
    if (left <= 0) { enterRound(now); return; }
    const secs = Math.ceil(left / 1000);
    if (!said.has(secs)) {
      said.add(secs);
      emit({ type: 'say', text: String(secs), tag: 'countdown' });
    }
  }

  function tickRound(now) {
    const left = roundMs - elapsed(now);

    if (left <= 0) {
      roundsCompleted += 1;
      emit({ type: 'bell' });
      if (roundIndex >= settings.roundsPerWorkout) finish(now, true);
      else transition(STATES.REST, now);
      return;
    }

    if (awaitingSpeech) return;                       // voice still talking
    if (gapStart !== null && now - gapStart < currentGapMs) return;   // mid-gap

    // Hold a rejected combo rather than redrawing it, so the lookahead does not
    // silently burn through the pool at the end of every round.
    const combo = pendingCombo ?? selector.next();
    if (!combo) return;
    pendingCombo = combo;

    const text = applyPronunciation(combo.speech, config.pronunciation);
    const gapMs = gapMsFor(combo, intensity);
    const estSpeechMs = estimateSpeechMs(text, rate, config.speechEstimate);

    if (!canStartCallout({
      remainingMs: left,
      estSpeechMs,
      gapMs,
      lookaheadMs: config.roundEndLookaheadMs,
    })) {
      return;   // let the round run out quietly
    }

    pendingCombo = null;
    currentCombo = combo;
    currentGapMs = gapMs;
    gapStart = null;
    awaitingSpeech = true;
    combosCalled += 1;
    emit({ type: 'combo', combo });
    emit({ type: 'say', text, tag: 'combo' });
  }

  function tickRest(now) {
    const left = restMs - elapsed(now);
    if (left <= 0) { enterRound(now); return; }
    const secs = Math.ceil(left / 1000);
    if (REST_ANNOUNCE_AT.includes(secs) && !said.has(secs)) {
      said.add(secs);
      emit({
        type: 'say',
        text: secs === 10 ? '10 seconds' : String(secs),
        tag: 'rest',
      });
    }
  }

  return {
    /** IDLE -> PREPARING. The caller acquires the wake lock and primes audio. */
    start(now) {
      if (state !== STATES.IDLE) return drain();
      startedAt = now;
      roundIndex = 0;
      roundsCompleted = 0;
      combosCalled = 0;
      transition(STATES.PREPARING, now);
      emit({ type: 'prepare' });
      return drain();
    },

    /** PREPARING -> COUNTDOWN, once audio and wake lock are ready. */
    ready(now) {
      if (state !== STATES.PREPARING) return drain();
      transition(STATES.COUNTDOWN, now);
      return drain();
    },

    tick(now) {
      if (paused) return drain();
      if (state === STATES.COUNTDOWN) tickCountdown(now);
      else if (state === STATES.ROUND) tickRound(now);
      else if (state === STATES.REST) tickRest(now);
      return drain();
    },

    /** The voice has finished. The gap starts from here, not from when we asked. */
    speechEnded(now) {
      if (!awaitingSpeech) return drain();
      awaitingSpeech = false;
      gapStart = now;
      return drain();
    },

    pause(now) {
      if (paused || state === STATES.IDLE || state === STATES.COMPLETE) return drain();
      paused = true;
      pausedAt = now;
      emit({ type: 'cancelSpeech' });
      return drain();
    },

    /** Resuming gives a fresh gap rather than dropping into a half-spoken combo. */
    resume(now) {
      if (!paused) return drain();
      paused = false;
      phaseStart += now - pausedAt;
      awaitingSpeech = false;
      gapStart = now;
      if (currentGapMs <= 0) currentGapMs = intensity.baseGapMs;
      return drain();
    },

    abort(now) {
      if (state === STATES.IDLE) return drain();
      paused = false;
      emit({ type: 'cancelSpeech' });
      finish(now, false);
      return drain();
    },

    snapshot(now) {
      return {
        state,
        paused,
        roundIndex,
        roundsPerWorkout: settings.roundsPerWorkout,
        remainingMs: Math.max(0, remainingMs(now)),
        totalMs:
          state === STATES.ROUND ? roundMs
          : state === STATES.REST ? restMs
          : state === STATES.COUNTDOWN ? countdownMs
          : 0,
        combo: currentCombo,
        combosCalled,
        poolSize: selector.pool.length,
      };
    },
  };
}
