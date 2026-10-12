/**
 * Footwork mode. Pure — no clock, no DOM, no global randomness.
 *
 * Every combo is called with one footwork move as part of it: an entry before
 * the first strike ("Step in, Jab, Cross") or an exit after the last ("Jab,
 * Cross, Lead hook, Pivot out"). The move is chosen to fit the strike it
 * touches, from the `footwork` list in data/moves.json (config.moves).
 *
 * createFootworkSelector wraps an ordinary selector and has the same shape
 * (pool, recent, next). The combo it returns is derived, like a ladder rung:
 * the display, speech and action count include the move, and the combo keeps
 * its id so history credits the real combo. The extra actions give the move
 * its own execution time in the gap.
 */

import { classifyCombo } from './strikes.js';
import { strikeKeys } from './defense.js';

const SEP = ' – ';

/**
 * The entries and exits that fit this combo, for its sport. A combo that
 * already has footwork in it gets none; an entry needs a strike to step into
 * (not a counter that opens on defense).
 */
export function footworkFor(combo, moves, strikes) {
  const forSport = (moves ?? []).filter((m) => !m.sports || m.sports.includes(combo.sport));
  const parts = classifyCombo(combo, strikes);
  if (!parts.length || parts.some((p) => p.kind === 'footwork')) return { before: [], after: [] };

  const fits = (wanted, part) => {
    if (part?.kind !== 'strike' || !wanted) return false;
    const keys = strikeKeys(part);
    return wanted.some((a) => keys.has(a));
  };
  const first = parts[0];
  // A combo that ends on its own defense ("… Roll under") can still move off
  // afterwards; its exit is paired with the last strike instead.
  const last = parts[parts.length - 1].kind === 'defense'
    ? [...parts].reverse().find((p) => p.kind === 'strike')
    : parts[parts.length - 1];
  return {
    before: forSport.filter((m) => fits(m.before, first)),
    after: forSport.filter((m) => fits(m.after, last)),
  };
}

/** The combo with `move` said before or after it. */
export function withFootwork(combo, move, position) {
  const speech = move.speech ?? move.name;
  const before = position === 'before';
  return {
    ...combo,
    display: before ? `${move.name}${SEP}${combo.display}` : `${combo.display}${SEP}${move.name}`,
    speech: before ? `${speech}, ${combo.speech}` : `${combo.speech}, ${speech}`,
    actions: combo.actions + (move.actions ?? 1),
    footwork: { name: move.name, position },
  };
}

export function createFootworkSelector(inner, { moves, strikes, rng }) {
  let lastName = null;

  /** Uniform over the fitting moves, never the same one twice running. */
  function pick(options) {
    const fresh = options.length > 1 ? options.filter((m) => m.name !== lastName) : options;
    const move = fresh[Math.floor(rng() * fresh.length)] ?? fresh[fresh.length - 1];
    lastName = move.name;
    return move;
  }

  return {
    get pool() { return inner.pool; },
    get recent() { return inner.recent; },
    startRound() { inner.startRound?.(); },
    next() {
      const combo = inner.next();
      if (!combo) return null;
      const { before, after } = footworkFor(combo, moves, strikes);
      if (!before.length && !after.length) return combo;
      // Entry or exit first, evenly, so the longer list of exits does not
      // crowd out stepping in.
      const position = !after.length || (before.length && rng() < 0.5) ? 'before' : 'after';
      return withFootwork(combo, pick(position === 'before' ? before : after), position);
    },
  };
}
