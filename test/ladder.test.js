import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  rungsOf, buildLadderPool, ladderSequence, createLadderSelector, MIN_RUNGS,
} from '../src/engine/ladder.js';
import { createSession } from '../src/engine/session.js';
import { createRng } from '../src/engine/selector.js';
import { estimateSpeechMs, voiceRate } from '../src/engine/timing.js';
import { createSettingsStore } from '../src/store/settings.js';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));
const COMBOS = JSON.parse(readFileSync(new URL('../data/combos.json', import.meta.url))).combos;

const JCHC = {
  id: 'x-1', sport: 'boxing', tier: 'beginner', frequency: 'common', enabled: true,
  display: 'Jab – Cross – Lead hook – Cross', speech: 'Jab, Cross, Lead hook, Cross', actions: 4,
};

test('rungsOf builds the combo up one strike at a time', () => {
  const rungs = rungsOf(JCHC);
  assert.deepEqual(rungs.map((r) => r.speech), [
    'Jab', 'Jab, Cross', 'Jab, Cross, Lead hook', 'Jab, Cross, Lead hook, Cross',
  ]);
  assert.deepEqual(rungs.map((r) => r.actions), [1, 2, 3, 4]);
  assert.equal(rungs[1].display, 'Jab – Cross');
});

test('a parenthetical never ends a rung, but still counts as an action', () => {
  const combo = COMBOS.find((c) => c.id === 'mt-adv-03');   // has "(land switched)"
  const rungs = rungsOf(combo);
  assert.equal(rungs.length, 5);                           // 6 segments, 5 spoken
  for (let i = 1; i < rungs.length; i++) {
    assert.notEqual(rungs[i].speech, rungs[i - 1].speech, 'no rung repeats the one before');
  }
  const afterSwitch = rungs[3];
  assert.equal(afterSwitch.display, 'Jab – Cross – Rear body kick – (land switched) – Cross');
  assert.equal(afterSwitch.speech, 'Jab, Cross, Rear body kick, Cross');
  assert.equal(afterSwitch.actions, 5);
  assert.equal(rungs.at(-1).speech, combo.speech, 'the top rung is the whole combo');
  assert.equal(rungs.at(-1).actions, combo.actions);
});

test('every shipped combo ladders back to exactly itself', () => {
  for (const c of COMBOS) {
    const top = rungsOf(c).at(-1);
    assert.equal(top.speech, c.speech, c.id);
    assert.equal(top.actions, c.actions, c.id);
  }
});

test('ladder pool holds only non-single combos with enough rungs', () => {
  const pool = buildLadderPool(COMBOS, { sport: 'muaythai', tier: 'advanced' });
  assert.ok(pool.length > 10);
  for (const c of pool) {
    assert.ok(!c.single);
    assert.ok(rungsOf(c).length >= MIN_RUNGS, c.id);
  }
  // A drill focus is singles only, so there is nothing to ladder.
  assert.equal(buildLadderPool(COMBOS, { sport: 'muaythai', tier: 'advanced', focus: 'jab' }).length, 0);
});

test('ladder sequence climbs, pyramid climbs then descends', () => {
  const up = ladderSequence(JCHC, { mode: 'ladder' }).map((c) => c.ladder.rung);
  assert.deepEqual(up, [1, 2, 3, 4]);
  const pyr = ladderSequence(JCHC, { mode: 'pyramid' }).map((c) => c.ladder.rung);
  assert.deepEqual(pyr, [1, 2, 3, 4, 3, 2, 1]);
});

test('reps repeat each rung; the pyramid top is not doubled', () => {
  const seq = ladderSequence(JCHC, { mode: 'pyramid', reps: 2 }).map((c) => c.ladder.rung);
  assert.deepEqual(seq, [1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 2, 2, 1, 1]);
});

test('only the top rung carries the real combo id', () => {
  const seq = ladderSequence(JCHC, { mode: 'pyramid' });
  assert.deepEqual(seq.map((c) => c.id), ['x-1#1', 'x-1#2', 'x-1#3', 'x-1', 'x-1#3', 'x-1#2', 'x-1#1']);
  for (const c of seq) assert.equal(c.ladder.baseId, 'x-1');
});

test('ladder selector finishes one ladder before starting the next, and varies the base', () => {
  const sel = createLadderSelector({
    combos: COMBOS, sport: 'boxing', tier: 'advanced', config, rng: createRng(7), mode: 'ladder', reps: 1,
  });
  const bases = [];
  let prev = null;
  for (let i = 0; i < 60; i++) {
    const c = sel.next();
    if (c.ladder.rung === 1) {
      if (prev) assert.equal(prev.ladder.rung, prev.ladder.of, 'previous ladder ran to the top');
      bases.push(c.ladder.baseId);
    } else {
      assert.equal(c.ladder.rung, prev.ladder.rung + 1);
      assert.equal(c.ladder.baseId, prev.ladder.baseId);
    }
    prev = c;
  }
  for (let i = 1; i < bases.length; i++) assert.notEqual(bases[i], bases[i - 1]);
});

test('startRound abandons a half-climbed ladder', () => {
  const sel = createLadderSelector({
    combos: COMBOS, sport: 'boxing', tier: 'advanced', config, rng: createRng(3), mode: 'ladder', reps: 1,
  });
  sel.next();
  assert.equal(sel.next().ladder.rung, 2);
  sel.startRound();
  assert.equal(sel.next().ladder.rung, 1);
});

/** Minimal fake-clock driver: records every combo called and the round it fell in. */
function runLadderWorkout(settings, seed = 1) {
  const s = {
    sport: 'muaythai', tier: 'advanced', intensity: 'medium', roundLengthMin: 1,
    roundsPerWorkout: 2, restBetweenRoundsSec: 10, countdownSec: 0, voiceSpeedPct: 75, ...settings,
  };
  const rate = voiceRate(s.voiceSpeedPct, config.voiceRateRange);
  const session = createSession({ config, settings: s, combos: COMBOS, rng: createRng(seed) });
  const calls = [];
  let t = 0, speechEndsAt = null, round = 0, summary = null;
  const push = (events) => {
    for (const e of events) {
      if (e.type === 'state' && e.to === 'ROUND') round += 1;
      if (e.type === 'combo') calls.push({ round, combo: e.combo });
      if (e.type === 'say') speechEndsAt = t + estimateSpeechMs(e.text, rate, config.speechEstimate);
      if (e.type === 'finished') summary = e.summary;
    }
  };
  push(session.start(t));
  push(session.ready(t));
  while (!summary && t < 10 * 60 * 1000) {
    t += 50;
    if (speechEndsAt !== null && t >= speechEndsAt) { speechEndsAt = null; push(session.speechEnded(t)); }
    push(session.tick(t));
  }
  return { calls, summary };
}

test('a ladder session calls rungs in order and restarts at rung one each round', () => {
  const { calls, summary } = runLadderWorkout({ workoutMode: 'ladder' });
  assert.equal(summary.mode, 'ladder');
  assert.ok(calls.every((c) => c.combo.ladder), 'every call is a rung');
  for (const r of [1, 2]) {
    const inRound = calls.filter((c) => c.round === r);
    assert.ok(inRound.length >= 3, `round ${r} called some rungs`);
    assert.equal(inRound[0].combo.ladder.rung, 1, `round ${r} opens on rung one`);
  }
});

test('random mode is unchanged: no rungs, mode recorded as random', () => {
  const { calls, summary } = runLadderWorkout({});
  assert.equal(summary.mode, 'random');
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => !c.combo.ladder));
});

test('settings accept the ladder modes and reps, and reject anything else', () => {
  const mem = new Map();
  const storage = {
    read: (k, fallback, sanitise) => (mem.has(k) ? sanitise(mem.get(k), fallback) : fallback),
    write: (k, v) => mem.set(k, JSON.parse(JSON.stringify(v))),
  };
  const settings = createSettingsStore({ config, storage });
  assert.equal(settings.get('workoutMode'), 'random');
  assert.equal(settings.get('ladderReps'), 1);
  settings.set('workoutMode', 'pyramid');
  settings.set('ladderReps', 3);
  assert.equal(settings.get('workoutMode'), 'pyramid');
  assert.equal(settings.get('ladderReps'), 3);
  // Out-of-list values never land; the store falls back to the default.
  settings.set('workoutMode', 'staircase');
  settings.set('ladderReps', 7);
  assert.equal(settings.get('workoutMode'), 'random');
  assert.equal(settings.get('ladderReps'), 1);
});
