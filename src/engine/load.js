/**
 * Weekly training load. Pure — no clock, no DOM, no storage.
 *
 * Load is a rough, honest measure of work: minutes of round time weighted by
 * intensity. Conditioning rounds between bag rounds count too (their minutes
 * × the same intensity factor × conditioningFactor); a warm-up does not. It feeds two rules on top of the day-to-day suggestion:
 *
 *   - a week may grow by at most `weeklyIncrease` over the last normal week
 *   - after `easyAfterWeeks` normal weeks running, the next is an easy week
 *
 * Nothing about the block is stored. Each week's status is re-derived from
 * the loads alone: a week that was already light, or empty, is recovery and
 * restarts the count. So a week off sick counts as the easy week, and the
 * plan can never drift out of step with what actually happened.
 *
 * The first week with any training is a baseline only; targets start the
 * week after the first full week to measure against.
 */

/** Load of one history record. Rounds are the ones actually finished. */
export function sessionLoad(record, load) {
  const factor = load.intensityFactor[record.intensity] ?? 1;
  const bag = record.rounds * (record.roundLengthSec / 60);
  const cond = (record.conditioningRounds ?? 0) * ((record.conditioningSec ?? 0) / 60) * (load.conditioningFactor ?? 1);
  return (bag + cond) * factor;
}

/**
 * Load of a whole workout of `rounds` bag rounds with conditioning between
 * them (one fewer conditioning round than bag rounds).
 */
export function workoutLoad(rounds, intensity, roundLengthMin, conditioningSec, load) {
  const cond = Math.max(0, rounds - 1) * ((conditioningSec ?? 0) / 60) * (load.conditioningFactor ?? 1);
  return (rounds * roundLengthMin + cond) * (load.intensityFactor[intensity] ?? 1);
}

/** Load of one round at a given intensity and length. */
export function roundLoad(intensity, roundLengthMin, load) {
  return roundLengthMin * (load.intensityFactor[intensity] ?? 1);
}

/**
 * Plan the current week.
 *
 * @param {Array<{load:number}>} weeks - oldest first; the LAST entry is the
 *   current, unfinished week
 * @returns {{ thisWeek, reference, target, easy, weekOfBlock, blockLength }}
 *   target is null until there is a normal week to measure against.
 */
export function weekPlan(weeks, load) {
  const past = weeks.slice(0, -1);
  const thisWeek = weeks.at(-1)?.load ?? 0;

  let reference = null;   // load of the most recent normal week
  let streak = 0;         // normal weeks in a row, most recent last
  let baselineSeen = false;
  for (const w of past) {
    // The first week with any training is usually partial (the app was
    // picked up mid-week), so it only marks the start. Measuring against it
    // would cap the next week at a session or two.
    if (!baselineSeen) {
      if (w.load > 0) baselineSeen = true;
      continue;
    }
    if (w.load <= 0 || (reference !== null && w.load <= reference * load.easyDetectRatio)) {
      streak = 0;         // rest or an easy week: recovered, start a new block
      continue;
    }
    streak += 1;
    reference = w.load;
  }

  const easy = reference !== null && streak >= load.easyAfterWeeks;
  const target = reference === null
    ? null
    : reference * (easy ? load.easyRatio : load.weeklyIncrease);

  return {
    thisWeek,
    reference,
    target,
    easy,
    weekOfBlock: easy ? load.easyAfterWeeks + 1 : streak + 1,
    blockLength: load.easyAfterWeeks + 1,
  };
}

/**
 * Fit a day's suggestion into the week.
 *
 * An easy week keeps the intensity and cuts the rounds (deloads drop volume,
 * not quality). Then the rounds are capped at whatever load the week has
 * left. If not even one round fits, the week is done: the suggestion becomes
 * an optional light session and says so.
 *
 * `conditioningSec` prices the conditioning round between each pair of bag
 * rounds, or the cap would over-suggest whenever conditioning is on.
 */
export function applyWeekPlan(suggestion, plan, load, { conditioningSec = 0 } = {}) {
  if (!suggestion || suggestion.goalReached || plan.target === null) return suggestion;

  let s = { ...suggestion };
  if (plan.easy) {
    s.rounds = Math.max(1, Math.round(s.rounds * load.easyRatio));
    s.reason = 'Easy week — less volume, same intensity, to recover';
  }

  const remaining = plan.target - plan.thisWeek;
  let fits = 0;
  // Capped: a zero-length round must not spin forever.
  while (fits < 99 && workoutLoad(fits + 1, s.intensity, s.roundLengthMin, conditioningSec, load) <= remaining) fits += 1;
  const why = conditioningSec > 0 ? ' (conditioning counts toward it)' : '';

  if (fits < 1) {
    return {
      ...s,
      rounds: Math.min(s.rounds, 3),
      intensity: 'light',
      reason: 'This week’s load is done — rest, or keep it light',
      weekDone: true,
    };
  }
  if (s.rounds > fits) {
    s.rounds = fits;
    s.reason = plan.easy
      ? `Easy week — trimmed to fit its lighter load${why}`
      : `Trimmed to fit this week’s load${why}`;
  }
  return s;
}
