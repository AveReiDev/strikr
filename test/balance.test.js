import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './fixtures.js';

import { categoryOf, categoriesOf, createBalance } from '../src/engine/balance.js';

const config = loadConfig();
const S = config.strikes;

test('strikes are classified by what they are, not by words they contain', () => {
  assert.equal(categoryOf('Jab', S), 'jab');
  assert.equal(categoryOf('Double jab', S), 'jab');
  assert.equal(categoryOf('Jab feint', S), 'jab');
  assert.equal(categoryOf('Cross', S), 'cross');
  assert.equal(categoryOf('Lead hook', S), 'hook');
  assert.equal(categoryOf('Lead hook to body', S), 'hook');
  assert.equal(categoryOf('Rear uppercut', S), 'uppercut');
  assert.equal(categoryOf('Rear low kick', S), 'rearKick');
  assert.equal(categoryOf('Rear high kick', S), 'highKick');
  assert.equal(categoryOf('Lead high kick', S), 'highKick');
  assert.equal(categoryOf('Switch high kick', S), 'highKick');
  assert.equal(categoryOf('Question mark kick', S), 'highKick');
  assert.equal(categoryOf('Lead body kick', S), 'leadKick');
  assert.equal(categoryOf('Switch kick', S), 'leadKick');
  assert.equal(categoryOf('Lead teep', S), 'teep');
  assert.equal(categoryOf('Rear straight knee', S), 'knee');
  assert.equal(categoryOf('Lead up-elbow', S), 'elbow');
  assert.equal(categoryOf('Spinning rear elbow', S), 'elbow');
  assert.equal(categoryOf('Long jab', S), 'jab');
  assert.equal(categoryOf('Pull counter cross', S), 'cross');
});

test('defence is recognised before the kick it names', () => {
  assert.equal(categoryOf('Check rear low kick', S), 'defense');
  assert.equal(categoryOf('Check the low kick', S), 'defense');
  assert.equal(categoryOf('Catch teep', S), 'defense');
  assert.equal(categoryOf('Catch rear kick', S), 'defense');
  assert.equal(categoryOf('Slip', S), 'defense');
  assert.equal(categoryOf('Roll under', S), 'defense');
});

test('things that are not a balanced category are ignored', () => {
  for (const s of ['Spinning back kick', 'Sweep', 'Clinch entry', 'Turn and dump', '(land switched)', '']) {
    assert.equal(categoryOf(s, S), null, s);
  }
  assert.deepEqual(
    categoriesOf({ display: 'Jab – Cross – Rear body kick – (land switched) – Cross' }, S),
    ['jab', 'cross', 'rearKick', 'cross'],
  );
});

test('a sport with no target mix is not balanced', () => {
  assert.equal(createBalance({ sport: 'boxing', balance: config.balance, strikes: S }), null);
  assert.equal(createBalance({ sport: 'muaythai', balance: undefined }), null);
});

test('no strike dictionary means no balancing, not a silent flat weight', () => {
  assert.equal(createBalance({ sport: 'muaythai', balance: config.balance }), null);
  assert.equal(categoryOf('Jab', undefined), null);
});

test('weights stay inside the clamp and favour what has been under-called', () => {
  const bal = createBalance({ sport: 'muaythai', balance: config.balance, strikes: S });
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
  const bal = createBalance({ sport: 'muaythai', balance: config.balance, strikes: S });
  assert.equal(bal.weight({ display: 'Spinning back kick' }), 1);
});

test('a fresh tally starts at the target mix, so the first draw is not skewed', () => {
  const bal = createBalance({ sport: 'muaythai', balance: config.balance, strikes: S });
  const w = bal.weight({ display: 'Jab – Cross – Lead low kick' });
  assert.ok(Math.abs(w - 1) < 1e-9, `expected 1, got ${w}`);
});
