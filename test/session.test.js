import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createSession, STATES } from '../src/engine/session.js';
import { createRng } from '../src/engine/selector.js';
import { estimateSpeechMs, voiceRate, gapMsFor } from '../src/engine/timing.js';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));
const COMBOS = JSON.parse(readFileSync(new URL('../data/combos.json', import.meta.url))).combos;

const BASE = {
  sport: 'muaythai',
  tier: 'advanced',
  intensity: 'medium',
  roundLengthMin: 1,
  roundsPerWorkout: 2,
  restBetweenRoundsSec: 10,
  countdownSec: 5,
  voiceSpeedPct: 75,
};

/**
 * Drives a session with a fake clock. Speech is simulated at the same duration
 * the engine estimates, so the round-end guarantee can be checked honestly.
 */
function runWorkout({ settings = {}, seed = 1, stepMs = 50, maxMs = 20 * 60 * 1000 } = {}) {
  const s = { ...BASE, ...settings };
  const rate = voiceRate(s.voiceSpeedPct, config.voiceRateRange);
  const session = createSession({ config, settings: s, combos: COMBOS, rng: createRng(seed) });

  const log = [];
  let t = 0;
  let speechEndsAt = null;
  let done = false;

  const push = (events) => {
    for (const e of events) {
      log.push({ t, ...e });
      if (e.type === 'say') speechEndsAt = t + estimateSpeechMs(e.text, rate, config.speechEstimate);
      else if (e.type === 'cancelSpeech') speechEndsAt = null;
      else if (e.type === 'finished') done = true;
    }
  };

  push(session.start(t));
  push(session.ready(t));

  while (t < maxMs && !done) {
    t += stepMs;
    if (speechEndsAt !== null && t >= speechEndsAt) {
      speechEndsAt = null;
      push(session.speechEnded(t));
    }
    push(session.tick(t));
  }
  return { log, session, t, settings: s, rate };
}

const only = (log, type) => log.filter((e) => e.type === type);
const states = (log) => only(log, 'state').map((e) => e.to);

test('a full workout walks the expected states', () => {
  const { log } = runWorkout();
  assert.deepEqual(states(log), [
    STATES.PREPARING,
    STATES.COUNTDOWN,
    STATES.ROUND,
    STATES.REST,
    STATES.ROUND,
    STATES.COMPLETE,
  ]);
});

test('three rounds produce three rounds and two rests', () => {
  const { log } = runWorkout({ settings: { roundsPerWorkout: 3 } });
  const seq = states(log);
  assert.equal(seq.filter((s) => s === STATES.ROUND).length, 3);
  assert.equal(seq.filter((s) => s === STATES.REST).length, 2);
  assert.equal(seq[seq.length - 1], STATES.COMPLETE);
});

test('the countdown speaks every second down to one', () => {
  const { log } = runWorkout();
  const counted = only(log, 'say').filter((e) => e.tag === 'countdown').map((e) => e.text);
  assert.deepEqual(counted, ['5', '4', '3', '2', '1']);
});

test('the bell rings at the start and end of every round', () => {
  const { log } = runWorkout();
  // 2 rounds: 2 starts + 2 ends
  assert.equal(only(log, 'bell').length, 4);
});

test('rest announces ten seconds and a three-two-one lead-in', () => {
  const { log } = runWorkout({ settings: { restBetweenRoundsSec: 30 } });
  const rest = only(log, 'say').filter((e) => e.tag === 'rest').map((e) => e.text);
  assert.deepEqual(rest, ['10 seconds', '3', '2', '1']);
});

test('combos are called during rounds, and never spoken as their display string', () => {
  const { log } = runWorkout();
  const said = only(log, 'say').filter((e) => e.tag === 'combo');
  assert.ok(said.length > 5, `only ${said.length} callouts in two one-minute rounds`);
  for (const e of said) assert.ok(!e.text.includes('('), 'a parenthetical reached the voice');
  for (const e of said) assert.ok(!e.text.includes('–'), 'an en dash reached the voice');
});

test('the gap between callouts matches the formula for the combo just spoken', () => {
  const { log, settings } = runWorkout({ stepMs: 10 });
  const intensity = config.intensity[settings.intensity];

  const combos = only(log, 'combo');
  const says = only(log, 'say').filter((e) => e.tag === 'combo');
  assert.equal(combos.length, says.length);

  // For each consecutive pair inside the same round, the time from the end of
  // one callout to the start of the next should be that combo's gap.
  let checked = 0;
  for (let i = 0; i < combos.length - 1; i++) {
    const spokeAt = says[i].t;
    const speechMs = estimateSpeechMs(says[i].text, 1.35, config.speechEstimate);
    const endedAt = spokeAt + speechMs;
    const nextAt = says[i + 1].t;
    const gap = nextAt - endedAt;
    const expected = gapMsFor(combos[i].combo, intensity);
    if (gap < 0 || gap > expected + 5000) continue;   // crosses a round boundary
    assert.ok(
      Math.abs(gap - expected) <= 30,
      `gap after ${combos[i].combo.id} was ${Math.round(gap)}ms, expected ${expected}ms`
    );
    checked++;
  }
  assert.ok(checked > 5, 'not enough in-round gaps to be meaningful');
});

test('the round-end lookahead never lets the bell cut a combo in half', () => {
  const roundMs = 60 * 1000;
  for (const intensity of ['light', 'medium', 'hard']) {
    for (const seed of [1, 7, 99, 1234]) {
      const { log, rate } = runWorkout({ settings: { intensity }, seed, stepMs: 25 });

      // Rebuild each round's window from the state transitions.
      const marks = only(log, 'state');
      const roundStarts = marks.filter((m) => m.to === STATES.ROUND).map((m) => m.t);

      for (const e of only(log, 'say').filter((x) => x.tag === 'combo')) {
        const start = [...roundStarts].reverse().find((s) => s <= e.t);
        const roundEnd = start + roundMs;
        const speechEnd = e.t + estimateSpeechMs(e.text, rate, config.speechEstimate);
        assert.ok(
          speechEnd <= roundEnd,
          `${intensity}/seed ${seed}: a callout would still be speaking ` +
          `${Math.round(speechEnd - roundEnd)}ms after the bell`
        );
      }
    }
  }
});

test('harder intensity fits more combos into the same round', () => {
  const count = (intensity) =>
    only(runWorkout({ settings: { intensity, roundsPerWorkout: 1 }, seed: 3 }).log, 'combo').length;
  const light = count('light');
  const medium = count('medium');
  const hard = count('hard');
  assert.ok(hard > medium && medium > light,
    `expected hard > medium > light, got ${hard}/${medium}/${light}`);
});

test('pause suspends the round clock and resumes where it left off', () => {
  const s = { ...BASE };
  const session = createSession({ config, settings: s, combos: COMBOS, rng: createRng(1) });
  session.start(0);
  session.ready(0);
  session.tick(6000);                       // into round 1
  assert.equal(session.snapshot(6000).state, STATES.ROUND);

  const before = session.snapshot(10000).remainingMs;
  session.pause(10000);
  assert.equal(session.snapshot(10000).paused, true);

  // Thirty seconds pass while paused. Nothing should happen and the clock
  // should not move.
  assert.deepEqual(session.tick(40000), []);
  assert.equal(session.snapshot(40000).remainingMs, before);

  session.resume(40000);
  assert.equal(session.snapshot(40000).paused, false);
  assert.equal(session.snapshot(40000).remainingMs, before);
});

test('pausing cancels any in-flight callout', () => {
  const session = createSession({ config, settings: BASE, combos: COMBOS, rng: createRng(1) });
  session.start(0);
  session.ready(0);
  session.tick(6000);
  session.tick(8000);
  const events = session.pause(9000);
  assert.ok(events.some((e) => e.type === 'cancelSpeech'));
});

test('resuming gives a whole fresh gap rather than dropping mid-callout', () => {
  const session = createSession({ config, settings: BASE, combos: COMBOS, rng: createRng(1) });
  session.start(0);
  session.ready(0);
  session.tick(6000);

  // Get a callout under way, then pause part-way through it.
  const called = session.tick(8000).find((e) => e.type === 'combo');
  assert.ok(called, 'expected a callout by now');
  const gap = gapMsFor(called.combo, config.intensity.medium);

  session.pause(8500);
  session.resume(20000);

  // Spec 6.3: the in-flight utterance is cancelled and the *current* gap —
  // the one belonging to the combo just called — restarts from the top.
  assert.deepEqual(
    session.tick(20000 + gap - 100).filter((e) => e.type === 'say'), [],
    'nothing should be said before the full gap has elapsed'
  );
  assert.ok(
    session.tick(20000 + gap + 100).some((e) => e.type === 'say'),
    'should speak once the full gap has passed'
  );
});

test('abort reports an incomplete session with the rounds finished so far', () => {
  const session = createSession({ config, settings: BASE, combos: COMBOS, rng: createRng(1) });
  session.start(0);
  session.ready(0);
  session.tick(6000);
  const events = session.abort(30000);
  const fin = events.find((e) => e.type === 'finished');
  assert.ok(fin);
  assert.equal(fin.summary.completed, false);
  assert.equal(fin.summary.rounds, 0, 'no round had finished yet');
  assert.equal(fin.summary.roundsPlanned, BASE.roundsPerWorkout, 'planned rounds survive an abort');
  assert.equal(session.snapshot(30000).state, STATES.IDLE);
});

test('a completed workout reports the right shape of summary', () => {
  const { log, settings } = runWorkout();
  const fin = only(log, 'finished')[0];
  assert.ok(fin);
  assert.equal(fin.summary.completed, true);
  assert.equal(fin.summary.rounds, 2);
  assert.equal(fin.summary.sport, settings.sport);
  assert.equal(fin.summary.tier, settings.tier);
  assert.equal(fin.summary.intensity, settings.intensity);
  assert.equal(fin.summary.roundLengthSec, 60);
  assert.equal(fin.summary.restSec, 10);
  assert.ok(fin.summary.combosCalled > 0);
  assert.ok(fin.summary.durationSec > 100);
});

test('ticking an idle or finished session does nothing', () => {
  const session = createSession({ config, settings: BASE, combos: COMBOS, rng: createRng(1) });
  assert.deepEqual(session.tick(1000), []);
  assert.deepEqual(session.speechEnded(1000), []);
  assert.deepEqual(session.pause(1000), []);
  assert.deepEqual(session.abort(1000), []);
});

test('a beginner session only ever calls beginner combos', () => {
  const { log } = runWorkout({ settings: { tier: 'beginner', sport: 'boxing' } });
  const called = only(log, 'combo').map((e) => e.combo);
  assert.ok(called.length > 0);
  assert.ok(called.every((c) => c.tier === 'beginner' && c.sport === 'boxing'));
});
