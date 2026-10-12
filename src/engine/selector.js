/**
 * Combo selection. Pure — no clock, no DOM, no global randomness.
 *
 * Every function here takes its random number generator as an argument. That is
 * what makes the tests possible: give it the same seed and it produces the same
 * workout, every time.
 */

import { createBalance } from './balance.js';
import { emphasisWeight, emphasisPrefer } from './emphasis.js';

const TIER_RANK = { beginner: 0, intermediate: 1, advanced: 2 };

export function tierRank(tier) {
  const r = TIER_RANK[tier];
  if (r === undefined) throw new Error(`unknown tier: ${tier}`);
  return r;
}

/**
 * A small seeded random number generator (mulberry32). Returns a function
 * producing numbers in [0, 1), same sequence for the same seed.
 */
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stage 1 of the draw: which combos are eligible at all.
 * Sport must match, the combo must be enabled, and its tier must be at or
 * below the selected one — Advanced draws from all three, Beginner only from
 * Beginner.
 */
export function buildPool(combos, { sport, tier, focus }) {
  const max = tierRank(tier);
  return combos.filter((c) => {
    if (c.sport !== sport || !c.enabled || tierRank(c.tier) > max) return false;
    if (focus) return Array.isArray(c.tags) && c.tags.includes(focus);
    return !c.single;
  });
}

function pickWeighted(items, weightOf, rng) {
  let total = 0;
  for (const it of items) total += weightOf(it);
  if (total <= 0) return items[items.length - 1] ?? null;
  let r = rng() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r < 0) return it;
  }
  return items[items.length - 1];   // floating-point safety net
}

/**
 * Map a tier's distance below the selected tier onto its configured weight.
 * 0 = the selected tier, 1 = one below, 2 = two below.
 */
function tierWeight(distanceBelow, tierWeights) {
  if (distanceBelow === 0) return tierWeights.selected;
  if (distanceBelow === 1) return tierWeights.oneBelow;
  if (distanceBelow === 2) return tierWeights.twoBelow;
  return 0;
}

/**
 * Group an already-built pool by tier, attaching each tier's weight.
 * Weights are only assigned to tiers that actually have combos, so they
 * renormalise naturally — selecting Beginner yields 100% Beginner because it is
 * the only group present.
 */
export function groupByTier(pool, selectedTier, tierWeights) {
  const groups = new Map();
  for (const c of pool) {
    if (!groups.has(c.tier)) groups.set(c.tier, []);
    groups.get(c.tier).push(c);
  }
  const sel = tierRank(selectedTier);
  return [...groups.entries()]
    .map(([tier, combos]) => ({
      tier,
      combos,
      weight: tierWeight(sel - tierRank(tier), tierWeights),
    }))
    .filter((g) => g.weight > 0);
}

/**
 * How many recent calls are blocked from the next draw. The configured window,
 * but never more than a third of the pool: a window of 8 on a pool of 10 left
 * two eligible combos and made the workout a near-fixed cycle. Always at least
 * one and always leaving something eligible, so a two-combo pool alternates.
 */
export function repeatWindow(poolSize, configured) {
  if (poolSize <= 1) return 0;
  return Math.max(1, Math.min(configured, Math.floor(poolSize / 3), poolSize - 1));
}

/**
 * Stage 2 and 3: pick a tier, then a combo within it.
 *
 * `recent` is the list of ids called most recently, newest last. Anything in
 * the last `noRepeatWindow` of them is removed BEFORE drawing, so a repeat is
 * impossible whenever an alternative exists. (This used to draw first and
 * redraw on a hit, giving up after a fixed number of tries — on a small pool
 * it gave up about one call in ten and repeated anyway.)
 *
 * The window shrinks to one less than the pool, so there is always something
 * eligible: a two-combo pool alternates, a one-combo pool repeats.
 *
 * Tiers are weighted over whichever still have an eligible combo, so the
 * selected tier keeps its share until every combo in it is in the window.
 * `prefer` (range calls) works the same way: tiers with nothing preferred
 * drop out of that draw.
 */
export function selectCombo({ pool, tier, config, rng, recent = [], weakWeight, prefer }) {
  if (!pool.length) return null;

  const size = repeatWindow(pool.length, config.noRepeatWindow);
  const blocked = new Set(size > 0 ? recent.slice(-size) : []);
  let eligible = pool.filter((c) => !blocked.has(c.id));
  // `prefer` (one test, or several best first) narrows the draw only when it
  // leaves something, and only after the no-repeat window, which is still
  // sized on the whole pool.
  for (const test of prefer ? [].concat(prefer) : []) {
    const preferred = eligible.filter(test);
    if (preferred.length) { eligible = preferred; break; }
  }

  const groups = groupByTier(eligible, tier, config.tierWeights);
  if (!groups.length) return null;

  const freqWeight = (c) => {
    let w = config.frequencyWeights[c.frequency] ?? 1;
    if (weakWeight) w *= weakWeight(c);
    return w;
  };

  const group = pickWeighted(groups, (g) => g.weight, rng);
  return pickWeighted(group.combos, freqWeight, rng);
}

/**
 * Multiply any number of per-combo weight functions into one. Missing ones
 * (null, undefined) are skipped; with none left the result is null, which
 * selectCombo reads as "no extra weighting".
 */
export function composeWeights(...fns) {
  const active = fns.filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  return (c) => active.reduce((w, f) => w * f(c), 1);
}

/**
 * Weak spots: combos with fewer historical calls weigh more, 1 / (count + 1).
 * `comboFrequencyMap` is a Map<comboId, count> from history. Null when off.
 */
export function weakSpotWeight(focusWeak, comboFrequencyMap) {
  return focusWeak && comboFrequencyMap
    ? (c) => 1 / ((comboFrequencyMap.get(c.id) || 0) + 1)
    : null;
}

/**
 * Convenience wrapper that keeps its own recent-ids list, which is what the
 * session actually wants. Still pure with respect to randomness — the rng is
 * injected. Weak spots, strike balance and emphasis multiply into the frequency weight,
 * so tier and frequency weighting still apply.
 */
export function createSelector({
  combos, sport, tier, config, rng, focusWeak, comboFrequencyMap, focus, emphasis, rangeCursor, balanced = true,
}) {
  const pool = buildPool(combos, { sport, tier, focus });
  const recent = [];

  // Strike balancing applies to ordinary draws only: a focus is a deliberate
  // skew, and the finisher's tiny pool of short combos is its own thing.
  const balance = balanced && !focus
    ? createBalance({ sport, balance: config.balance, strikes: config.strikes })
    : null;

  const weakWeight = composeWeights(
    weakSpotWeight(focusWeak, comboFrequencyMap),
    balance && ((c) => balance.weight(c)),
    emphasisWeight(emphasis, { strikes: config.strikes, config, cursor: rangeCursor }),
  );
  const prefer = emphasisPrefer(emphasis, { strikes: config.strikes, cursor: rangeCursor });

  return {
    pool,
    get recent() { return [...recent]; },
    next() {
      const combo = selectCombo({ pool, tier, config, rng, recent, weakWeight, prefer });
      if (combo) {
        recent.push(combo.id);
        balance?.record(combo);
      }
      return combo;
    },
  };
}
