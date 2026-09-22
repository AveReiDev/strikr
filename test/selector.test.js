import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createRng,
  buildPool,
  selectCombo,
  createSelector,
  tierRank,
} from '../src/engine/selector.js';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));
const library = JSON.parse(readFileSync(new URL('../data/combos.json', import.meta.url)));
const COMBOS = library.combos;

function drawMany(n, { sport = 'muaythai', tier = 'advanced', seed = 1 } = {}) {
  const sel = createSelector({ combos: COMBOS, sport, tier, config, rng: createRng(seed) });
  return Array.from({ length: n }, () => sel.next());
}

test('the shipped library is intact', () => {
  const regular = COMBOS.filter((c) => !c.single);
  const singles = COMBOS.filter((c) => c.single);
  assert.equal(regular.length, 90);
  assert.ok(singles.length > 0, 'should have single-strike entries');
  assert.equal(new Set(COMBOS.map((c) => c.id)).size, COMBOS.length);
  for (const c of COMBOS) assert.ok(!c.speech.includes('('), `${c.id} leaks a parenthetical`);
  for (const c of regular) assert.ok(Array.isArray(c.tags), `${c.id} should have tags`);
  for (const c of singles) assert.ok(Array.isArray(c.tags) && c.tags.length, `${c.id} should have tags`);
});

test('pool respects sport, enabled and tier ceiling', () => {
  const beg = buildPool(COMBOS, { sport: 'boxing', tier: 'beginner' });
  assert.ok(beg.length > 0);
  assert.ok(beg.every((c) => c.sport === 'boxing' && c.tier === 'beginner'));

  const adv = buildPool(COMBOS, { sport: 'boxing', tier: 'advanced' });
  assert.equal(adv.length, 30);
  assert.ok(adv.every((c) => tierRank(c.tier) <= 2));

  const disabled = COMBOS.map((c) => ({ ...c, enabled: c.id !== 'bx-beg-01' }));
  const pool = buildPool(disabled, { sport: 'boxing', tier: 'beginner' });
  assert.ok(!pool.some((c) => c.id === 'bx-beg-01'));
});

test('the same seed produces the same sequence', () => {
  const a = drawMany(50, { seed: 12345 }).map((c) => c.id);
  const b = drawMany(50, { seed: 12345 }).map((c) => c.id);
  assert.deepEqual(a, b);

  const c = drawMany(50, { seed: 99999 }).map((x) => x.id);
  assert.notDeepEqual(a, c, 'different seeds should diverge');
});

test('no-repeat window is honoured', () => {
  const ids = drawMany(400).map((c) => c.id);
  const w = config.noRepeatWindow;
  for (let i = w; i < ids.length; i++) {
    const window = ids.slice(i - w, i);
    assert.ok(!window.includes(ids[i]), `${ids[i]} repeated inside the window at ${i}`);
  }
});

test('a two-combo pool still terminates', () => {
  const two = [
    { id: 'a', sport: 'boxing', tier: 'beginner', speech: 'A', display: 'A',
      actions: 2, frequency: 'common', enabled: true },
    { id: 'b', sport: 'boxing', tier: 'beginner', speech: 'B', display: 'B',
      actions: 2, frequency: 'common', enabled: true },
  ];
  const sel = createSelector({
    combos: two, sport: 'boxing', tier: 'beginner', config, rng: createRng(7),
  });
  // The window is larger than the pool, so it shrinks to one: the two must
  // alternate rather than give up and repeat.
  const got = Array.from({ length: 100 }, () => sel.next().id);
  for (let i = 1; i < got.length; i++) assert.notEqual(got[i], got[i - 1], `repeat at ${i}`);
});

test('a single-combo pool still terminates', () => {
  const one = [{ id: 'only', sport: 'boxing', tier: 'beginner', speech: 'X', display: 'X',
    actions: 2, frequency: 'common', enabled: true }];
  const sel = createSelector({
    combos: one, sport: 'boxing', tier: 'beginner', config, rng: createRng(3),
  });
  assert.equal(sel.next().id, 'only');
  assert.equal(sel.next().id, 'only');
});

test('an empty pool returns null rather than throwing', () => {
  const sel = createSelector({
    combos: [], sport: 'boxing', tier: 'beginner', config, rng: createRng(1),
  });
  assert.equal(sel.next(), null);
});

test('tier weighting at Advanced lands near 50/30/20', () => {
  const N = 10000;
  const draws = drawMany(N, { sport: 'muaythai', tier: 'advanced', seed: 42 });
  const count = { advanced: 0, intermediate: 0, beginner: 0 };
  for (const c of draws) count[c.tier]++;

  const pctAdv = (count.advanced / N) * 100;
  const pctInt = (count.intermediate / N) * 100;
  const pctBeg = (count.beginner / N) * 100;

  assert.ok(Math.abs(pctAdv - 50) < 3, `advanced ${pctAdv.toFixed(1)}%, expected ~50`);
  assert.ok(Math.abs(pctInt - 30) < 3, `intermediate ${pctInt.toFixed(1)}%, expected ~30`);
  assert.ok(Math.abs(pctBeg - 20) < 3, `beginner ${pctBeg.toFixed(1)}%, expected ~20`);
});

test('tier weighting at Intermediate renormalises over two tiers', () => {
  const N = 10000;
  const draws = drawMany(N, { sport: 'muaythai', tier: 'intermediate', seed: 8 });
  const inter = draws.filter((c) => c.tier === 'intermediate').length / N * 100;
  const beg = draws.filter((c) => c.tier === 'beginner').length / N * 100;
  assert.equal(draws.filter((c) => c.tier === 'advanced').length, 0);
  // 50 and 30 renormalise to 62.5 / 37.5
  assert.ok(Math.abs(inter - 62.5) < 3, `intermediate ${inter.toFixed(1)}%, expected ~62.5`);
  assert.ok(Math.abs(beg - 37.5) < 3, `beginner ${beg.toFixed(1)}%, expected ~37.5`);
});

test('Beginner yields 100% beginner', () => {
  const draws = drawMany(2000, { sport: 'muaythai', tier: 'beginner', seed: 5 });
  assert.ok(draws.every((c) => c.tier === 'beginner'));
});

test('a constant combo is drawn about 3x as often as an occasional one', () => {
  // Matched pool: same tier, same sport, differing only in frequency.
  const pool = [
    { id: 'occ', frequency: 'occasional' },
    { id: 'com', frequency: 'common' },
    { id: 'con', frequency: 'constant' },
  ].map((c) => ({
    ...c, sport: 'boxing', tier: 'beginner', display: c.id, speech: c.id,
    actions: 2, enabled: true,
  }));

  const N = 30000;
  const rng = createRng(2024);
  const count = { occ: 0, com: 0, con: 0 };
  // Drawn without the no-repeat window so the weights are observed directly.
  for (let i = 0; i < N; i++) {
    const c = selectCombo({ pool, tier: 'beginner', config, rng, recent: [] });
    count[c.id]++;
  }
  const ratio = count.con / count.occ;
  assert.ok(ratio > 2.7 && ratio < 3.3, `constant/occasional was ${ratio.toFixed(2)}, expected ~3`);
  const ratio2 = count.com / count.occ;
  assert.ok(ratio2 > 1.8 && ratio2 < 2.2, `common/occasional was ${ratio2.toFixed(2)}, expected ~2`);
});

test('weak-spot weighting biases toward unpracticed combos', () => {
  const pool = [
    { id: 'fresh', frequency: 'common' },
    { id: 'stale', frequency: 'common' },
  ].map((c) => ({
    ...c, sport: 'boxing', tier: 'beginner', display: c.id, speech: c.id,
    actions: 2, enabled: true,
  }));

  const freqMap = new Map([['stale', 20]]);
  const weakWeight = (c) => 1 / ((freqMap.get(c.id) || 0) + 1);

  const N = 10000;
  const rng = createRng(999);
  let freshCount = 0;
  for (let i = 0; i < N; i++) {
    const c = selectCombo({ pool, tier: 'beginner', config, rng, recent: [], weakWeight });
    if (c.id === 'fresh') freshCount++;
  }
  const freshPct = (freshCount / N) * 100;
  // fresh has weight 1/(0+1) = 1, stale has weight 1/(20+1) ≈ 0.048
  // So fresh should get ~95%+ of the draws.
  assert.ok(freshPct > 90, `fresh got ${freshPct.toFixed(1)}%, expected >90%`);
});

/* ---- 6C: focus filter and singles ---------------------------------------- */

test('buildPool with focus tag filters correctly', () => {
  const pool = buildPool(COMBOS, { sport: 'boxing', tier: 'advanced', focus: 'hands' });
  assert.ok(pool.length > 0, 'should have hand combos');
  assert.ok(pool.every((c) => c.tags.includes('hands')), 'all should be tagged hands');
  assert.ok(pool.every((c) => !c.single), 'no singles in combo-tag filter');
});

test('buildPool with drill tag includes only singles', () => {
  const pool = buildPool(COMBOS, { sport: 'boxing', tier: 'advanced', focus: 'jab' });
  assert.ok(pool.length > 0, 'should have jab singles');
  assert.ok(pool.every((c) => c.tags.includes('jab')), 'all should be tagged jab');
  assert.ok(pool.every((c) => c.single), 'all should be singles');
});

test('buildPool with no focus excludes singles', () => {
  const pool = buildPool(COMBOS, { sport: 'muaythai', tier: 'advanced' });
  assert.ok(pool.length > 0);
  assert.ok(pool.every((c) => !c.single), 'no singles in default pool');
});

test('a focus tag not present yields an empty pool', () => {
  const pool = buildPool(COMBOS, { sport: 'boxing', tier: 'advanced', focus: 'elbows' });
  assert.equal(pool.length, 0, 'boxing has no elbow combos');
});

test('focus filter works with singles across sports', () => {
  for (const sport of ['boxing', 'muaythai', 'kickboxing']) {
    const jabs = buildPool(COMBOS, { sport, tier: 'advanced', focus: 'jab' });
    assert.ok(jabs.length >= 2, `${sport} should have at least 2 jab singles`);
  }
});

test('buildPool focus respects tier ceiling for singles', () => {
  const pool = buildPool(COMBOS, { sport: 'boxing', tier: 'beginner', focus: 'jab' });
  assert.ok(pool.length > 0);
  assert.ok(pool.every((c) => c.tier === 'beginner'));
});

test('a small pool never repeats inside the window', () => {
  // Beginner is 10 combos per sport. The old draw-then-redraw loop gave up
  // about one call in ten here and repeated a combo it had just called.
  const w = config.noRepeatWindow;
  for (const sport of ['boxing', 'muaythai', 'kickboxing']) {
    for (let seed = 1; seed <= 20; seed++) {
      const ids = drawMany(200, { sport, tier: 'beginner', seed }).map((c) => c.id);
      for (let i = 1; i < ids.length; i++) {
        const window = ids.slice(Math.max(0, i - w), i);
        assert.ok(!window.includes(ids[i]), `${sport} seed ${seed}: ${ids[i]} repeated at ${i}`);
      }
    }
  }
});
