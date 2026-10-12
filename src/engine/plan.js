/**
 * The workout plan: an ordered list of timed segments the session walks.
 * Pure — no clock, no DOM, no global randomness.
 *
 *   bag     a round on the bag: combos are called, bell at each end
 *   rest    between segments, with the 10 / 3-2-1 lead-in
 *   timed   precomputed spoken cues on a timeline (the guided warm-up; S&C
 *           exercise rounds will reuse it)
 *
 * With no add-ons the plan is exactly bag, rest, bag, … bag, which is what the
 * session did before it had a plan at all.
 */

import { estimateSpeechMs, applyPronunciation } from './timing.js';

/** A short pause left between two cues that would otherwise run together. */
const CUE_SPACING_MS = 300;

/**
 * Lay a routine's steps out on a timeline and schedule what to say.
 *
 * Each step opens with its name, then its coaching cue; a two-sided move gets
 * "Switch sides" at its halfway point. speak() never cancels, so a cue that
 * starts before the last one has finished would queue up late on iOS: every
 * cue is pushed back until the previous one is estimated to be done.
 */
export function timedSegment(steps, { intro, rate, config }) {
  const est = (text) => estimateSpeechMs(applyPronunciation(text, config.pronunciation), rate, config.speechEstimate);
  const laid = [];
  let t = 0;
  for (const s of steps) {
    const durationMs = s.sec * 1000;
    laid.push({ ...s, startMs: t, endMs: t + durationMs });
    t += durationMs;
  }

  const cues = [];
  let freeAt = 0;   // when the voice is next expected to be quiet
  const say = (atMs, text, step) => {
    const at = Math.max(atMs, freeAt);
    cues.push({ atMs: at, text, step });
    freeAt = at + est(text) + CUE_SPACING_MS;
  };

  if (intro) say(0, intro, 0);
  laid.forEach((s, i) => {
    say(s.startMs, s.name, i);
    if (s.cue) say(s.startMs, s.cue, i);
    if (s.sides) say(s.startMs + (s.endMs - s.startMs) / 2, 'Switch sides', i);
  });

  return { type: 'timed', durationMs: t, steps: laid, cues };
}

/**
 * The whole workout. `warmup` is the chosen routine's steps, or nothing.
 * After a warm-up comes a rest long enough to glove up, announced on entry.
 */
export function buildPlan(settings, { warmup, rate, config }) {
  const plan = [];
  if (warmup?.length) {
    const minutes = Math.round(warmup.reduce((a, s) => a + s.sec, 0) / 60);
    plan.push({
      ...timedSegment(warmup, { intro: `Warm-up, ${minutes} minutes`, rate, config }),
      kind: 'warmup',
    });
    plan.push({
      type: 'rest',
      durationMs: (config.warmup?.transitionSec ?? 45) * 1000,
      enterSay: config.warmup?.doneCallout ?? 'Warm-up done. Gloves on.',
    });
  }

  const n = settings.roundsPerWorkout;
  for (let i = 1; i <= n; i++) {
    plan.push({ type: 'bag', round: i, durationMs: settings.roundLengthMin * 60 * 1000 });
    if (i < n) plan.push({ type: 'rest', durationMs: settings.restBetweenRoundsSec * 1000 });
  }
  return plan;
}
