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
 *   kicking, punching, close, clinch (boxing: outside, inside)
 *            one range for the whole workout: 1 + config.emphasis.rangePerShare
 *            × the share of the combo's strikes thrown from that range
 *   ranges   range calls: the voice names a range ("Clinch") every few combos
 *            and the combos that follow are drawn for it. createRangeSelector
 *            moves a shared cursor; the weight and `prefer` read it.
 *
 * The ranges, their callouts and the sports they apply to are in
 * data/strikes.json (config.strikes.ranges), so changing them is a data edit.
 */

import { classifyCombo, profileOf } from './strikes.js';

const RANGE_CALLS = 'ranges';

/** The named ranges for a sport, in data order: [{ name, callout }]. */
export function rangesFor(sport, strikes) {
  return Object.entries(strikes?.ranges ?? {})
    .filter(([, r]) => !r.sports || r.sports.includes(sport))
    .map(([name, r]) => ({ name, callout: r.callout ?? name }));
}

/** Whether an emphasis means anything for a sport (clinch is not boxing). */
export function emphasisApplies(emphasis, sport, strikes) {
  if (!emphasis || emphasis === 'off' || emphasis === 'levels' || emphasis === RANGE_CALLS) return true;
  return rangesFor(sport, strikes).some((r) => r.name === emphasis);
}

const shares = new WeakMap();

/**
 * Share of a combo's strikes thrown from `range`, 0–1. Defence, footwork and
 * unrecognised names are not strikes, so they neither count for a range nor
 * dilute it. Once a combo is in the clinch, its knees and elbows are thrown
 * from the clinch: "Clinch – Rear knee – Lead knee" is all clinch work.
 */
export function rangeShare(combo, range, strikes) {
  let byRange = shares.get(combo);
  if (!byRange || byRange.dict !== strikes) {
    const ranged = classifyCombo(combo, strikes).filter((p) => p.kind === 'strike' && p.range);
    byRange = { dict: strikes, total: ranged.length, counts: new Map() };
    let clinched = false;
    for (const p of ranged) {
      if (p.range === 'clinch') clinched = true;
      const r = clinched && p.range === 'close' ? 'clinch' : p.range;
      byRange.counts.set(r, (byRange.counts.get(r) ?? 0) + 1);
    }
    shares.set(combo, byRange);
  }
  return byRange.total ? (byRange.counts.get(range) ?? 0) / byRange.total : 0;
}

/**
 * Per-combo weight function for an emphasis, or null when it is off. Range
 * calls read the range from `cursor.current`, which createRangeSelector moves.
 * A range that does not apply to the combo's sport scores every combo 0, so
 * it weighs everything the same: no effect rather than an error.
 */
export function emphasisWeight(emphasis, { strikes, config, cursor }) {
  if (!strikes || !emphasis || emphasis === 'off') return null;
  if (emphasis === 'levels') {
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
  const k = config?.emphasis?.rangePerShare ?? 8;
  if (emphasis === RANGE_CALLS) {
    if (!cursor) return null;
    return (combo) => (cursor.current ? 1 + k * rangeShare(combo, cursor.current, strikes) : 1);
  }
  return (combo) => 1 + k * rangeShare(combo, emphasis, strikes);
}

/** A combo thrown mostly from `range`: at least half its strikes. */
export function inRange(combo, range, strikes) {
  return rangeShare(combo, range, strikes) >= 0.5;
}

/**
 * Range calls only: after "Kicking range" the next combo should be thrown
 * mostly from there. selectCombo tries these in order and draws from the
 * first that leaves an eligible combo: mostly in range, then anything with a
 * strike from it, then everything. So the pool and its no-repeat window are
 * untouched. Null for every other emphasis.
 */
export function emphasisPrefer(emphasis, { strikes, cursor }) {
  if (emphasis !== RANGE_CALLS || !cursor || !strikes) return null;
  return [
    (combo) => !cursor.current || inRange(combo, cursor.current, strikes),
    (combo) => !cursor.current || rangeShare(combo, cursor.current, strikes) > 0,
  ];
}

/**
 * The ranges worth calling for this pool: those with at least `minCombos`
 * combos with a strike from them. (Not "mostly from them": close work comes
 * after punches, as in "Jab – Cross – Rear knee".) Beginner Muay Thai has
 * almost no clinch work and a Hands focus has no kicks, so those are never
 * called.
 */
export function callableRanges(pool, sport, strikes, minCombos = 4) {
  return rangesFor(sport, strikes)
    .filter((r) => pool.filter((c) => rangeShare(c, r.name, strikes) > 0).length >= minCombos);
}

/**
 * Range calls. Wraps a selector (plain or ladder) with the same shape. Every
 * `every` [min, max] combos, and at the start of every round, it moves
 * `cursor` to a different range before the inner draw, and the combo it
 * returns carries `rangeCall: true`; the session says the callout before the
 * combo. Every combo carries `range: { name, callout }` for the screen.
 *
 * A ladder only moves between ladders (`inner.atStart`), never mid-climb.
 * With fewer than two callable ranges there is nothing to switch between, so
 * it calls nothing and leaves the cursor empty, which weighs nothing.
 */
export function createRangeSelector(inner, { ranges, cursor, rng, every = [3, 5] }) {
  const usable = ranges.length >= 2;
  const [lo, hi] = every;
  let left = 0;            // combos to go in this range
  let announce = true;     // a round opens with a call

  function move() {
    const options = ranges.filter((r) => r.name !== cursor.current);
    const next = options[Math.floor(rng() * options.length)] ?? options[options.length - 1];
    cursor.current = next.name;
    left = lo + Math.floor(rng() * (hi - lo + 1));
  }

  return {
    get pool() { return inner.pool; },
    get recent() { return inner.recent; },
    get atStart() { return inner.atStart ?? true; },
    startRound() { inner.startRound?.(); announce = true; },
    next() {
      if (!usable) return inner.next();
      let call = false;
      if (inner.atStart ?? true) {
        if (announce || left <= 0) { move(); call = true; announce = false; }
        left -= 1;
      }
      const combo = inner.next();
      if (!combo) return null;
      const range = ranges.find((r) => r.name === cursor.current);
      return call ? { ...combo, range, rangeCall: true } : { ...combo, range };
    },
  };
}
