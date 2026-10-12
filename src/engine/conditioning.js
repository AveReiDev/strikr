/**
 * Conditioning rounds between bag rounds. Pure — no clock, no DOM, no global
 * randomness.
 *
 * Gloves stay on, so the library (data/exercises.json, on config.exercises)
 * is bodyweight moves only. The app calls time, never reps:
 *
 *   up to 60 s   one exercise
 *   90 s         two stations
 *   2 min        three stations, with a "Switch" call
 *
 * Each round opens with a few seconds to get set (the name and a coaching
 * cue), then "Go". Safety rules the picker enforces:
 *   - never two plyometric exercises back to back
 *   - no intensity-3 plyometrics in the last third of the session
 *   - low impact removes everything with `impact: true`
 * It also avoids the same body area twice running and, while it can, any
 * exercise already used in this workout.
 */

/** Station lengths for a round of `sec` seconds, in whole multiples of 5. */
export function stationsFor(sec) {
  if (sec <= 60) return [sec];
  const n = sec >= 120 ? 3 : 2;
  const each = Math.floor(sec / n / 5) * 5;
  const out = Array(n).fill(each);
  out[n - 1] += sec - each * n;   // any remainder goes on the last station
  return out;
}

export function createConditioningPicker({ exercises, lowImpact, rng, totalRounds, config }) {
  const pool = (exercises ?? []).filter((e) => !(lowImpact && e.impact));
  const used = new Set();
  const setupSec = config?.conditioning?.setupSec ?? 5;

  const draw = (list) => list[Math.floor(rng() * list.length)] ?? list[list.length - 1];

  /**
   * One exercise for a station. The plyometric and late-session rules never
   * relax; variety (unused, different body area) gives way if nothing else
   * is left.
   */
  function choose(prev, late) {
    const safe = pool.filter((e) => !(prev?.plyo && e.plyo) && !(late && e.plyo && e.intensity >= 3));
    // A different body area matters more than a fresh exercise (fatigue);
    // a fresh one matters more than avoiding the last area entirely.
    const tiers = [
      safe.filter((e) => !used.has(e.name) && e.category !== prev?.category),
      safe.filter((e) => e.category !== prev?.category),
      safe.filter((e) => !used.has(e.name)),
      safe.filter((e) => e.name !== prev?.name),
      safe,
    ];
    const list = tiers.find((t) => t.length);
    return list ? draw(list) : null;
  }

  return {
    /**
     * The timed steps for conditioning round `n` (1-based) of `sec` seconds,
     * or null when the library is empty.
     */
    steps(n, sec) {
      const late = totalRounds > 0 && n > (totalRounds * 2) / 3;
      const steps = [];
      let prev = null;
      for (const [i, stationSec] of stationsFor(sec).entries()) {
        const ex = choose(prev, late);
        if (!ex) return null;
        used.add(ex.name);
        if (i === 0) {
          steps.push({ name: ex.name, cue: ex.cue, sec: setupSec, setup: true });
          steps.push({ name: ex.name, speak: 'Go', sec: stationSec, sides: ex.sides, exercise: ex.name });
        } else {
          steps.push({ name: ex.name, speak: `Switch, ${ex.name}`, sec: stationSec, sides: ex.sides, exercise: ex.name });
        }
        prev = ex;
      }
      return steps;
    },
  };
}
