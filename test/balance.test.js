import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { categoryOf, categoriesOf, createBalance } from '../src/engine/balance.js';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));

test('strikes are classified by what they are, not by words they contain', () => {
  assert.equal(categoryOf('Jab'), 'jab');
  assert.equal(categoryOf('Double jab'), 'jab');
  assert.equal(categoryOf('Jab feint'), 'jab');
  assert.equal(categoryOf('Cross'), 'cross');
  assert.equal(categoryOf('Lead hook'), 'hook');
  assert.equal(categoryOf('Lead hook to body'), 'hook');
  assert.equal(categoryOf('Rear uppercut'), 'uppercut');
  assert.equal(categoryOf('Rear low kick'), 'rearKick');
  assert.equal(categoryOf('Rear high kick'), 'rearKick');
  assert.equal(categoryOf('Lead body kick'), 'leadKick');
  assert.equal(categoryOf('Switch kick'), 'leadKick');
  assert.equal(categoryOf('Lead teep'), 'teep');
  assert.equal(categoryOf('Rear straight knee'), 'knee');
  assert.equal(categoryOf('Lead up-elbow'), 'elbow');
  assert.equal(categoryOf('Spinning rear elbow'), 'elbow');
});

test('defence is recognised before the kick it names', () => {
  assert.equal(categoryOf('Check rear low kick'), 'defense');
  assert.equal(categoryOf('Check the low kick'), 'defense');
  assert.equal(categoryOf('Catch teep'), 'defense');
  assert.equal(categoryOf('Catch rear kick'), 'defense');
  assert.equal(categoryOf('Slip'), 'defense');
  assert.equal(categoryOf('Roll under'), 'defense');
});

test('things that are not a balanced category are ignored', () => {
  for (const s of ['Spinning back kick', 'Question mark kick', 'Sweep', 'Clinch entry', 'Turn and dump', '(land switched)', '']) {
    assert.equal(categoryOf(s), null, s);
  }
  assert.deepEqual(
    categoriesOf({ display: 'Jab – Cross – Rear body kick – (land switched) – Cross' }),
    ['jab', 'cross', 'rearKick', 'cross'],
  );
});

test('a sport with no target mix is not balanced', () => {
  assert.equal(createBalance({ sport: 'boxing', balance: config.balance }), null);
  assert.equal(createBalance({ sport: 'muaythai', balance: undefined }), null);
});

test('weights stay inside the clamp and favour what has been under-called', () => {
  const bal = createBalance({ sport: 'muaythai', balance: config.balance });
  const handsOnly = { display: 'Jab – Cross – Jab – Cross' };
  const leadKick = { display: 'Lead body kick – Lead low kick' };
  const [lo, hi] = config.balance.clamp;

  for (let i = 0; i < 200; i++) bal.record(handsOnly);   // a hands-only workout so far
  const wHands = bal.weight(handsOnly);
  const wKick = bal.weight(leadKick);
  assert.ok(wKick > wHands, 'kicks are now favoured over more hands');
  for (const w of [wHands, wKick]) assert.ok(w >= lo - 1e-9 && w <= hi + 1e-9, `${w} outside clamp`);
});

test('a combo with nothing recognisable has weight 1', () => {
  const bal = createBalance({ sport: 'muaythai', balance: config.balance });
  assert.equal(bal.weight({ display: 'Spinning back kick' }), 1);
});

test('a fresh tally starts at the target mix, so the first draw is not skewed', () => {
  const bal = createBalance({ sport: 'muaythai', balance: config.balance });
  const w = bal.weight({ display: 'Jab – Cross – Lead low kick' });
  assert.ok(Math.abs(w - 1) < 1e-9, `expected 1, got ${w}`);
});
