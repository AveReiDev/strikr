import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sessionLoad, roundLoad, weekPlan, applyWeekPlan } from '../src/engine/load.js';
import { weeklyLoad } from '../src/store/history.js';
import { CHOICES } from '../src/store/settings.js';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));
const L = config.load;

const weeks = (...loads) => loads.map((load) => ({ load }));
const SUG = { rounds: 8, intensity: 'hard', roundLengthMin: 2, reason: 'You did 7 rounds hard on Mon', goalReached: false };

/* ---- session load --------------------------------------------------- */

test('session load is round minutes weighted by intensity', () => {
  const r = (intensity, rounds, roundLengthSec) => sessionLoad({ intensity, rounds, roundLengthSec }, L);
  assert.equal(r('light', 4, 120), 8);
  assert.equal(r('medium', 4, 120), 10);
  assert.equal(r('hard', 4, 120), 12);
  assert.equal(r('custom', 4, 120), 10, 'custom counts as medium');
  assert.equal(roundLoad('hard', 3, L), 4.5);
});

/* ---- week plan ------------------------------------------------------ */

test('no past training: no target, just a baseline week', () => {
  const p = weekPlan(weeks(0, 0, 12), L);
  assert.equal(p.target, null);
  assert.equal(p.thisWeek, 12);
  assert.equal(p.easy, false);
});

test('the first week trained is only a baseline, since it is usually partial', () => {
  assert.equal(weekPlan(weeks(0, 6, 20), L).target, null, 'a short first week sets no cap');
  const p = weekPlan(weeks(0, 6, 40, 0), L);
  assert.equal(p.reference, 40);
  assert.equal(p.weekOfBlock, 2);
});

test('the target is ten percent over the last normal week', () => {
  const p = weekPlan(weeks(30, 40, 50, 5), L);
  assert.equal(p.reference, 50);
  assert.ok(Math.abs(p.target - 55) < 1e-9);
  assert.equal(p.weekOfBlock, 3);
});

test('after three normal weeks, the fourth is an easy week at sixty percent', () => {
  const p = weekPlan(weeks(10, 40, 44, 48, 0), L);
  assert.equal(p.easy, true);
  assert.ok(Math.abs(p.target - 48 * 0.6) < 1e-9);
  assert.equal(p.weekOfBlock, 4);
});

test('after an easy week a new block starts, measured against the last normal week', () => {
  const p = weekPlan(weeks(10, 40, 44, 48, 28, 0), L);
  assert.equal(p.easy, false);
  assert.equal(p.reference, 48);
  assert.equal(p.weekOfBlock, 1);
  assert.ok(Math.abs(p.target - 48 * 1.1) < 1e-9);
});

test('a week off counts as recovery, so no easy week straight after it', () => {
  const p = weekPlan(weeks(10, 40, 44, 0, 45, 0), L);
  assert.equal(p.easy, false);
  assert.equal(p.weekOfBlock, 2);
  assert.equal(p.reference, 45);
});

test('a naturally light week (sick, travelling) is taken as the easy week', () => {
  const p = weekPlan(weeks(10, 40, 44, 20, 45, 47, 50, 0), L);
  // 20 <= 44 * 0.7 reset the count; 45, 47, 50 are three normal weeks.
  assert.equal(p.easy, true);
});

/* ---- fitting the suggestion into the week --------------------------- */

const plan = (over) => ({ thisWeek: 0, reference: 50, target: 55, easy: false, weekOfBlock: 2, blockLength: 4, ...over });

test('without a target the suggestion passes through untouched', () => {
  assert.deepEqual(applyWeekPlan(SUG, plan({ target: null }), L), SUG);
});

test('a goal-reached card is never rewritten', () => {
  const reached = { ...SUG, goalReached: true };
  assert.deepEqual(applyWeekPlan(reached, plan({ thisWeek: 999 }), L), reached);
});

test('rounds are trimmed to what is left of the week', () => {
  // 55 target - 40 done = 15 left; a hard 2-min round is 3 load, so 5 fit.
  const s = applyWeekPlan(SUG, plan({ thisWeek: 40 }), L);
  assert.equal(s.rounds, 5);
  assert.equal(s.intensity, 'hard');
  assert.match(s.reason, /Trimmed/);
});

test('a suggestion that fits keeps its reason', () => {
  const s = applyWeekPlan(SUG, plan({ thisWeek: 10 }), L);
  assert.equal(s.rounds, 8);
  assert.equal(s.reason, SUG.reason);
});

test('an easy week cuts rounds and keeps the intensity', () => {
  const s = applyWeekPlan(SUG, plan({ easy: true, target: 30 }), L);
  assert.equal(s.rounds, 5);            // round(8 * 0.6)
  assert.equal(s.intensity, 'hard');
  assert.match(s.reason, /Easy week/);
});

test('when the week is used up, it offers an optional light session', () => {
  const s = applyWeekPlan(SUG, plan({ thisWeek: 54 }), L);
  assert.equal(s.weekDone, true);
  assert.equal(s.intensity, 'light');
  assert.equal(s.rounds, 3);
});

test('every adjusted suggestion is a value the settings accept', () => {
  for (let rounds = 1; rounds <= 15; rounds++) {
    for (const thisWeek of [0, 20, 40, 54, 80]) {
      for (const easy of [false, true]) {
        const s = applyWeekPlan({ ...SUG, rounds }, plan({ thisWeek, easy }), L);
        assert.ok(CHOICES.roundsPerWorkout.includes(s.rounds), `${rounds}/${thisWeek}/${easy} -> ${s.rounds}`);
      }
    }
  }
});

/* ---- weekly bucketing ----------------------------------------------- */

test('weeklyLoad buckets sessions into Monday-start weeks, oldest first', () => {
  // Thursday 24 Sep 2026, midday local time.
  const now = new Date(2026, 8, 24, 12).getTime();
  const at = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  const rec = (startedAt, rounds) => ({ startedAt, rounds, roundLengthSec: 60, intensity: 'light' });
  const records = [
    rec(at(2026, 8, 21, 0), 1),    // Monday 00:xx this week
    rec(at(2026, 8, 20, 23), 2),   // Sunday 23:xx: last week
    rec(at(2026, 8, 14), 4),       // Monday last week
    rec(at(2026, 8, 13), 8),       // Sunday two weeks back
    rec(at(2026, 7, 1), 100),      // outside the window
  ];
  const w = weeklyLoad(records, { now, weeks: 3, loadOf: (r) => sessionLoad(r, L) });
  assert.deepEqual(w.map((x) => x.load), [8, 6, 1]);
  assert.equal(new Date(w[2].weekStart).getDay(), 1, 'weeks start on Monday');
});
