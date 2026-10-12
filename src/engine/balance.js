/**
 * Strike balance. Pure — no clock, no DOM, no global randomness.
 *
 * Drawing combos uniformly does not draw strikes uniformly: nearly every combo
 * opens with a jab or a cross, so those two dominate every workout. This
 * nudges the draw toward the strike categories a workout has under-called so
 * far, measured against a per-sport target mix in config.balance.
 *
 * It is deliberately gentle. The weight is the square root of the deficit,
 * clamped, averaged over a combo's strikes (so long combos do not win by
 * length), and the running counts start from the target mix so the first few
 * calls cannot swing it. A strong correction would only make the "missing"
 * category predictable instead.
 */

import { classifyStrike, segmentsOf } from './strikes.js';

/**
 * Balance category of one spoken strike, or null when it should not count
 * (spins, sweeps, clinch moves, footwork, anything unrecognised). The
 * categories come from the strike dictionary, data/strikes.json.
 */
export function categoryOf(strike, strikes) {
  return classifyStrike(strike, strikes)?.category ?? null;
}

/** The categories of a combo's spoken strikes, in order. */
export function categoriesOf(combo, strikes) {
  return segmentsOf(combo).map((s) => categoryOf(s, strikes)).filter(Boolean);
}

/**
 * A running tally of what has been called, with a weight function over combos.
 * Returns null when there is no target mix for the sport (boxing, say) or no
 * strike dictionary to classify with, which callers treat as "no balancing".
 */
export function createBalance({ sport, balance, strikes }) {
  const targets = balance?.targets?.[sport];
  if (!targets || !strikes?.rules?.length) return null;
  const total = Object.values(targets).reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;

  const [lo, hi] = balance.clamp;
  const counts = {};
  for (const [cat, t] of Object.entries(targets)) counts[cat] = (t / total) * balance.priorCalls;

  const sum = () => Object.values(counts).reduce((a, b) => a + b, 0);

  return {
    /** Multiplier for drawing this combo given everything recorded so far. */
    weight(combo) {
      const cats = categoriesOf(combo, strikes).filter((c) => c in targets);
      if (!cats.length) return 1;
      const n = sum();
      let acc = 0;
      for (const c of cats) {
        const want = targets[c] / total;
        const have = counts[c] / n;
        acc += Math.min(hi, Math.max(lo, Math.sqrt(want / have)));
      }
      return acc / cats.length;
    },
    record(combo) {
      for (const c of categoriesOf(combo, strikes)) if (c in counts) counts[c] += 1;
    },
    get counts() { return { ...counts }; },
  };
}
