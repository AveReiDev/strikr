/**
 * Combo selection. Pure — no clock, no DOM, no global randomness.
 *
 * Every function here takes its random number generator as an argument. That is
 * what makes the tests possible: give it the same seed and it produces the same
 * workout, every time.
 */

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
 * Stage 2 and 3: pick a tier, then a combo within it.
 *
 * `recent` is the list of ids called most recently, newest last. A combo that
 * appears in the last `noRepeatWindow` of them is rejected and redrawn, up to
 * `maxRedraws` times — then accepted anyway, so a pool of two combos still
 * terminates instead of spinning forever.
 */
export function selectCombo({ pool, tier, config, rng, recent = [], weakWeight }) {
  if (!pool.length) return null;

  const groups = groupByTier(pool, tier, config.tierWeights);
  if (!groups.length) return null;

  const window = recent.slice(-config.noRepeatWindow);
  const freqWeight = (c) => {
    let w = config.frequencyWeights[c.frequency] ?? 1;
    if (weakWeight) w *= weakWeight(c);
    return w;
  };

  let candidate = null;
  for (let attempt = 0; attempt <= config.maxRedraws; attempt++) {
    const group = pickWeighted(groups, (g) => g.weight, rng);
    candidate = pickWeighted(group.combos, freqWeight, rng);
    if (!window.includes(candidate.id)) return candidate;
  }
  return candidate;   // pool too small to avoid a repeat; accept it
}

/**
 * Convenience wrapper that keeps its own recent-ids list, which is what the
 * session actually wants. Still pure with respect to randomness — the rng is
 * injected.
 */
/**
 * `comboFrequencyMap` is an optional Map<comboId, count> from history.
 * When `focusWeak` is true, combos with fewer historical calls get higher
 * weight: weight = 1 / (count + 1). This multiplies into the existing
 * frequency weight, so tier and frequency weighting still apply.
 */
export function createSelector({ combos, sport, tier, config, rng, focusWeak, comboFrequencyMap, focus }) {
  const pool = buildPool(combos, { sport, tier, focus });
  const recent = [];

  const weakWeight = focusWeak && comboFrequencyMap
    ? (c) => 1 / ((comboFrequencyMap.get(c.id) || 0) + 1)
    : null;

  return {
    pool,
    get recent() { return [...recent]; },
    next() {
      const combo = selectCombo({ pool, tier, config, rng, recent, weakWeight });
      if (combo) {
        recent.push(combo.id);
      }
      return combo;
    },
  };
}
