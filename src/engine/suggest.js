/**
 * Progressive training suggestion (Phase 6B).
 *
 * Pure function: takes a goal, recent daily volumes, and current settings,
 * returns a suggestion object or null.
 */

const INTENSITY_ORDER = ['light', 'medium', 'hard'];
const INTENSITY_MULT = { light: 1, medium: 1.5, hard: 2 };

function score(day) {
  return day.rounds * (INTENSITY_MULT[day.intensity] ?? 1) * (day.roundLengthMin || 1);
}

function goalScore(goal) {
  return goal.rounds * (INTENSITY_MULT[goal.intensity] ?? 1) * (goal.roundLengthMin || 1);
}

/**
 * Find the best recent day — the one closest to (or exceeding) the goal.
 */
function bestDay(volumes, goal) {
  if (!volumes.length) return null;
  const target = goalScore(goal);
  let best = null, bestScore = -1;
  for (const v of volumes) {
    const s = score(v);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return best;
}

/**
 * Compute the next suggested workout.
 *
 * @param {Object} goal - { rounds, intensity, roundLengthMin }
 * @param {Array} volumes - recent dailyVolume output (last 14 days)
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
      intensity: best.intensity || current.intensity,
      roundLengthMin: best.roundLengthMin || current.roundLengthMin,
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
      roundLengthMin: best.roundLengthMin || current.roundLengthMin,
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
