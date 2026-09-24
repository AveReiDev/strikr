import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createSession, STATES } from '../src/engine/session.js';
import { createRng } from '../src/engine/selector.js';
import { estimateSpeechMs, voiceRate, gapMsFor } from '../src/engine/timing.js';
import { createSettingsStore } from '../src/store/settings.js';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));
const COMBOS = JSON.parse(readFileSync(new URL('../data/combos.json', import.meta.url))).combos;

const BASE = {
  sport: 'muaythai', tier: 'advanced', intensity: 'hard', roundLengthMin: 1,
  roundsPerWorkout: 3, restBetweenRoundsSec: 10, countdownSec: 0, voiceSpeedPct: 75,
};

/**
 * Fake-clock driver. Records each round's intensity as the round opens, and
 * every callout with the round time remaining when it was spoken.
 */
function run(settings = {}, { seed = 1, combos = COMBOS } = {}) {
  const s = { ...BASE, ...settings };
  const rate = voiceRate(s.voiceSpeedPct, config.voiceRateRange);
  const session = createSession({ config, settings: s, combos, rng: createRng(seed) });
  const roundMs = s.roundLengthMin * 60000;
  const rounds = [];
  const says = [];
  let t = 0, speechEndsAt = null, summary = null, round = 0, roundStart = 0, lastCombo = null;

  const push = (events) => {
    for (const e of events) {
      if (e.type === 'state' && e.to === STATES.ROUND) {
        round += 1;
        roundStart = t;
        rounds.push(session.snapshot(t).intensity);
      }
      // The session emits 'combo' just before its 'say'; the announcement has no combo.
      if (e.type === 'combo') lastCombo = e.combo;
      if (e.type === 'say' && e.tag === 'combo') {
        says.push({ round, t, left: roundMs - (t - roundStart), text: e.text, combo: lastCombo });
        lastCombo = null;
      }
      if (e.type === 'say') speechEndsAt = t + estimateSpeechMs(e.text, rate, config.speechEstimate);
      if (e.type === 'finished') summary = e.summary;
    }
  };
  push(session.start(t));
  push(session.ready(t));
  while (!summary && t < 30 * 60000) {
    t += 25;
    if (speechEndsAt !== null && t >= speechEndsAt) { speechEndsAt = null; push(session.speechEnded(t)); }
    push(session.tick(t));
  }
  return { rounds, says, summary, rate };
}

/* ---- ramp up -------------------------------------------------------- */

test('ramp up starts one preset step easier and reaches the chosen intensity on the last round', () => {
  const { rounds, summary } = run({ rampUp: true });
  const peak = config.intensity.hard.baseGapMs;
  const extra = config.ramp.startExtraGapMs;
  assert.deepEqual(rounds.map((i) => i.baseGapMs), [peak + extra, peak + extra / 2, peak]);
  assert.equal(summary.rampUp, true);
});

test('ramp off keeps every round at the chosen intensity', () => {
  const { rounds, summary } = run({});
  assert.ok(rounds.every((i) => i.baseGapMs === config.intensity.hard.baseGapMs));
  assert.equal(summary.rampUp, false);
});

test('a one-round workout with ramp up is simply the chosen intensity', () => {
  const { rounds } = run({ rampUp: true, roundsPerWorkout: 1 });
  assert.equal(rounds[0].baseGapMs, config.intensity.hard.baseGapMs);
});

test('ramp up never touches execution time per strike', () => {
  const { rounds } = run({ rampUp: true, roundsPerWorkout: 5 });
  assert.ok(rounds.every((i) => i.perActionMs === config.intensity.hard.perActionMs));
});

/* ---- finisher ------------------------------------------------------- */

test('the finisher is announced once per round, as its window opens', () => {
  const { says, summary } = run({ finisherSec: 20 });
  const calls = says.filter((s) => s.text === config.finisher.callout);
  assert.deepEqual(calls.map((c) => c.round), [1, 2, 3]);
  for (const c of calls) {
    assert.ok(c.left <= 20000, 'not before the window');
    // At worst it waits for one combo already being spoken to finish.
    assert.ok(c.left > 20000 - 4000, `announced promptly (had ${c.left}ms left)`);
  }
  assert.equal(summary.finisherSec, 20);
});

test('after the announcement, every call in the round is a short combo', () => {
  const { says } = run({ finisherSec: 30, workoutMode: 'ladder' });
  for (const r of [1, 2, 3]) {
    const inRound = says.filter((s) => s.round === r);
    const at = inRound.findIndex((s) => s.text === config.finisher.callout);
    const after = inRound.slice(at + 1);
    assert.ok(after.length >= 3, `round ${r} had finisher calls`);
    for (const s of after) {
      assert.ok(s.combo.actions <= config.finisher.maxActions, s.text);
      assert.equal(s.combo.ladder, undefined, 'finisher calls are whole combos, not rungs');
    }
  }
});

test('finisher calls use the finisher gap, not the round\'s', () => {
  const { says, rate } = run({ intensity: 'light', finisherSec: 30, roundsPerWorkout: 1 });
  const at = says.findIndex((s) => s.text === config.finisher.callout);
  const fin = says.slice(at + 1);
  for (let i = 0; i < fin.length - 1; i++) {
    const spoken = estimateSpeechMs(fin[i].text, rate, config.speechEstimate);
    const gap = fin[i + 1].t - fin[i].t - spoken;
    const expected = gapMsFor(fin[i].combo, { ...config.intensity.light, baseGapMs: config.finisher.baseGapMs });
    assert.ok(Math.abs(gap - expected) <= 50, `gap ${gap} vs ${expected}`);
  }
});

test('the finisher never takes more than half the round', () => {
  const { says } = run({ finisherSec: 45, roundsPerWorkout: 1 });
  const call = says.find((s) => s.text === config.finisher.callout);
  assert.ok(call.left <= 30000);
});

test('no finisher when there are no short combos to call', () => {
  const long = COMBOS.filter((c) => c.actions >= 3);
  const { says, summary } = run({ finisherSec: 20 }, { combos: long });
  assert.ok(!says.some((s) => s.text === config.finisher.callout));
  assert.equal(summary.finisherSec, 0);
});

test('a finisher still never talks over the bell', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { says, rate } = run({ finisherSec: 30 }, { seed });
    for (const s of says) {
      const spoken = estimateSpeechMs(s.text, rate, config.speechEstimate);
      assert.ok(spoken <= s.left + config.roundEndLookaheadMs, `seed ${seed}: "${s.text}" overran`);
    }
  }
});

/* ---- settings ------------------------------------------------------- */

test('settings hold ramp and finisher, and refuse values outside the lists', () => {
  const mem = new Map();
  const storage = {
    read: (k, fallback, sanitise) => (mem.has(k) ? sanitise(mem.get(k), fallback) : fallback),
    write: (k, v) => mem.set(k, JSON.parse(JSON.stringify(v))),
  };
  const settings = createSettingsStore({ config, storage });
  assert.equal(settings.get('rampUp'), false);
  assert.equal(settings.get('finisherSec'), 0);
  settings.set('rampUp', true);
  settings.set('finisherSec', 20);
  assert.equal(createSettingsStore({ config, storage }).get('rampUp'), true);
  assert.equal(createSettingsStore({ config, storage }).get('finisherSec'), 20);
  settings.set('finisherSec', 25);
  assert.equal(settings.get('finisherSec'), 0);
});
