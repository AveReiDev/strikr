/**
 * Progressive training suggestion (Phase 6B).
 *
 * Pure function: takes a goal, recent daily volumes, and current settings,
 * returns a suggestion object or null.
 */

const INTENSITY_ORDER = ['light', 'medium', 'hard'];

/**
 * How far along the progression a day is, as a sortable tuple.
 *
 * The progression runs rounds first, then intensity, then round length — so a
 * day at a higher intensity is further along than any number of rounds at a
 * lower one, even though the rounds were reset when intensity stepped up.
 * Ranking by a blended volume score instead made the reset step look like a
 * regression, and the suggestion stalled until the older, easier day aged out
 * of the window. Each dimension is capped at the goal, since overshooting one
 * does not make up for falling short on another.
 */
function progressKey(day, goal) {
  const gIdx = INTENSITY_ORDER.indexOf(goal.intensity);
  return [
    Math.min(INTENSITY_ORDER.indexOf(day.intensity), gIdx),
    Math.min(day.roundLengthMin || 0, goal.roundLengthMin),
    Math.min(day.rounds, goal.rounds),
  ];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The recent day furthest along toward the goal. Days whose intensity is not
 * one of the three levels (all-Custom days) cannot be placed, so are skipped.
 * Ties go to the most recent day.
 */
function bestDay(volumes, goal) {
  let best = null, bestKey = null;
  for (const v of volumes) {
    if (!INTENSITY_ORDER.includes(v.intensity)) continue;
    const k = progressKey(v, goal);
    if (!best || compareKeys(k, bestKey) >= 0) { best = v; bestKey = k; }
  }
  return best;
}

/** The most recent day that can be placed on the progression, and the one before it. */
function lastTwoDays(volumes) {
  const placed = volumes.filter((v) => INTENSITY_ORDER.includes(v.intensity));
  return [placed.at(-1) ?? null, placed.at(-2) ?? null];
}

/**
 * Autoregulation from the post-workout rating.
 *
 * Tough (4) or one Brutal (5): hold — repeat the latest day rather than step
 * past it. Two Brutal days running: back off by about a fifth of the rounds.
 * Anything easier, or unrated, leaves the normal progression alone. The held
 * workout is capped at the goal, so training past it is never suggested.
 */
function feelAdjustment(volumes, goal) {
  const [last, prev] = lastTwoDays(volumes);
  if (!last || !(last.feel >= 4)) return null;

  const gIdx = INTENSITY_ORDER.indexOf(goal.intensity);
  const intensity = INTENSITY_ORDER[Math.min(INTENSITY_ORDER.indexOf(last.intensity), gIdx)];
  const roundLengthMin = Math.min(last.roundLengthMin || goal.roundLengthMin, goal.roundLengthMin);
  const rounds = Math.min(last.rounds, goal.rounds);

  if (last.feel === 5 && prev?.feel === 5) {
    return {
      rounds: Math.max(1, rounds - Math.max(1, Math.round(rounds * 0.2))),
      intensity,
      roundLengthMin,
      reason: `Two brutal sessions running — backing off to recover`,
      goalReached: false,
      bestDay: last,
    };
  }
  return {
    rounds,
    intensity,
    roundLengthMin,
    reason: `Last session felt ${last.feel === 5 ? 'brutal' : 'tough'} — repeat it before stepping up`,
    goalReached: false,
    bestDay: last,
  };
}

/**
 * Compute the next suggested workout.
 *
 * @param {Object} goal - { rounds, intensity, roundLengthMin }
 * @param {Array} volumes - recent dailyVolume output (last 14 days), oldest first
 * @param {Object} current - current settings snapshot
 * @returns {{ rounds, intensity, roundLengthMin, reason, goalReached, bestDay }|null}
 */
export function computeSuggestion(goal, volumes, current) {
  if (!goal) return null;

  const best = bestDay(volumes, goal);

  if (!best) {
    return {
      rounds: current.roundsPerWorkout,
      intensity: current.intensity,
      roundLengthMin: current.roundLengthMin,
      reason: null,
      goalReached: false,
      bestDay: null,
    };
  }

  const gIdx = INTENSITY_ORDER.indexOf(goal.intensity);
  const bIdx = INTENSITY_ORDER.indexOf(best.intensity);
  const reached = best.rounds >= goal.rounds
    && bIdx >= gIdx
    && best.roundLengthMin >= goal.roundLengthMin;

  // A reached goal is reported regardless of how the last day felt.
  if (!reached) {
    const adjusted = feelAdjustment(volumes, goal);
    if (adjusted) return adjusted;
  }

  if (best.rounds >= goal.rounds
    && bIdx >= gIdx
    && best.roundLengthMin >= goal.roundLengthMin) {
    return {
      rounds: goal.rounds,
      intensity: goal.intensity,
      roundLengthMin: goal.roundLengthMin,
      reason: `You hit ${best.rounds} ${best.intensity} ${best.roundLengthMin}-min rounds`,
      goalReached: true,
      bestDay: best,
    };
  }

  if (best.rounds < goal.rounds) {
    return {
      rounds: best.rounds + 1,
      intensity: best.intensity,
      roundLengthMin: Math.min(best.roundLengthMin || current.roundLengthMin, goal.roundLengthMin),
      reason: `You did ${best.rounds} rounds ${best.intensity} on ${formatDay(best.day)}`,
      goalReached: false,
      bestDay: best,
    };
  }

  if (bIdx < gIdx) {
    const nextIntensity = INTENSITY_ORDER[bIdx + 1];
    const resetRounds = Math.max(1, Math.round(goal.rounds * 0.7));
    return {
      rounds: resetRounds,
      intensity: nextIntensity,
      roundLengthMin: Math.min(best.roundLengthMin || current.roundLengthMin, goal.roundLengthMin),
      reason: `You did ${best.rounds} rounds ${best.intensity} — stepping up intensity`,
      goalReached: false,
      bestDay: best,
    };
  }

  if (best.roundLengthMin < goal.roundLengthMin) {
    const nextLength = best.roundLengthMin + 1;
    const resetRounds = Math.max(1, Math.round(goal.rounds * 0.7));
    return {
      rounds: resetRounds,
      intensity: best.intensity,
      roundLengthMin: nextLength,
      reason: `You did ${best.rounds} rounds at ${best.roundLengthMin} min — stepping up round length`,
      goalReached: false,
      bestDay: best,
    };
  }

  return null;
}

function formatDay(dayKey) {
  if (!dayKey) return '';
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}
