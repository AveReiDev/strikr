/**
 * Emphasis: a soft lean toward combos that work one thing. Pure — no clock,
 * no DOM, no global randomness.
 *
 * A weight, never a filter. Filtering would shrink the pool, which shrinks the
 * no-repeat window and starves boxing; weighting keeps every combo in play and
 * just calls the emphasised ones more often. It multiplies with weak spots and
 * strike balance through composeWeights.
 *
 *   levels   attacking one level pulls the guard and opens another, so each
 *            switch of level between adjacent strikes adds
 *            config.emphasis.levelsPerChange to the weight (1 + k × changes)
 */

import { profileOf } from './strikes.js';

/** Per-combo weight function for an emphasis, or null when it is off. */
export function emphasisWeight(emphasis, { strikes, config }) {
  if (emphasis !== 'levels' || !strikes) return null;
  const k = config?.emphasis?.levelsPerChange ?? 1;
  const cache = new WeakMap();
  return (combo) => {
    let w = cache.get(combo);
    if (w === undefined) {
      w = 1 + k * profileOf(combo, strikes).levelChanges;
      cache.set(combo, w);
    }
    return w;
  };
}
