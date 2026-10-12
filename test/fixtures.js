/**
 * Shared test setup. Not a test file itself (npm test runs test/*.test.js).
 *
 * loadConfig() mirrors main.js boot(): config.json with the strike dictionary
 * attached as config.strikes, so selectors balance exactly as they do live.
 */
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));

export function loadConfig() {
  return { ...read('config.json'), strikes: read('strikes.json') };
}

export const STRIKES = read('strikes.json');
export const COMBOS = read('combos.json').combos;
