import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage, SCHEMA_VERSION } from '../src/store/storage.js';
import { createHistory, dailyVolume } from '../src/store/history.js';
import { computeSuggestion } from '../src/engine/suggest.js';
import { createSettingsStore } from '../src/store/settings.js';

function fakeBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

const CONFIG = {
  intensity: {
    light: { label: 'LIGHT', baseGapMs: 2800, perActionMs: 700 },
    medium: { label: 'MEDIUM', baseGapMs: 1600, perActionMs: 700 },
    hard: { label: 'HARD', baseGapMs: 400, perActionMs: 700 },
    custom: { label: 'CUSTOM', baseGapMs: 1600, perActionMs: 700 },
  },
  defaults: {
    sport: 'muaythai', tier: 'beginner', intensity: 'medium',
    roundLengthMin: 2, roundsPerWorkout: 3, restBetweenRoundsSec: 30,
    countdownSec: 5, voiceGender: 'male', voiceSpeedPct: 75, darkMode: true,
  },
};

let seq = 0;
function rec(over = {}) {
  seq += 1;
  return {
    id: `r${seq}`,
    startedAt: new Date().toISOString(),
    sport: 'muaythai',
    tier: 'beginner',
    intensity: 'medium',
    rounds: 3,
    roundLengthSec: 120,
    restSec: 30,
    durationSec: 360,
    combosCalled: 20,
    completed: true,
    ...over,
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/* ------------------------------------------------------------------ *
 * dailyVolume
 * ------------------------------------------------------------------ */

test('dailyVolume aggregates multiple sessions on the same day', () => {
  const records = [
    rec({ startedAt: daysAgo(1).toISOString(), rounds: 3, intensity: 'medium', roundLengthSec: 120 }),
    rec({ startedAt: daysAgo(1).toISOString(), rounds: 2, intensity: 'medium', roundLengthSec: 120 }),
  ];
  const vol = dailyVolume(records, { sport: 'muaythai' });
  assert.equal(vol.length, 1);
  assert.equal(vol[0].rounds, 5);
  assert.equal(vol[0].sessions, 2);
  assert.equal(vol[0].intensity, 'medium');
  assert.equal(vol[0].roundLengthMin, 2);
});

test('dailyVolume ignores incomplete sessions', () => {
  const records = [
    rec({ startedAt: daysAgo(1).toISOString(), completed: false, rounds: 1 }),
    rec({ startedAt: daysAgo(1).toISOString(), completed: true, rounds: 3 }),
  ];
  const vol = dailyVolume(records, { sport: 'muaythai' });
  assert.equal(vol.length, 1);
  assert.equal(vol[0].rounds, 3);
});

test('dailyVolume filters by sport', () => {
  const records = [
    rec({ startedAt: daysAgo(1).toISOString(), sport: 'boxing', rounds: 5 }),
    rec({ startedAt: daysAgo(1).toISOString(), sport: 'muaythai', rounds: 3 }),
  ];
  const vol = dailyVolume(records, { sport: 'muaythai' });
  assert.equal(vol.length, 1);
  assert.equal(vol[0].rounds, 3);
});

test('dailyVolume uses mode for intensity across sessions', () => {
  const records = [
    rec({ startedAt: daysAgo(1).toISOString(), intensity: 'hard', rounds: 3 }),
    rec({ startedAt: daysAgo(1).toISOString(), intensity: 'hard', rounds: 2 }),
    rec({ startedAt: daysAgo(1).toISOString(), intensity: 'medium', rounds: 1 }),
  ];
  const vol = dailyVolume(records, { sport: 'muaythai' });
  assert.equal(vol[0].intensity, 'hard');
});

test('dailyVolume returns entries sorted by date', () => {
  const records = [
    rec({ startedAt: daysAgo(3).toISOString(), rounds: 1 }),
    rec({ startedAt: daysAgo(1).toISOString(), rounds: 2 }),
    rec({ startedAt: daysAgo(5).toISOString(), rounds: 3 }),
  ];
  const vol = dailyVolume(records, { sport: 'muaythai' });
  assert.equal(vol.length, 3);
  assert.ok(vol[0].day < vol[1].day);
  assert.ok(vol[1].day < vol[2].day);
});

/* ------------------------------------------------------------------ *
 * computeSuggestion
 * ------------------------------------------------------------------ */

test('suggestion returns +1 round when below goal', () => {
  const goal = { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
  const volumes = [{ day: '2026-09-17', rounds: 5, intensity: 'hard', roundLengthMin: 2, sessions: 1 }];
  const current = { roundsPerWorkout: 3, intensity: 'medium', roundLengthMin: 2 };
  const s = computeSuggestion(goal, volumes, current);
  assert.equal(s.rounds, 6);
  assert.equal(s.intensity, 'hard');
  assert.equal(s.goalReached, false);
});

test('suggestion resets rounds to ~70% when stepping up intensity', () => {
  const goal = { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
  const volumes = [{ day: '2026-09-17', rounds: 10, intensity: 'medium', roundLengthMin: 2, sessions: 1 }];
  const current = { roundsPerWorkout: 10, intensity: 'medium', roundLengthMin: 2 };
  const s = computeSuggestion(goal, volumes, current);
  assert.equal(s.intensity, 'hard');
  assert.equal(s.rounds, 7);
  assert.equal(s.goalReached, false);
});

test('suggestion resets rounds when stepping up round length', () => {
  const goal = { rounds: 10, intensity: 'hard', roundLengthMin: 3 };
  const volumes = [{ day: '2026-09-17', rounds: 10, intensity: 'hard', roundLengthMin: 2, sessions: 1 }];
  const current = { roundsPerWorkout: 10, intensity: 'hard', roundLengthMin: 2 };
  const s = computeSuggestion(goal, volumes, current);
  assert.equal(s.roundLengthMin, 3);
  assert.equal(s.rounds, 7);
  assert.equal(s.goalReached, false);
});

test('with no history, suggestion falls back to current settings', () => {
  const goal = { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
  const current = { roundsPerWorkout: 3, intensity: 'medium', roundLengthMin: 2 };
  const s = computeSuggestion(goal, [], current);
  assert.equal(s.rounds, 3);
  assert.equal(s.intensity, 'medium');
  assert.equal(s.goalReached, false);
});

test('day meeting the goal is detected as goal reached', () => {
  const goal = { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
  const volumes = [{ day: '2026-09-17', rounds: 10, intensity: 'hard', roundLengthMin: 2, sessions: 2 }];
  const current = { roundsPerWorkout: 10, intensity: 'hard', roundLengthMin: 2 };
  const s = computeSuggestion(goal, volumes, current);
  assert.equal(s.goalReached, true);
});

test('day exceeding the goal is also detected as goal reached', () => {
  const goal = { rounds: 8, intensity: 'medium', roundLengthMin: 2 };
  const volumes = [{ day: '2026-09-17', rounds: 12, intensity: 'hard', roundLengthMin: 3, sessions: 3 }];
  const current = { roundsPerWorkout: 8, intensity: 'medium', roundLengthMin: 2 };
  const s = computeSuggestion(goal, volumes, current);
  assert.equal(s.goalReached, true);
});

test('null goal produces no suggestion', () => {
  const s = computeSuggestion(null, [], {});
  assert.equal(s, null);
});

/* ------------------------------------------------------------------ *
 * Goal storage
 * ------------------------------------------------------------------ */

test('goal round-trips through settings', () => {
  const backend = fakeBackend();
  const storage = createStorage({ backend });
  const store = createSettingsStore({ config: CONFIG, storage });

  store.set('goal', { rounds: 10, intensity: 'hard', roundLengthMin: 2 });
  const goal = store.get('goal');
  assert.deepEqual(goal, { rounds: 10, intensity: 'hard', roundLengthMin: 2 });

  const store2 = createSettingsStore({ config: CONFIG, storage });
  assert.deepEqual(store2.get('goal'), { rounds: 10, intensity: 'hard', roundLengthMin: 2 });
});

test('invalid goal is sanitised to null', () => {
  const backend = fakeBackend();
  const storage = createStorage({ backend });
  const store = createSettingsStore({ config: CONFIG, storage });

  store.set('goal', { rounds: 999, intensity: 'extreme', roundLengthMin: 2 });
  assert.equal(store.get('goal'), null);
});

test('missing goal defaults to null', () => {
  const backend = fakeBackend();
  const storage = createStorage({ backend });
  const store = createSettingsStore({ config: CONFIG, storage });
  assert.equal(store.get('goal'), null);
});

/* ------------------------------------------------------------------ *
 * Following the suggestions
 * ------------------------------------------------------------------ */

import { CHOICES, GOAL_ROUNDS, GOAL_INTENSITIES, GOAL_ROUND_LENGTHS, INTENSITIES, ROUND_LENGTHS } from '../src/store/settings.js';

/** Do exactly what is suggested, one day at a time, keeping a 14-day window. */
function follow(goal, start, maxDays = 60) {
  let volumes = [start];
  const seen = [];
  for (let i = 1; i <= maxDays; i++) {
    const s = computeSuggestion(goal, volumes, { roundsPerWorkout: 3, intensity: 'light', roundLengthMin: 1 });
    if (s.goalReached) return { days: i, seen };
    seen.push(s);
    volumes = [...volumes, {
      day: `d${String(i).padStart(3, '0')}`, rounds: s.rounds, intensity: s.intensity,
      roundLengthMin: s.roundLengthMin, sessions: 1,
    }].slice(-14);
  }
  return { days: Infinity, seen };
}

test('following the suggestions never repeats one — each day is a step forward', () => {
  // Used to suggest "7 hard" for 14 days straight: the reset after stepping up
  // intensity scored lower than the old medium day, so that day stayed "best".
  const { days, seen } = follow(
    { rounds: 10, intensity: 'hard', roundLengthMin: 3 },
    { day: 'd000', rounds: 3, intensity: 'light', roundLengthMin: 2, sessions: 1 },
  );
  assert.ok(Number.isFinite(days), 'goal never reached');
  for (let i = 1; i < seen.length; i++) {
    assert.notDeepEqual(
      [seen[i].rounds, seen[i].intensity, seen[i].roundLengthMin],
      [seen[i - 1].rounds, seen[i - 1].intensity, seen[i - 1].roundLengthMin],
      `day ${i + 1} repeated day ${i}`,
    );
  }
});

test('every suggestion, for every goal, is a value the settings will accept', () => {
  // settings.set silently ignores values outside the allowed lists, so an
  // unloadable suggestion makes the Load button quietly do nothing.
  for (const rounds of GOAL_ROUNDS) {
    for (const intensity of GOAL_INTENSITIES) {
      for (const roundLengthMin of GOAL_ROUND_LENGTHS) {
        const { seen } = follow(
          { rounds, intensity, roundLengthMin },
          { day: 'd000', rounds: 1, intensity: 'light', roundLengthMin: 1, sessions: 1 },
        );
        for (const s of seen) {
          assert.ok(CHOICES.roundsPerWorkout.includes(s.rounds), `rounds ${s.rounds} not selectable`);
          assert.ok(INTENSITIES.includes(s.intensity), `intensity ${s.intensity} not selectable`);
          assert.ok(ROUND_LENGTHS.includes(s.roundLengthMin), `length ${s.roundLengthMin} not selectable`);
        }
      }
    }
  }
});

test('an easier but longer day does not outrank a harder one', () => {
  const goal = { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
  const volumes = [
    { day: '2026-09-10', rounds: 10, intensity: 'medium', roundLengthMin: 2, sessions: 1 },
    { day: '2026-09-11', rounds: 7, intensity: 'hard', roundLengthMin: 2, sessions: 1 },
  ];
  const s = computeSuggestion(goal, volumes, { roundsPerWorkout: 7, intensity: 'hard', roundLengthMin: 2 });
  assert.equal(s.intensity, 'hard');
  assert.equal(s.rounds, 8);
});

test('all-Custom days are ignored rather than read as "undefined" intensity', () => {
  const goal = { rounds: 10, intensity: 'hard', roundLengthMin: 2 };
  const volumes = [{ day: '2026-09-10', rounds: 6, intensity: undefined, roundLengthMin: 2, sessions: 1 }];
  const s = computeSuggestion(goal, volumes, { roundsPerWorkout: 3, intensity: 'medium', roundLengthMin: 2 });
  assert.equal(s.bestDay, null);
  assert.equal(s.rounds, 3);
});
