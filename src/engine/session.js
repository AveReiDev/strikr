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
 *
 * After the countdown it walks a plan (src/engine/plan.js): bag rounds, rests
 * and timed segments. A warm-up adds TIMED -> REST before the first round.
 * Round numbers, ramp up and finishers count bag rounds only.
 */

import { createSelector, buildPool } from './selector.js';
import { createLadderSelector, LADDER_MODES } from './ladder.js';
import { createDefenseSelector } from './defense.js';
import { buildPlan } from './plan.js';
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
  TIMED: 'TIMED',
  COMPLETE: 'COMPLETE',
};

/** Seconds remaining in a rest at which we announce something. */
const REST_ANNOUNCE_AT = [10, 3, 2, 1];

export function createSession({ config, settings, combos, rng, intensity: override, focusWeak, comboFrequencyMap, focus }) {
  // `override` lets Custom intensity supply the user's own numbers while
  // keeping the same shape as a built-in one.
  const peak = override ?? config.intensity[settings.intensity];
  let intensity = peak;   // this round's timing; differs from peak only when ramping
  const rate = voiceRate(settings.voiceSpeedPct, config.voiceRateRange);
  const roundMs = settings.roundLengthMin * 60 * 1000;
  const countdownMs = settings.countdownSec * 1000;

  // No steps (a missing or empty routine) means no warm-up at all.
  const routine = settings.warmupMin ? config.warmups?.routines?.[String(settings.warmupMin)] : null;
  const warmupSteps = routine?.length ? routine : null;
  const plan = buildPlan(settings, { warmup: warmupSteps, rate, config });
  let segIndex = -1;
  let restMs = 0;                // the current rest segment's length
  let timed = null;              // the current timed segment
  let nextCue = 0;               // index of the next cue not yet due
  let stepIndex = -1;            // the timed step on screen

  const selectorArgs = {
    combos,
    sport: settings.sport,
    tier: settings.tier,
    config,
    rng,
    focusWeak,
    comboFrequencyMap,
    focus,
    emphasis: settings.emphasis,
  };
  const selector = LADDER_MODES.includes(settings.workoutMode)
    ? createLadderSelector({ ...selectorArgs, mode: settings.workoutMode, reps: settings.ladderReps ?? 1 })
    : settings.workoutMode === 'defense'
      ? createDefenseSelector(createSelector(selectorArgs), { moves: config.moves?.defense, strikes: config.strikes, rng })
      : createSelector(selectorArgs);

  // Defense mode: the defense is called once the combo has had time to land
  // (its per-action time) plus a short beat, like the opponent's return.
  const defenseDelayMs = config.defense?.delayMs ?? 300;
  const defenseTiming = (combo) => {
    const d = combo.defense;
    if (!d) return null;
    const text = applyPronunciation(d.speech, config.pronunciation);
    return {
      text,
      beforeMs: intensity.perActionMs * combo.actions + defenseDelayMs,
      estSpeechMs: estimateSpeechMs(text, rate, config.speechEstimate),
      afterMs: gapMsFor(d, intensity),
    };
  };

  // Finisher: the last stretch of each round calls short combos, fast. It has
  // its own selector over just the short combos, so the main one (and a
  // ladder's place in its climb) is untouched. Capped at half the round.
  const fin = config.finisher;
  const finisherMs = Math.min((settings.finisherSec ?? 0) * 1000, roundMs / 2);
  const finisherPool = finisherMs > 0
    ? buildPool(combos, { sport: settings.sport, tier: settings.tier, focus })
      .filter((c) => c.actions <= fin.maxActions)
    : [];
  const finisherSelector = finisherPool.length
    ? createSelector({ ...selectorArgs, combos: finisherPool, balanced: false, emphasis: 'off' })
    : null;
  let finisherAnnounced = false;

  /**
   * Ramp up: round 1 carries the configured extra gap, shrinking evenly to
   * none by the last round. A one-round workout is simply the peak.
   */
  function intensityForRound(index) {
    const n = settings.roundsPerWorkout;
    if (!settings.rampUp || n <= 1) return peak;
    const extra = Math.round(config.ramp.startExtraGapMs * (n - index) / (n - 1));
    return { ...peak, baseGapMs: peak.baseGapMs + extra };
  }

  function inFinisher(now) {
    return finisherSelector !== null && state === STATES.ROUND
      && roundMs - elapsed(now) <= finisherMs;
  }

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
  let pendingDefense = null;     // to call once the current combo's beat is up

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
    if (state === STATES.TIMED) return timed.durationMs - elapsed(now);
    if (state === STATES.COUNTDOWN) return countdownMs - elapsed(now);
    return 0;
  }

  /** Move on to the next plan segment, or finish after the last. */
  function advance(now) {
    segIndex += 1;
    const seg = plan[segIndex];
    if (!seg) { finish(now, true); return; }
    if (seg.type === 'bag') { enterRound(now); return; }
    if (seg.type === 'rest') {
      restMs = seg.durationMs;
      transition(STATES.REST, now);
      if (seg.enterSay) emit({ type: 'say', text: seg.enterSay, tag: 'rest' });
      return;
    }
    timed = seg;
    nextCue = 0;
    stepIndex = -1;
    transition(STATES.TIMED, now);
  }

  function enterRound(now) {
    roundIndex += 1;
    intensity = intensityForRound(roundIndex);
    finisherAnnounced = false;
    transition(STATES.ROUND, now);
    emit({ type: 'bell' });
    // Give the base gap before the first callout so the bell is not talked over.
    awaitingSpeech = false;
    pendingCombo = null;
    pendingDefense = null;
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
      emphasis: settings.emphasis ?? 'off',
      warmupMin: warmupSteps ? settings.warmupMin : 0,
      rampUp: Boolean(settings.rampUp),
      finisherSec: finisherSelector ? settings.finisherSec : 0,
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
    if (left <= 0) { advance(now); return; }
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
      advance(now);
      return;
    }

    if (awaitingSpeech) return;                       // voice still talking

    // The defense goes before anything else, the finisher included: the
    // lookahead already reserved its time along with the combo's.
    if (pendingDefense) {
      if (now - gapStart < currentGapMs) return;
      const d = pendingDefense;
      pendingDefense = null;
      awaitingSpeech = true;
      gapStart = null;
      currentGapMs = d.afterMs;
      emit({ type: 'defense', defense: currentCombo.defense });
      emit({ type: 'say', text: d.text, tag: 'defense' });
      return;
    }

    const finishing = inFinisher(now);
    if (finishing && !finisherAnnounced) {
      // Announce straight away rather than sitting out the rest of the gap,
      // and drop anything the main selector was holding for the lookahead.
      finisherAnnounced = true;
      pendingCombo = null;
      awaitingSpeech = true;
      currentGapMs = 0;
      gapStart = null;
      emit({ type: 'finisher' });
      emit({ type: 'say', text: fin.callout, tag: 'combo' });
      return;
    }

    if (gapStart !== null && now - gapStart < currentGapMs) return;   // mid-gap

    // Hold a rejected combo rather than redrawing it, so the lookahead does not
    // silently burn through the pool at the end of every round.
    const combo = pendingCombo ?? (finishing ? finisherSelector : selector).next();
    if (!combo) return;
    pendingCombo = combo;

    const text = applyPronunciation(combo.speech, config.pronunciation);
    const gapMs = gapMsFor(combo, finishing ? { ...intensity, baseGapMs: fin.baseGapMs } : intensity);
    const estSpeechMs = estimateSpeechMs(text, rate, config.speechEstimate);
    // A combo and its defense are one unit: never start a combo whose
    // defense the bell would cut off, or the drill teaches leaving it out.
    const def = finishing ? null : defenseTiming(combo);

    if (!canStartCallout({
      remainingMs: left,
      estSpeechMs: estSpeechMs + (def ? def.estSpeechMs : 0),
      gapMs: def ? def.beforeMs + def.afterMs : gapMs,
      lookaheadMs: config.roundEndLookaheadMs,
    })) {
      return;   // let the round run out quietly
    }

    pendingCombo = null;
    pendingDefense = def;
    currentCombo = combo;
    currentGapMs = def ? def.beforeMs : gapMs;
    gapStart = null;
    awaitingSpeech = true;
    combosCalled += 1;
    emit({ type: 'combo', combo });
    emit({ type: 'say', text, tag: 'combo' });
  }

  /**
   * A timed segment: say each cue as its moment arrives. If several are due
   * at once (a slow tick), only the latest is said; a backlog would queue on
   * iOS and run late.
   */
  function tickTimed(now) {
    const t = elapsed(now);
    if (t >= timed.durationMs) { advance(now); return; }

    let due = -1;
    while (nextCue < timed.cues.length && timed.cues[nextCue].atMs <= t) due = nextCue++;
    if (due >= 0) emit({ type: 'say', text: applyPronunciation(timed.cues[due].text, config.pronunciation), tag: 'cue' });

    const step = timed.steps.findIndex((s) => t >= s.startMs && t < s.endMs);
    if (step !== stepIndex && step >= 0) {
      stepIndex = step;
      emit({ type: 'step', step: timed.steps[step], next: timed.steps[step + 1] ?? null, index: step, of: timed.steps.length });
    }
  }

  function tickRest(now) {
    const left = restMs - elapsed(now);
    if (left <= 0) { advance(now); return; }
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
      segIndex = -1;
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
      else if (state === STATES.TIMED) tickTimed(now);
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
      // A defense owed from before the pause would come out of nowhere.
      if (pendingDefense) { pendingDefense = null; currentGapMs = intensity.baseGapMs; }
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
          : state === STATES.TIMED ? timed.durationMs
          : state === STATES.COUNTDOWN ? countdownMs
          : 0,
        segment: plan[segIndex]?.type ?? null,
        segmentKind: plan[segIndex]?.kind ?? null,
        step: state === STATES.TIMED && stepIndex >= 0 ? timed.steps[stepIndex] : null,
        nextStep: state === STATES.TIMED && stepIndex >= 0 ? timed.steps[stepIndex + 1] ?? null : null,
        combo: currentCombo,
        finisher: finisherAnnounced && state === STATES.ROUND,
        intensity: state === STATES.ROUND ? intensity : null,
        combosCalled,
        poolSize: selector.pool.length,
      };
    },
  };
}
