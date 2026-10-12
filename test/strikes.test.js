import test from 'node:test';
import assert from 'node:assert/strict';
import { STRIKES, COMBOS } from './fixtures.js';

import { classifyStrike, classifyCombo, profileOf, segmentsOf } from '../src/engine/strikes.js';

const S = STRIKES;
const of = (display, sport = 'muaythai') => profileOf({ display, sport }, S);

test('every strike in the shipped library is in the dictionary', () => {
  // The library is hand-maintained. A new strike name must get a rule in
  // data/strikes.json, or levels, ranges and balance quietly ignore it.
  const unknown = new Set();
  for (const c of COMBOS) for (const u of profileOf(c, S).unknown) unknown.add(`${u}  (${c.id})`);
  assert.deepEqual([...unknown], []);
});

test('every rule is well formed', () => {
  const KINDS = ['strike', 'defense', 'footwork', 'feint'];
  const LEVELS = ['head', 'body', 'leg'];
  const RANGES = ['kicking', 'punching', 'close', 'clinch'];
  for (const r of S.rules) {
    assert.doesNotThrow(() => new RegExp(r.match, 'i'), r.match);
    assert.ok(KINDS.includes(r.kind), r.match);
    if (r.level) assert.ok(LEVELS.includes(r.level), r.match);
    if (r.range) assert.ok(RANGES.includes(r.range), r.match);
    if (r.kind === 'strike') assert.ok(r.weapon && r.range, `${r.match} needs a weapon and a range`);
  }
});

test('category tags agree with what the combo contains', () => {
  // Hand tags drifted before: 14 combos were tagged kicks with no kick in them.
  const WEAPON_TAG = { kicks: 'kick', knees: 'knee', elbows: 'elbow' };
  const wrong = [];
  for (const c of COMBOS.filter((x) => !x.single)) {
    const p = profileOf(c, S);
    const tags = c.tags ?? [];
    for (const [tag, weapon] of Object.entries(WEAPON_TAG)) {
      if (p.weapons.includes(weapon) !== tags.includes(tag)) wrong.push(`${tag} ${c.id}`);
    }
    if (p.defense !== tags.includes('defensive')) wrong.push(`defensive ${c.id}`);
    if (tags.includes('hands') && p.weapons.some((w) => w !== 'punch')) wrong.push(`hands ${c.id}`);
  }
  assert.deepEqual(wrong, []);
});

test('levels follow the target, not the limb', () => {
  const level = (s) => classifyStrike(s, S).level;
  assert.equal(level('Jab'), 'head');
  assert.equal(level('Jab to body'), 'body');
  assert.equal(level('Lead hook to body'), 'body');
  assert.equal(level('Lead shovel hook to body'), 'body');
  assert.equal(level('Cross to head'), 'head');
  assert.equal(level('Rear uppercut'), 'head');
  assert.equal(level('Rear low kick'), 'leg');
  assert.equal(level('Switch low kick'), 'leg');
  assert.equal(level('Rear body kick'), 'body');
  assert.equal(level('Switch kick'), 'body');
  assert.equal(level('Lead high kick'), 'head');
  assert.equal(level('Question mark kick'), 'head');
  assert.equal(level('Lead teep'), 'body');
  assert.equal(level('Rear knee'), 'body');
  assert.equal(level('Lead elbow'), 'head');
});

test('the four ranges', () => {
  const range = (s) => classifyStrike(s, S, 'muaythai').range;
  for (const s of ['Lead teep', 'Rear low kick', 'Switch high kick', 'Spinning back kick']) assert.equal(range(s), 'kicking', s);
  for (const s of ['Jab', 'Long jab', 'Cross', 'Lead hook', 'Jab to body', 'Spinning back fist', 'Rear straight knee', 'Step-up knee']) {
    assert.equal(range(s), 'punching', s);
  }
  for (const s of ['Rear knee', 'Lead elbow', 'Spinning rear elbow', 'Rear uppercut']) assert.equal(range(s), 'close', s);
  for (const s of ['Clinch', 'Clinch entry', 'Long guard entry', 'Turn and dump', 'Sweep']) assert.equal(range(s), 'clinch', s);
});

test('boxing splits into inside and outside', () => {
  const range = (s) => classifyStrike(s, S, 'boxing').range;
  for (const s of ['Jab', 'Double jab', 'Long jab', 'Cross', 'Cross to head', 'Pull counter cross']) assert.equal(range(s), 'outside', s);
  for (const s of ['Lead hook', 'Rear uppercut', 'Jab to body', 'Lead hook to body', 'Cross to body']) assert.equal(range(s), 'inside', s);
  assert.equal(range('Slip'), undefined);
});

test('defence, footwork and feints are not strikes', () => {
  assert.equal(classifyStrike('Check rear low kick', S).kind, 'defense');
  assert.equal(classifyStrike('Catch teep', S).kind, 'defense');
  assert.equal(classifyStrike('Roll under', S).kind, 'defense');
  assert.equal(classifyStrike('Frame off', S).kind, 'defense');
  assert.equal(classifyStrike('Step back', S).kind, 'footwork');
  assert.equal(classifyStrike('Pivot out', S).kind, 'footwork');
  assert.equal(classifyStrike('Step-up knee', S).kind, 'strike');

  const feint = classifyStrike('Teep feint', S);
  assert.equal(feint.kind, 'feint');
  assert.equal(feint.category, 'teep');   // balance still counts what it shows
  assert.equal(feint.level, undefined);
});

test('stage directions are skipped and unknown names are reported', () => {
  assert.equal(classifyStrike('(land switched)', S), null);
  assert.equal(classifyStrike('  ', S), null);
  assert.equal(classifyStrike('Flying armbar', S).kind, 'unknown');
  assert.deepEqual(of('Jab – Flying armbar – (land switched) – Cross').unknown, ['Flying armbar']);
  assert.equal(classifyCombo({ display: 'Jab – (land switched) – Cross' }, S).length, 2);
  assert.deepEqual(segmentsOf({ display: 'Jab – (land switched) – Cross' }), ['Jab', '(land switched)', 'Cross']);
});

test('level changes count switches between adjacent strikes', () => {
  assert.equal(of('Jab – Cross').levelChanges, 0);
  assert.equal(of('Jab to body – Jab – Cross').levelChanges, 1);
  assert.equal(of('Lead low kick – Rear high kick').levelChanges, 1);
  assert.equal(of('Rear low kick – Cross – Rear body kick').levelChanges, 2);
  // Defence in between does not break the pair.
  assert.equal(of('Jab – Slip – Lead hook to body').levelChanges, 1);
  // Clinch work has no level, so it neither adds nor breaks a change.
  assert.equal(of('Lead elbow – Clinch – Rear knee').levelChanges, 1);
});

test('a profile lists what the combo works, in order', () => {
  const p = of('Lead teep – Cross – Lead hook – Rear knee – Lead elbow');
  assert.deepEqual(p.ranges, ['kicking', 'punching', 'close']);
  assert.deepEqual(p.levels, ['body', 'head']);
  assert.deepEqual(p.weapons, ['kick', 'punch', 'knee', 'elbow']);
  assert.equal(p.defense, false);
  assert.equal(of('Check the low kick – Cross').defense, true);
});

test('with no dictionary everything is unknown, nothing throws', () => {
  assert.equal(classifyStrike('Jab', undefined).kind, 'unknown');
  assert.equal(profileOf({ display: 'Jab – Cross' }, null).levelChanges, 0);
});
