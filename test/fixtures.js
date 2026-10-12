/**
 * Shared test setup. Not a test file itself (npm test runs test/*.test.js).
 *
 * loadConfig() mirrors main.js boot(): config.json with the strike dictionary
 * on config.strikes and the defense list on config.moves, as they are live.
 */
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));

export function loadConfig() {
  return { ...read('config.json'), strikes: read('strikes.json'), moves: read('moves.json') };
}

export const STRIKES = read('strikes.json');
export const MOVES = read('moves.json');
export const COMBOS = read('combos.json').combos;
