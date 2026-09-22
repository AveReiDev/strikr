import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage, KEYS, NAMESPACE, SCHEMA_VERSION } from '../src/store/storage.js';
import {
  createHistory, computeStreak, localDayKey, periodStart, newSessionId,
  formatDuration, formatTotal, formatDayHeading,
  comboFrequency, comboCoverage, leastPracticed,
} from '../src/store/history.js';

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
const makeHistory = (backend = fakeBackend()) =>
  createHistory({ storage: createStorage({ backend }) });

/** A local-time date, n days before the reference, at the given hour. */
function daysAgo(n, hour = 12, from = Date.now()) {
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

let seq = 0;
function record(over = {}) {
  seq += 1;
  return {
    id: `r${seq}`,
    startedAt: new Date().toISOString(),
    sport: 'muaythai',
    tier: 'advanced',
    intensity: 'light',
    rounds: 3,
    roundLengthSec: 120,
    restSec: 30,
    durationSec: 360,
    combosCalled: 42,
    completed: true,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Writing records
 * ------------------------------------------------------------------ */

test('a completed session is recorded', () => {
  const h = makeHistory();
  assert.ok(h.add(record()));
  assert.equal(h.all().length, 1);
});

test('an abandoned session is recorded only if a round finished', () => {
  const h = makeHistory();
  // Spec 6.3: nothing finished, nothing worth keeping.
  assert.equal(h.add(record({ completed: false, rounds: 0 })), null);
  assert.equal(h.all().length, 0);

  assert.ok(h.add(record({ completed: false, rounds: 2 })));
  assert.equal(h.all().length, 1);
  assert.equal(h.all()[0].completed, false);
});

test('records survive a reload', () => {
  const backend = fakeBackend();
  makeHistory(backend).add(record({ combosCalled: 17 }));
  const b = makeHistory(backend);
  assert.equal(b.all().length, 1);
  assert.equal(b.all()[0].combosCalled, 17);
});

test('records come back newest first', () => {
  const h = makeHistory();
  h.add(record({ startedAt: daysAgo(2).toISOString() }));
  h.add(record({ startedAt: daysAgo(0).toISOString() }));
  h.add(record({ startedAt: daysAgo(1).toISOString() }));
  const days = h.all().map((r) => localDayKey(r.startedAt));
  assert.deepEqual(days, [
    localDayKey(daysAgo(0)), localDayKey(daysAgo(1)), localDayKey(daysAgo(2)),
  ]);
});

test('session ids are unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newSessionId()));
  assert.equal(ids.size, 500);
});

/* ------------------------------------------------------------------ *
 * The day streak
 * ------------------------------------------------------------------ */

test('no sessions means no streak', () => {
  assert.equal(computeStreak([]), 0);
});

test('training today gives a streak of one', () => {
  assert.equal(computeStreak([record({ startedAt: daysAgo(0).toISOString() })]), 1);
});

test('consecutive days accumulate', () => {
  const rs = [0, 1, 2, 3].map((n) => record({ startedAt: daysAgo(n).toISOString() }));
  assert.equal(computeStreak(rs), 4);
});

test('a streak survives having not trained yet today', () => {
  // Trained yesterday and the day before, nothing yet today. The streak is
  // still alive — showing 0 all morning would be both wrong and dispiriting.
  const rs = [1, 2, 3].map((n) => record({ startedAt: daysAgo(n).toISOString() }));
  assert.equal(computeStreak(rs), 3);
});

test('a gap breaks the streak', () => {
  const rs = [0, 1, 3, 4].map((n) => record({ startedAt: daysAgo(n).toISOString() }));
  assert.equal(computeStreak(rs), 2, 'should stop at the gap');
});

test('a stale streak is dead', () => {
  const rs = [3, 4, 5].map((n) => record({ startedAt: daysAgo(n).toISOString() }));
  assert.equal(computeStreak(rs), 0);
});

test('several sessions in one day count once', () => {
  const rs = [
    record({ startedAt: daysAgo(0, 7).toISOString() }),
    record({ startedAt: daysAgo(0, 12).toISOString() }),
    record({ startedAt: daysAgo(0, 19).toISOString() }),
    record({ startedAt: daysAgo(1, 8).toISOString() }),
  ];
  assert.equal(computeStreak(rs), 2);
});

test('abandoned sessions do not keep a streak alive', () => {
  const rs = [
    record({ startedAt: daysAgo(0).toISOString(), completed: false, rounds: 1 }),
    record({ startedAt: daysAgo(1).toISOString(), completed: true }),
  ];
  assert.equal(computeStreak(rs), 1, 'only the completed day should count');
});

test('a late-evening session counts as that local day, not the next UTC one', () => {
  // The trap: 23:30 local west of Greenwich is already tomorrow in UTC.
  // Using UTC dates would silently split a streak.
  const late = daysAgo(0, 23);
  const alsoLate = daysAgo(1, 23);
  assert.equal(computeStreak([
    record({ startedAt: late.toISOString() }),
    record({ startedAt: alsoLate.toISOString() }),
  ]), 2);
});

test('an early-morning session counts as that local day', () => {
  const early = daysAgo(0, 1);
  const alsoEarly = daysAgo(1, 1);
  assert.equal(computeStreak([
    record({ startedAt: early.toISOString() }),
    record({ startedAt: alsoEarly.toISOString() }),
  ]), 2);
});

test('a long streak counts every day of it', () => {
  const rs = Array.from({ length: 30 }, (_, n) => record({ startedAt: daysAgo(n).toISOString() }));
  assert.equal(computeStreak(rs), 30);
});

/* ------------------------------------------------------------------ *
 * Period filters and aggregates
 * ------------------------------------------------------------------ */

test('weeks start on Monday', () => {
  // A known Wednesday.
  const wed = new Date(2026, 7, 5, 15, 0, 0);
  const start = new Date(periodStart('week', wed.getTime()));
  assert.equal(start.getDay(), 1, 'week should start on a Monday');
  assert.equal(start.getHours(), 0);
  assert.ok(start.getTime() <= wed.getTime());

  // And a Sunday belongs to the week that began the previous Monday.
  const sun = new Date(2026, 7, 9, 15, 0, 0);
  const sunStart = new Date(periodStart('week', sun.getTime()));
  assert.equal(sunStart.getDay(), 1);
  assert.equal(sunStart.getDate(), 3, 'Sunday 9 Aug belongs to the week from Mon 3 Aug');
});

test('month starts on the first', () => {
  const d = new Date(2026, 7, 20, 15, 0, 0);
  const start = new Date(periodStart('month', d.getTime()));
  assert.equal(start.getDate(), 1);
  assert.equal(start.getMonth(), 7);
});

test('all time has no lower bound', () => {
  assert.equal(periodStart('all'), -Infinity);
});

test('period filters select the right records', () => {
  const h = makeHistory();
  h.add(record({ startedAt: daysAgo(0).toISOString() }));
  h.add(record({ startedAt: daysAgo(40).toISOString() }));
  h.add(record({ startedAt: daysAgo(400).toISOString() }));

  assert.equal(h.inPeriod('all').length, 3);
  assert.ok(h.inPeriod('month').length >= 1);
  assert.ok(h.inPeriod('month').length <= 2);
  assert.ok(h.inPeriod('week').length >= 1);
  assert.ok(h.inPeriod('week').length <= h.inPeriod('month').length);
});

test('aggregates add up over the filtered period', () => {
  const h = makeHistory();
  h.add(record({ startedAt: daysAgo(0).toISOString(), rounds: 3, durationSec: 360, combosCalled: 40 }));
  h.add(record({ startedAt: daysAgo(0).toISOString(), rounds: 5, durationSec: 600, combosCalled: 60 }));
  const s = h.summary('all');
  assert.equal(s.sessions, 2);
  assert.equal(s.rounds, 8);
  assert.equal(s.totalSec, 960);
  assert.equal(s.combosCalled, 100);
});

test('the streak ignores the period filter', () => {
  // "Current streak" is a property of now, not of the window being viewed.
  const h = makeHistory();
  h.add(record({ startedAt: daysAgo(0).toISOString() }));
  h.add(record({ startedAt: daysAgo(1).toISOString() }));
  assert.equal(h.summary('week').streak, h.summary('all').streak);
  assert.equal(h.summary('all').streak, 2);
});

test('grouping by day is reverse chronological', () => {
  const h = makeHistory();
  h.add(record({ startedAt: daysAgo(1).toISOString() }));
  h.add(record({ startedAt: daysAgo(0, 9).toISOString() }));
  h.add(record({ startedAt: daysAgo(0, 18).toISOString() }));

  const groups = h.groupedByDay('all');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].day, localDayKey(daysAgo(0)));
  assert.equal(groups[0].records.length, 2);
  // Within a day, newest first too.
  assert.ok(
    Date.parse(groups[0].records[0].startedAt) > Date.parse(groups[0].records[1].startedAt)
  );
});

/* ------------------------------------------------------------------ *
 * Corrupt data
 * ------------------------------------------------------------------ */

test('a corrupt history key falls back to empty without throwing', () => {
  for (const junk of ['{', 'null', '"text"', '{"a":1}', '[1,2,3]']) {
    const backend = fakeBackend({ [NAMESPACE + KEYS.history]: junk });
    let h;
    assert.doesNotThrow(() => { h = makeHistory(backend); }, `threw on ${junk}`);
    assert.deepEqual(h.all(), []);
  }
});

test('individually broken records are dropped, good ones kept', () => {
  const good = record({ id: 'keep' });
  const backend = fakeBackend({
    [NAMESPACE + KEYS.history]: stored([
      good,
      { ...record(), id: 'bad-sport', sport: 'chess' },
      { ...record(), id: 'bad-date', startedAt: 'not a date' },
      { ...record(), id: 'bad-rounds', rounds: 'three' },
      { ...record(), id: undefined },
      null,
      'nope',
    ]),
  });
  const h = makeHistory(backend);
  assert.equal(h.all().length, 1);
  assert.equal(h.all()[0].id, 'keep');
});

test('duplicate ids are de-duplicated', () => {
  const r = record({ id: 'dup' });
  const backend = fakeBackend({ [NAMESPACE + KEYS.history]: stored([r, { ...r }]) });
  assert.equal(makeHistory(backend).all().length, 1);
});

test('a negative or absurd number is rejected rather than stored', () => {
  const h = makeHistory();
  assert.equal(h.add(record({ durationSec: -5 })), null);
  assert.equal(h.add(record({ rounds: Number.NaN })), null);
  assert.equal(h.all().length, 0);
});

test('clear empties history and persists that', () => {
  const backend = fakeBackend();
  const h = makeHistory(backend);
  h.add(record());
  h.clear();
  assert.deepEqual(h.all(), []);
  assert.deepEqual(makeHistory(backend).all(), []);
});

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

test('durations format as minutes and seconds', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(30), '0:30');
  assert.equal(formatDuration(360), '6:00');
  assert.equal(formatDuration(125), '2:05');
});

test('totals format compactly', () => {
  assert.equal(formatTotal(45), '45s');
  assert.equal(formatTotal(720), '12m');
  assert.equal(formatTotal(5040), '1h 24m');
});

test('day headings read as Today and Yesterday', () => {
  const now = Date.now();
  assert.equal(formatDayHeading(localDayKey(daysAgo(0)), now), 'Today');
  assert.equal(formatDayHeading(localDayKey(daysAgo(1)), now), 'Yesterday');
  assert.notEqual(formatDayHeading(localDayKey(daysAgo(5)), now), 'Today');
});

/* ------------------------------------------------------------------ *
 * Per-combo tracking (Phase 6A)
 * ------------------------------------------------------------------ */

test('comboFrequency counts across multiple records', () => {
  const records = [
    record({ combosCalledIds: ['a', 'b', 'a', 'c'] }),
    record({ combosCalledIds: ['a', 'b'] }),
  ];
  const freq = comboFrequency(records);
  assert.equal(freq.get('a'), 3);
  assert.equal(freq.get('b'), 2);
  assert.equal(freq.get('c'), 1);
});

test('comboFrequency filters by sport', () => {
  const records = [
    record({ sport: 'boxing', combosCalledIds: ['a', 'b'] }),
    record({ sport: 'muaythai', combosCalledIds: ['c', 'd'] }),
  ];
  const freq = comboFrequency(records, { sport: 'boxing' });
  assert.equal(freq.get('a'), 1);
  assert.equal(freq.has('c'), false);
});

test('comboFrequency ignores records without combosCalledIds', () => {
  const records = [
    record({ combosCalled: 10 }),
    record({ combosCalledIds: ['x'] }),
  ];
  const freq = comboFrequency(records);
  assert.equal(freq.size, 1);
  assert.equal(freq.get('x'), 1);
});

test('comboCoverage identifies practiced vs unpracticed', () => {
  const pool = [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
  ];
  const records = [
    record({ combosCalledIds: ['a', 'b', 'a'] }),
  ];
  const cov = comboCoverage(records, pool);
  assert.equal(cov.practiced, 2);
  assert.equal(cov.total, 4);
  assert.ok(cov.practicedIds.has('a'));
  assert.ok(cov.practicedIds.has('b'));
  assert.ok(!cov.practicedIds.has('c'));
});

test('leastPracticed returns unpracticed first, then least called', () => {
  const pool = [
    { id: 'a' }, { id: 'b' }, { id: 'c' },
  ];
  const records = [
    record({ combosCalledIds: ['a', 'a', 'a', 'b'] }),
  ];
  const result = leastPracticed(records, pool);
  assert.equal(result[0], 'c');
  assert.equal(result[1], 'b');
  assert.equal(result[2], 'a');
});

test('leastPracticed respects the limit parameter', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const records = [record({ combosCalledIds: ['a'] })];
  const result = leastPracticed(records, pool, { limit: 2 });
  assert.equal(result.length, 2);
});

test('combosCalledIds round-trips through storage', () => {
  const backend = fakeBackend();
  const h = makeHistory(backend);
  h.add(record({ combosCalledIds: ['mt-beg-01', 'mt-int-03', 'mt-beg-01'] }));
  const h2 = makeHistory(backend);
  const r = h2.all()[0];
  assert.deepEqual(r.combosCalledIds, ['mt-beg-01', 'mt-int-03', 'mt-beg-01']);
});

test('old records without combosCalledIds do not break aggregation', () => {
  const h = makeHistory();
  h.add(record());
  assert.doesNotThrow(() => comboFrequency(h.all()));
  assert.equal(comboFrequency(h.all()).size, 0);
  assert.doesNotThrow(() => comboCoverage(h.all(), [{ id: 'x' }]));
});
