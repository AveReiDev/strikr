/**
 * Ladder drills. Pure — no clock, no DOM, no global randomness.
 *
 * A ladder builds one combo up a strike at a time:
 *   Jab / Jab, Cross / Jab, Cross, Lead hook / ...
 * A pyramid climbs to the full combo and then strips it back down.
 *
 * The rungs are cut from existing combos rather than written by hand, so every
 * combo with three or more spoken strikes is a ladder for free. The gap already
 * widens with the action count, so longer rungs get more time automatically.
 *
 * createLadderSelector has the same shape as createSelector (pool, recent,
 * next), so the session drives either without knowing which it has. It also
 * has startRound(), which the session calls so every round opens on rung one.
 */

import { buildPool, selectCombo } from './selector.js';

export const LADDER_MODES = ['ladder', 'pyramid'];
export const MIN_RUNGS = 3;

const SEP = ' – ';

/**
 * Split a combo into rungs. A rung ends on a SPOKEN strike: a parenthetical
 * such as "(land switched)" says nothing, so a rung ending on one would repeat
 * the previous callout. It rides along with the strike after it instead.
 */
export function rungsOf(combo) {
  const segments = String(combo.display ?? '').split(SEP).map((s) => s.trim()).filter(Boolean);
  const rungs = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith('(')) continue;
    const parts = segments.slice(0, i + 1);
    rungs.push({
      display: parts.join(SEP),
      speech: parts.filter((s) => !s.startsWith('(')).join(', '),
      actions: parts.length,
    });
  }
  return rungs;
}

/** Combos long enough to ladder, from the same pool a normal workout uses. */
export function buildLadderPool(combos, { sport, tier, focus }) {
  return buildPool(combos, { sport, tier, focus })
    .filter((c) => !c.single && rungsOf(c).length >= MIN_RUNGS);
}

/**
 * The full call sequence for one combo.
 *
 * `reps` repeats each rung before moving on. In a pyramid the top rung is
 * thrown once per rep, not twice, since the way down starts one rung below it.
 */
export function ladderSequence(combo, { mode = 'ladder', reps = 1 } = {}) {
  const rungs = rungsOf(combo);
  const of = rungs.length;
  const order = rungs.map((_, i) => i);
  if (mode === 'pyramid') for (let i = of - 2; i >= 0; i--) order.push(i);

  const out = [];
  for (const i of order) {
    const r = rungs[i];
    const full = i === of - 1;
    for (let k = 0; k < reps; k++) {
      out.push({
        ...combo,
        // The top rung is the real combo, so it keeps the real id and counts
        // toward per-combo history. Partial rungs get their own id.
        id: full ? combo.id : `${combo.id}#${i + 1}`,
        display: r.display,
        speech: r.speech,
        actions: r.actions,
        ladder: { baseId: combo.id, rung: i + 1, of },
      });
    }
  }
  return out;
}

export function createLadderSelector({
  combos, sport, tier, config, rng, focusWeak, comboFrequencyMap, focus, mode, reps,
}) {
  const pool = buildLadderPool(combos, { sport, tier, focus });
  const recent = [];          // base combo ids, so the next ladder is a different combo
  let queue = [];

  const weakWeight = focusWeak && comboFrequencyMap
    ? (c) => 1 / ((comboFrequencyMap.get(c.id) || 0) + 1)
    : null;

  return {
    pool,
    get recent() { return [...recent]; },
    startRound() { queue = []; },
    next() {
      if (!queue.length) {
        const base = selectCombo({ pool, tier, config, rng, recent, weakWeight });
        if (!base) return null;
        recent.push(base.id);
        queue = ladderSequence(base, { mode, reps });
      }
      return queue.shift() ?? null;
    },
  };
}
