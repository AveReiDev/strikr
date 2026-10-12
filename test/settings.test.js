import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './fixtures.js';

import { createSettingsStore, HOME_SECTIONS } from '../src/store/settings.js';
import { KEYS } from '../src/store/storage.js';

const config = loadConfig();

function memoryStorage() {
  const mem = new Map();
  return {
    mem,
    read: (k, fallback, sanitise) => (mem.has(k) ? sanitise(mem.get(k), fallback) : fallback),
    write: (k, v) => mem.set(k, JSON.parse(JSON.stringify(v))),
  };
}

test('Home sections start open, and closing one survives a reload', () => {
  const storage = memoryStorage();
  const settings = createSettingsStore({ config, storage });
  assert.deepEqual(settings.get('homeCollapsed'), []);
  settings.set('homeCollapsed', ['focus']);
  assert.deepEqual(createSettingsStore({ config, storage }).get('homeCollapsed'), ['focus']);
});

test('only known section ids are kept, once each, in a fixed order', () => {
  const settings = createSettingsStore({ config, storage: memoryStorage() });
  settings.set('homeCollapsed', ['focus', 'nonsense', 'sport', 'focus', 3]);
  assert.deepEqual(settings.get('homeCollapsed'), ['sport', 'focus']);
  settings.set('homeCollapsed', 'focus');
  assert.deepEqual(settings.get('homeCollapsed'), []);
  for (const id of HOME_SECTIONS) assert.equal(typeof id, 'string');
});

test('changing another setting keeps the collapsed sections', () => {
  const settings = createSettingsStore({ config, storage: memoryStorage() });
  settings.set('homeCollapsed', ['focus', 'workoutMode']);
  settings.set('roundsPerWorkout', 8);
  assert.deepEqual(settings.get('homeCollapsed'), ['workoutMode', 'focus']);
  assert.equal(settings.get('roundsPerWorkout'), 8);
});

test('a corrupt stored value falls back to all open', () => {
  const storage = memoryStorage();
  storage.mem.set(KEYS.settings, { homeCollapsed: { focus: true }, roundsPerWorkout: 7 });
  const settings = createSettingsStore({ config, storage });
  assert.deepEqual(settings.get('homeCollapsed'), []);
  assert.equal(settings.get('roundsPerWorkout'), 7, 'the stored record was really read');
});

test('reset opens every section', () => {
  const settings = createSettingsStore({ config, storage: memoryStorage() });
  settings.set('homeCollapsed', ['focus']);
  settings.reset();
  assert.deepEqual(settings.get('homeCollapsed'), []);
});
