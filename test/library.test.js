import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createStorage, KEYS, NAMESPACE, SCHEMA_VERSION } from '../src/store/storage.js';
import { createLibrary, deriveFromDisplay, validateCustom } from '../src/store/library.js';

const SHIPPED = JSON.parse(readFileSync(new URL('../data/combos.json', import.meta.url))).combos;

function fakeBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
    raw: (k) => map.get(k),
  };
}
const stored = (v) => JSON.stringify({ schemaVersion: SCHEMA_VERSION, data: v });
const makeLib = (backend = fakeBackend()) =>
  createLibrary({ shipped: SHIPPED, storage: createStorage({ backend }) });

/* ------------------------------------------------------------------ *
 * Deriving speech and actions from a display string
 * ------------------------------------------------------------------ */

test('derives speech and actions the same way the generator did', () => {
  for (const combo of SHIPPED) {
    const d = deriveFromDisplay(combo.display);
    assert.equal(d.speech, combo.speech, `${combo.id} speech`);
    assert.equal(d.actions, combo.actions, `${combo.id} actions`);
    assert.equal(d.display, combo.display, `${combo.id} display`);
  }
});

test('accepts a plain spaced hyphen, which is what people actually type', () => {
  const typed = deriveFromDisplay('Jab - Cross - Lead hook');
  assert.equal(typed.display, 'Jab – Cross – Lead hook');
  assert.equal(typed.speech, 'Jab, Cross, Lead hook');
  assert.equal(typed.actions, 3);
});

test('does not split hyphenated strikes', () => {
  // The whole reason the split requires surrounding whitespace.
  const d = deriveFromDisplay('Jab - Lead up-elbow - Step-up knee');
  assert.equal(d.actions, 3, `split into ${d.actions}: ${d.display}`);
  assert.equal(d.speech, 'Jab, Lead up-elbow, Step-up knee');
});

test('parentheticals are timed but never spoken', () => {
  const d = deriveFromDisplay('Cross – (land switched) – Lead hook');
  assert.equal(d.actions, 3, 'the stage direction still costs time');
  assert.equal(d.speech, 'Cross, Lead hook');
  assert.ok(!d.speech.includes('('));
});

test('tolerates messy spacing and trailing separators', () => {
  const d = deriveFromDisplay('  Jab   -   Cross -  ');
  assert.equal(d.actions, 2);
  assert.equal(d.speech, 'Jab, Cross');
});

test('rejects combos that would leave the voice with nothing to say', () => {
  assert.equal(validateCustom({
    display: '(shift stance)', sport: 'boxing', tier: 'beginner', frequency: 'common',
  }).ok, false);
  assert.equal(validateCustom({
    display: '', sport: 'boxing', tier: 'beginner', frequency: 'common',
  }).ok, false);
});

test('rejects bad sport, tier or frequency', () => {
  const base = { display: 'Jab - Cross', sport: 'boxing', tier: 'beginner', frequency: 'common' };
  assert.equal(validateCustom({ ...base, sport: 'chess' }).ok, false);
  assert.equal(validateCustom({ ...base, tier: 'wizard' }).ok, false);
  assert.equal(validateCustom({ ...base, frequency: 'always' }).ok, false);
  assert.equal(validateCustom(base).ok, true);
});

/* ------------------------------------------------------------------ *
 * The merge layer
 * ------------------------------------------------------------------ */

test('a fresh library is exactly the shipped one', () => {
  const lib = makeLib();
  assert.equal(lib.all().length, SHIPPED.length);
  assert.equal(lib.activePool().length, SHIPPED.length);
});

test('the shipped library is never written into storage', () => {
  const backend = fakeBackend();
  const lib = makeLib(backend);
  lib.setEnabled('mt-beg-01', false);
  lib.setFrequency('mt-beg-02', 'constant');
  lib.addCustom({ display: 'Jab - Cross', sport: 'boxing', tier: 'beginner', frequency: 'common' });

  const raw = backend.raw(NAMESPACE + KEYS.library);
  assert.ok(raw, 'library key should exist');
  assert.ok(!raw.includes('mt-adv-07'), 'an untouched shipped combo leaked into storage');
  // Only the two touched ids plus the custom should appear.
  const parsed = JSON.parse(raw).data;
  assert.deepEqual(Object.keys(parsed.overrides).sort(), ['mt-beg-01', 'mt-beg-02']);
  assert.equal(parsed.customs.length, 1);
});

test('the in-memory shipped array is never mutated', () => {
  const before = JSON.stringify(SHIPPED);
  const lib = makeLib();
  lib.setEnabled('mt-beg-01', false);
  lib.setFrequency('mt-beg-01', 'constant');
  assert.equal(JSON.stringify(SHIPPED), before, 'the shipped data was modified in place');
});

test('overrides survive a reload and apply on top of the shipped combo', () => {
  const backend = fakeBackend();
  const a = makeLib(backend);
  a.setEnabled('mt-beg-01', false);
  a.setFrequency('mt-beg-01', 'constant');

  const b = makeLib(backend);
  const combo = b.find('mt-beg-01');
  assert.equal(combo.enabled, false);
  assert.equal(combo.frequency, 'constant');
  // Everything else about it is still the shipped value.
  const ship = SHIPPED.find((c) => c.id === 'mt-beg-01');
  assert.equal(combo.display, ship.display);
  assert.equal(combo.actions, ship.actions);
});

test('disabling combos removes them from the active pool', () => {
  const lib = makeLib();
  const before = lib.activePool().length;
  lib.setEnabled('mt-beg-01', false);
  lib.setEnabled('mt-beg-02', false);
  assert.equal(lib.activePool().length, before - 2);
  assert.ok(!lib.activePool().some((c) => c.id === 'mt-beg-01'));
});

/* ------------------------------------------------------------------ *
 * Custom combos
 * ------------------------------------------------------------------ */

test('adding a custom combo derives its speech and actions', () => {
  const lib = makeLib();
  const res = lib.addCustom({
    display: 'Jab - Cross - (switch) - Rear low kick',
    sport: 'muaythai', tier: 'intermediate', frequency: 'constant',
  });
  assert.equal(res.ok, true);
  assert.equal(res.combo.speech, 'Jab, Cross, Rear low kick');
  assert.equal(res.combo.actions, 4);
  assert.equal(res.combo.custom, true);
  assert.equal(res.combo.enabled, true);
  assert.ok(res.combo.id.startsWith('cus-'));
});

test('custom combo ids cannot collide with shipped ids', () => {
  const lib = makeLib();
  const ids = new Set(SHIPPED.map((c) => c.id));
  for (let i = 0; i < 50; i++) {
    const r = lib.addCustom({
      display: `Jab - Cross ${i}`, sport: 'boxing', tier: 'beginner', frequency: 'common',
    });
    assert.ok(!ids.has(r.combo.id), 'collided with a shipped id');
    assert.equal(ids.has(r.combo.id), false);
    ids.add(r.combo.id);
  }
  assert.equal(ids.size, SHIPPED.length + 50, 'duplicate custom ids were generated');
});

test('a custom combo joins the pool and can be drawn', () => {
  const lib = makeLib();
  const { combo } = lib.addCustom({
    display: 'Superman punch - Rear low kick',
    sport: 'muaythai', tier: 'advanced', frequency: 'common',
  });
  assert.ok(lib.activePool().some((c) => c.id === combo.id));
});

test('editing a custom combo re-derives everything', () => {
  const lib = makeLib();
  const { combo } = lib.addCustom({
    display: 'Jab - Cross', sport: 'boxing', tier: 'beginner', frequency: 'common',
  });
  const res = lib.updateCustom(combo.id, {
    display: 'Jab - Cross - Lead hook - Rear uppercut',
    sport: 'boxing', tier: 'intermediate', frequency: 'occasional',
  });
  assert.equal(res.ok, true);
  assert.equal(res.combo.actions, 4);
  assert.equal(res.combo.speech, 'Jab, Cross, Lead hook, Rear uppercut');
  assert.equal(res.combo.tier, 'intermediate');
  assert.equal(res.combo.id, combo.id, 'the id must not change on edit');
});

test('custom combos can be deleted; shipped combos cannot', () => {
  const lib = makeLib();
  const { combo } = lib.addCustom({
    display: 'Jab - Cross', sport: 'boxing', tier: 'beginner', frequency: 'common',
  });
  assert.equal(lib.remove(combo.id).ok, true);
  assert.equal(lib.find(combo.id), null);

  const res = lib.remove('mt-beg-01');
  assert.equal(res.ok, false);
  assert.ok(lib.find('mt-beg-01'), 'the shipped combo must still be there');
});

test('shipped combos cannot be edited', () => {
  const lib = makeLib();
  const res = lib.updateCustom('mt-beg-01', {
    display: 'Nonsense', sport: 'boxing', tier: 'beginner', frequency: 'common',
  });
  assert.equal(res.ok, false);
  assert.equal(lib.find('mt-beg-01').display, SHIPPED.find((c) => c.id === 'mt-beg-01').display);
});

test('an invalid custom combo is refused with a reason', () => {
  const lib = makeLib();
  const res = lib.addCustom({ display: '', sport: 'boxing', tier: 'beginner', frequency: 'common' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.length > 0);
  assert.equal(lib.all().length, SHIPPED.length, 'nothing should have been added');
});

/* ------------------------------------------------------------------ *
 * Corrupt stored data
 * ------------------------------------------------------------------ */

test('a corrupt library key falls back to the shipped library untouched', () => {
  for (const junk of ['{', 'null', '[]', '"text"', '{"overrides":"nope","customs":"nope"}']) {
    const backend = fakeBackend({ [NAMESPACE + KEYS.library]: junk });
    let lib;
    assert.doesNotThrow(() => { lib = makeLib(backend); }, `threw on ${junk}`);
    assert.equal(lib.all().length, SHIPPED.length);
    assert.equal(lib.activePool().length, SHIPPED.length);
  }
});

test('individually broken customs are dropped, good ones kept', () => {
  const backend = fakeBackend({
    [NAMESPACE + KEYS.library]: stored({
      overrides: { 'mt-beg-01': { enabled: false } },
      customs: [
        { id: 'cus-good', sport: 'boxing', tier: 'beginner', display: 'Jab – Cross',
          speech: 'Jab, Cross', actions: 2, frequency: 'common', enabled: true, custom: true },
        { id: 'cus-bad-sport', sport: 'chess', tier: 'beginner', display: 'Jab – Cross',
          frequency: 'common', enabled: true },
        { display: 'no id at all', sport: 'boxing', tier: 'beginner', frequency: 'common' },
        null,
        'not even an object',
      ],
    }),
  });
  const lib = makeLib(backend);
  const customs = lib.all().filter((c) => c.custom);
  assert.equal(customs.length, 1);
  assert.equal(customs[0].id, 'cus-good');
  assert.equal(lib.find('mt-beg-01').enabled, false, 'the good override should still apply');
});

test('a bogus override value is ignored rather than applied', () => {
  const backend = fakeBackend({
    [NAMESPACE + KEYS.library]: stored({
      overrides: { 'mt-beg-01': { enabled: 'yes please', frequency: 'sometimes' } },
      customs: [],
    }),
  });
  const combo = makeLib(backend).find('mt-beg-01');
  const ship = SHIPPED.find((c) => c.id === 'mt-beg-01');
  assert.equal(combo.enabled, ship.enabled);
  assert.equal(combo.frequency, ship.frequency);
});

test('duplicate custom ids in storage are de-duplicated', () => {
  const one = { id: 'cus-dup', sport: 'boxing', tier: 'beginner', display: 'Jab – Cross',
    frequency: 'common', enabled: true };
  const backend = fakeBackend({
    [NAMESPACE + KEYS.library]: stored({ overrides: {}, customs: [one, { ...one }] }),
  });
  assert.equal(makeLib(backend).all().filter((c) => c.custom).length, 1);
});

/* ------------------------------------------------------------------ *
 * Grouping, search and counts
 * ------------------------------------------------------------------ */

test('grouping by sport covers every combo exactly once', () => {
  const lib = makeLib();
  const groups = lib.bySport();
  const total = groups.reduce((n, g) => n + g.combos.length, 0);
  assert.equal(total, SHIPPED.length);
  for (const g of groups) assert.ok(g.combos.every((c) => c.sport === g.sport));
});

test('search filters by display, tier and frequency', () => {
  const lib = makeLib();
  const flat = (q) => lib.bySport(q).flatMap((g) => g.combos);

  const teeps = flat('teep');
  assert.ok(teeps.length > 0);
  assert.ok(teeps.every((c) => `${c.display} ${c.speech}`.toLowerCase().includes('teep')));

  assert.ok(flat('advanced').every((c) => c.tier === 'advanced'));
  assert.equal(flat('zzzznotacombo').length, 0);
});

test('custom combos sort above shipped ones in their sport', () => {
  const lib = makeLib();
  lib.addCustom({ display: 'Zzz last alphabetically', sport: 'boxing', tier: 'advanced',
    frequency: 'common' });
  const boxing = lib.bySport().find((g) => g.sport === 'boxing').combos;
  assert.equal(boxing[0].custom, true);
});

test('counts report active against total', () => {
  const lib = makeLib();
  const before = lib.counts('muaythai');
  assert.equal(before.active, before.total);
  lib.setEnabled('mt-beg-01', false);
  assert.equal(lib.counts('muaythai').active, before.active - 1);
  assert.equal(lib.counts('muaythai').total, before.total);
});

test('reset clears customs and overrides but not the shipped library', () => {
  const lib = makeLib();
  lib.setEnabled('mt-beg-01', false);
  lib.addCustom({ display: 'Jab - Cross', sport: 'boxing', tier: 'beginner', frequency: 'common' });
  lib.reset();
  assert.equal(lib.all().length, SHIPPED.length);
  assert.equal(lib.find('mt-beg-01').enabled, true);
});

test('custom combos preserve tags through storage round-trip', () => {
  const lib = makeLib();
  const res = lib.addCustom({
    display: 'Jab - Cross - Lead hook',
    sport: 'boxing',
    tier: 'beginner',
    frequency: 'common',
    tags: ['hands', 'body'],
  });
  assert.ok(res.ok);
  const found = lib.find(res.combo.id);
  assert.deepEqual(found.tags, ['hands', 'body']);
});

test('custom combo tags are sanitised to known values', () => {
  const lib = makeLib();
  const res = lib.addCustom({
    display: 'Jab - Cross',
    sport: 'boxing',
    tier: 'beginner',
    frequency: 'common',
    tags: ['hands', 'INVALID', 42, 'kicks'],
  });
  assert.ok(res.ok);
  assert.deepEqual(res.combo.tags, ['hands', 'kicks']);
});

test('shipped combos have tags arrays', () => {
  const lib = makeLib();
  const all = lib.all();
  for (const c of all) {
    if (!c.custom) {
      assert.ok(Array.isArray(c.tags), `${c.id} should have tags array`);
    }
  }
});
