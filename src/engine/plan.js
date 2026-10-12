/**
 * The workout plan: an ordered list of timed segments the session walks.
 * Pure — no clock, no DOM, no global randomness.
 *
 *   bag     a round on the bag: combos are called, bell at each end
 *   rest    between segments, with the 10 / 3-2-1 lead-in
 *   timed   precomputed spoken cues on a timeline: the guided warm-up, and
 *           the conditioning rounds between bag rounds
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
 * Each step opens with its name (or `speak`, when it should say something
 * else, such as "Go"), then its coaching cue; a two-sided move gets "Switch
 * sides" at its halfway point. `marks` add cues timed from the segment's end,
 * such as "Ten seconds". speak() never cancels, so a cue that starts before
 * the last one has finished would queue up late on iOS: every cue is pushed
 * back until the previous one is estimated to be done.
 */
export function timedSegment(steps, { intro, marks = [], rate, config }) {
  const est = (text) => estimateSpeechMs(applyPronunciation(text, config.pronunciation), rate, config.speechEstimate);
  const laid = [];
  let t = 0;
  for (const s of steps) {
    const durationMs = s.sec * 1000;
    laid.push({ ...s, startMs: t, endMs: t + durationMs });
    t += durationMs;
  }

  // What to say and when, in the order it should be said. The sort is
  // stable, so a step's name still comes before its cue.
  const wanted = [];
  if (intro) wanted.push({ atMs: 0, text: intro, step: 0 });
  laid.forEach((s, i) => {
    wanted.push({ atMs: s.startMs, text: s.speak ?? s.name, step: i });
    if (s.cue) wanted.push({ atMs: s.startMs, text: s.cue, step: i });
    if (s.sides) wanted.push({ atMs: s.startMs + (s.endMs - s.startMs) / 2, text: 'Switch sides', step: i });
  });
  for (const m of marks) {
    const atMs = t - m.fromEndMs;
    if (atMs <= 0) continue;
    wanted.push({ atMs, text: m.text, step: laid.findIndex((s) => atMs >= s.startMs && atMs < s.endMs) });
  }
  wanted.sort((a, b) => a.atMs - b.atMs);

  const cues = [];
  let freeAt = 0;   // when the voice is next expected to be quiet
  for (const w of wanted) {
    const at = Math.max(w.atMs, freeAt);
    cues.push({ ...w, atMs: at });
    freeAt = at + est(w.text) + CUE_SPACING_MS;
  }

  return { type: 'timed', durationMs: t, steps: laid, cues };
}

/**
 * The whole workout. `warmup` is the chosen routine's steps, or nothing.
 * After a warm-up comes a rest long enough to glove up, announced on entry.
 * `conditioning` (a picker from conditioning.js) puts a conditioning round
 * after every bag round but the last, then the usual rest.
 */
export function buildPlan(settings, { warmup, conditioning, rate, config }) {
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
  const condSec = conditioning ? settings.conditioningSec ?? 0 : 0;
  for (let i = 1; i <= n; i++) {
    plan.push({ type: 'bag', round: i, durationMs: settings.roundLengthMin * 60 * 1000 });
    if (i === n) break;
    const steps = condSec > 0 ? conditioning.steps(i, condSec) : null;
    if (steps) {
      plan.push({
        ...timedSegment(steps, { marks: condSec >= 30 ? [{ fromEndMs: 10000, text: 'Ten seconds' }] : [], rate, config }),
        kind: 'conditioning',
        round: i,
        workSec: condSec,
      });
      plan.push({ type: 'rest', durationMs: settings.restBetweenRoundsSec * 1000, enterSay: 'Rest' });
    } else {
      plan.push({ type: 'rest', durationMs: settings.restBetweenRoundsSec * 1000 });
    }
  }
  return plan;
}
