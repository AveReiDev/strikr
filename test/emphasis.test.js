import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, COMBOS } from './fixtures.js';

import { emphasisWeight } from '../src/engine/emphasis.js';
import { profileOf } from '../src/engine/strikes.js';
import { createSelector, createRng } from '../src/engine/selector.js';
import { createLadderSelector } from '../src/engine/ladder.js';
import { createSettingsStore, EMPHASES } from '../src/store/settings.js';

const config = loadConfig();
const strikes = config.strikes;

test('levels weight is 1 + k per level change; off is no weighting', () => {
  const w = emphasisWeight('levels', { strikes, config });
  const k = config.emphasis.levelsPerChange;
  assert.equal(w({ display: 'Jab – Cross', sport: 'boxing' }), 1);
  assert.equal(w({ display: 'Jab to body – Jab – Cross', sport: 'boxing' }), 1 + k);
  assert.equal(w({ display: 'Rear low kick – Cross – Rear body kick', sport: 'muaythai' }), 1 + 2 * k);
  assert.equal(emphasisWeight('off', { strikes, config }), null);
  assert.equal(emphasisWeight(undefined, { strikes, config }), null);
  assert.equal(emphasisWeight('levels', { strikes: undefined, config }), null);
});

test('an unrecognised custom strike gets a neutral weight, not an error', () => {
  const w = emphasisWeight('levels', { strikes, config });
  assert.equal(w({ display: 'Flying armbar – Spinning thing', sport: 'muaythai' }), 1);
});

/** Mean level changes per call over many draws. */
function meanChanges(sport, tier, emphasis, make = createSelector) {
  const sel = make({ combos: COMBOS, sport, tier, config, rng: createRng(7), emphasis, mode: 'ladder', reps: 1 });
  let sum = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) sum += profileOf(sel.next(), strikes).levelChanges;
  return sum / N;
}

test('levels emphasis calls more level-changing combos, in every sport', () => {
  for (const sport of ['boxing', 'muaythai', 'kickboxing']) {
    const off = meanChanges(sport, 'advanced', 'off');
    const on = meanChanges(sport, 'advanced', 'levels');
    assert.ok(on > off * 1.1, `${sport}: ${on.toFixed(2)} vs ${off.toFixed(2)}`);
  }
});

test('levels emphasis never shrinks the pool', () => {
  const args = { combos: COMBOS, sport: 'boxing', tier: 'beginner', config, rng: createRng(1) };
  assert.equal(
    createSelector({ ...args, emphasis: 'levels' }).pool.length,
    createSelector({ ...args, emphasis: 'off' }).pool.length,
  );
});

test('ladders lean the same way when choosing which combo to climb', () => {
  const sel = (emphasis) => createLadderSelector({
    combos: COMBOS, sport: 'muaythai', tier: 'advanced', config, rng: createRng(3), emphasis, mode: 'ladder', reps: 1,
  });
  const baseChanges = (s) => {
    let sum = 0; let n = 0;
    for (let i = 0; i < 4000; i++) {
      const rung = s.next();
      if (rung.ladder.rung !== rung.ladder.of) continue;   // count each climbed combo once
      sum += profileOf(rung, strikes).levelChanges; n += 1;
    }
    return sum / n;
  };
  assert.ok(baseChanges(sel('levels')) > baseChanges(sel('off')));
});

test('emphasis is a setting with a fixed list, off by default', () => {
  const mem = new Map();
  const storage = {
    read: (k, fallback, sanitise) => (mem.has(k) ? sanitise(mem.get(k), fallback) : fallback),
    write: (k, v) => mem.set(k, JSON.parse(JSON.stringify(v))),
  };
  const settings = createSettingsStore({ config, storage });
  assert.deepEqual(EMPHASES, ['off', 'levels', 'ranges', 'kicking', 'punching', 'close', 'clinch', 'outside', 'inside']);
  assert.equal(settings.get('emphasis'), 'off');
  settings.set('emphasis', 'levels');
  assert.equal(createSettingsStore({ config, storage }).get('emphasis'), 'levels');
  settings.set('emphasis', 'clinch');
  assert.equal(settings.get('emphasis'), 'clinch');
  settings.set('emphasis', 'sideways');
  assert.equal(settings.get('emphasis'), 'off');
});
