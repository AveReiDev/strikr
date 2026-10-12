/**
 * Defense mode. Pure — no clock, no DOM, no global randomness.
 *
 * Every combo is followed by a defensive call, as if the opponent fires back:
 * "Jab, Cross, Lead hook" … "Roll". The defense is chosen to fit the combo's
 * last strike (a hook is answered by a roll, a low kick by a check) from the
 * list in data/moves.json. main.js keeps that file on config.moves.
 *
 * createDefenseSelector wraps an ordinary selector and has the same shape
 * (pool, recent, next), so the session can drive it like any other. Each combo
 * it returns carries a `defense` the session calls after the combo's execution
 * time. The combo keeps its own id, so history credits the real combo.
 */

import { classifyCombo } from './strikes.js';

/** The names a defense's `after` list can match a strike by. */
export function strikeKeys(strike) {
  const keys = new Set();
  for (const k of ['category', 'weapon', 'range', 'level']) if (strike?.[k]) keys.add(strike[k]);
  if (strike?.weapon && strike?.level) keys.add(`${strike.weapon}-${strike.level}`);
  return keys;
}

/**
 * The defenses that fit after this combo, for its sport. Empty when the combo
 * already ends on defense or footwork ("… Rear knee, Frame off"): it has its
 * own exit, and a second one would only crowd it. When nothing matches the
 * last strike (an unrecognised custom strike, say), every move for the sport
 * fits.
 */
export function defensesFor(combo, moves, strikes) {
  const forSport = (moves ?? []).filter((m) => !m.sports || m.sports.includes(combo.sport));
  const parts = classifyCombo(combo, strikes);
  const last = parts[parts.length - 1];
  if (!last || last.kind === 'defense' || last.kind === 'footwork') return [];
  // An unrecognised last strike says nothing about the return; pairing it
  // with the strike before would be a guess dressed up as a match.
  if (last.kind === 'unknown') return forSport;

  const lastStrike = [...parts].reverse().find((p) => p.kind === 'strike');
  const keys = strikeKeys(lastStrike);
  const fitting = forSport.filter((m) => (m.after ?? []).some((a) => keys.has(a)));
  return fitting.length ? fitting : forSport;
}

export function createDefenseSelector(inner, { moves, strikes, rng }) {
  let lastName = null;

  /** Uniform over the fitting moves, never the same call twice running. */
  function pick(options) {
    const fresh = options.length > 1 ? options.filter((m) => m.name !== lastName) : options;
    const move = fresh[Math.floor(rng() * fresh.length)] ?? fresh[fresh.length - 1];
    lastName = move.name;
    return { name: move.name, speech: move.speech ?? move.name, actions: 1 };
  }

  return {
    get pool() { return inner.pool; },
    get recent() { return inner.recent; },
    startRound() { inner.startRound?.(); },
    next() {
      const combo = inner.next();
      if (!combo) return null;
      const options = defensesFor(combo, moves, strikes);
      return options.length ? { ...combo, defense: pick(options) } : combo;
    },
  };
}
