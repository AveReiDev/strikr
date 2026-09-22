import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage, KEYS } from '../src/store/storage.js';
import { createHistory } from '../src/store/history.js';
import { createBackup, parseBackup, restoreBackup, backupFilename } from '../src/store/backup.js';

function fakeBackend() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const rec = (id, over = {}) => ({
  id, startedAt: '2026-09-20T10:00:00.000Z', sport: 'muaythai', tier: 'beginner',
  intensity: 'medium', rounds: 3, roundLengthSec: 120, restSec: 30, durationSec: 400,
  combosCalled: 30, completed: true, ...over,
});

test('a backup round-trips onto an empty device', () => {
  const a = createStorage({ backend: fakeBackend() });
  a.write(KEYS.settings, { sport: 'boxing', tier: 'advanced' });
  a.write(KEYS.library, { overrides: { 'mt-beg-01': { enabled: false } }, customs: [] });
  a.write(KEYS.history, [rec('s1'), rec('s2')]);

  const text = JSON.stringify(createBackup(a));
  const parsed = parseBackup(text);
  assert.ok(parsed.ok);

  const b = createStorage({ backend: fakeBackend() });
  const result = restoreBackup(b, parsed.backup);
  assert.equal(result.historyAdded, 2);
  assert.equal(result.settings, true);
  assert.equal(createHistory({ storage: b }).all().length, 2);
  assert.deepEqual(b.read(KEYS.settings, null, (d) => d), { sport: 'boxing', tier: 'advanced' });
  assert.equal(b.read(KEYS.library, null, (d) => d).overrides['mt-beg-01'].enabled, false);
});

test('restore merges history by id and keeps sessions logged since the backup', () => {
  const s = createStorage({ backend: fakeBackend() });
  s.write(KEYS.history, [rec('old'), rec('newer', { rounds: 9 })]);
  const backup = { app: 'strikr', format: 1, history: [rec('old'), rec('newer', { rounds: 1 }), rec('lost')] };

  const result = restoreBackup(s, backup);
  assert.equal(result.historyAdded, 1);
  const all = createHistory({ storage: s }).all();
  assert.deepEqual(all.map((r) => r.id).sort(), ['lost', 'newer', 'old']);
  assert.equal(all.find((r) => r.id === 'newer').rounds, 9, "the device's own copy wins a clash");
});

test('restore unions custom combos rather than replacing them', () => {
  const s = createStorage({ backend: fakeBackend() });
  s.write(KEYS.library, { overrides: {}, customs: [{ id: 'cus-a' }] });
  const result = restoreBackup(s, {
    app: 'strikr', format: 1,
    library: { overrides: { x: { enabled: false } }, customs: [{ id: 'cus-a' }, { id: 'cus-b' }] },
  });
  assert.equal(result.customsAdded, 1);
  const lib = s.read(KEYS.library, null, (d) => d);
  assert.deepEqual(lib.customs.map((c) => c.id), ['cus-a', 'cus-b']);
  assert.equal(lib.overrides.x.enabled, false);
});

test('garbage inside a backup is filtered by the stores, not trusted', () => {
  const s = createStorage({ backend: fakeBackend() });
  restoreBackup(s, { app: 'strikr', format: 1, history: [rec('good'), { id: 'bad', sport: 'curling' }, 'nope', null] });
  assert.deepEqual(createHistory({ storage: s }).all().map((r) => r.id), ['good']);
});

test('non-backups are rejected with a readable reason', () => {
  assert.equal(parseBackup('not json').ok, false);
  assert.match(parseBackup('{"hello":1}').error, /not a STRIKR backup/);
  assert.match(parseBackup('{"app":"strikr","format":99}').error, /Unsupported/);
});

test('sections missing from a backup are left alone', () => {
  const s = createStorage({ backend: fakeBackend() });
  s.write(KEYS.settings, { sport: 'boxing' });
  const result = restoreBackup(s, { app: 'strikr', format: 1, history: [] });
  assert.equal(result.settings, false);
  assert.deepEqual(s.read(KEYS.settings, null, (d) => d), { sport: 'boxing' });
});

test('backup filename uses the local date', () => {
  assert.match(backupFilename(new Date(2026, 8, 5, 23, 30).getTime()), /^strikr-backup-2026-09-05\.json$/);
});
