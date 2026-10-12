import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from './fixtures.js';

import { createSession, STATES } from '../src/engine/session.js';
import { createRng } from '../src/engine/selector.js';
import { buildPlan, timedSegment } from '../src/engine/plan.js';
import { estimateSpeechMs, voiceRate, applyPronunciation } from '../src/engine/timing.js';

const config = loadConfig();
const COMBOS = JSON.parse(readFileSync(new URL('../data/combos.json', import.meta.url))).combos;
const ROUTINES = config.warmups.routines;

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

const STEP_MS = 50;
const only = (log, type) => log.filter((e) => e.type === type);
const statesOf = (log) => only(log, 'state').map((e) => e.to);
const cuesOf = (log) => only(log, 'say').filter((e) => e.tag === 'cue');

/**
 * Fake-clock driver, same pattern as session.test.js. Speech is simulated at
 * the engine's own estimate. `snaps` holds a snapshot after every tick.
 */
function run(settings = {}, { seed = 1, cfg = config, maxMs = 60 * 60 * 1000, withSettings = true } = {}) {
  const s = withSettings ? { ...BASE, ...settings } : { ...BASE };
  if (!withSettings) for (const [k, v] of Object.entries(settings)) s[k] = v;
  const rate = voiceRate(s.voiceSpeedPct, cfg.voiceRateRange);
  const session = createSession({ config: cfg, settings: s, combos: COMBOS, rng: createRng(seed) });
  const log = [];
  const snaps = [];
  let t = 0;
  let speechEndsAt = null;
  let summary = null;

  const push = (events) => {
    for (const e of events) {
      log.push({ t, ...e });
      if (e.type === 'say') speechEndsAt = t + estimateSpeechMs(e.text, rate, cfg.speechEstimate);
      else if (e.type === 'cancelSpeech') speechEndsAt = null;
      else if (e.type === 'finished') summary = e.summary;
    }
  };

  push(session.start(t));
  push(session.ready(t));
  while (t < maxMs && !summary) {
    t += STEP_MS;
    if (speechEndsAt !== null && t >= speechEndsAt) {
      speechEndsAt = null;
      push(session.speechEnded(t));
    }
    push(session.tick(t));
    snaps.push({ t, snap: session.snapshot(t) });
  }
  return { log, snaps, summary, rate, settings: s, session, t };
}

/** When the session entered `state`, from a log. */
const enteredAt = (log, state) => only(log, 'state').find((e) => e.to === state)?.t;

/* ---- 1. golden: no warm-up is the old plan -------------------------- */

test('buildPlan with no warm-up is exactly bag, rest, bag, ... bag', () => {
  for (const n of [1, 3, 5]) {
    const settings = { ...BASE, roundsPerWorkout: n, roundLengthMin: 2, restBetweenRoundsSec: 30 };
    const plan = buildPlan(settings, { warmup: null, rate: 1, config });
    const expected = [];
    for (let i = 1; i <= n; i++) {
      expected.push({ type: 'bag', round: i, durationMs: 120000 });
      if (i < n) expected.push({ type: 'rest', durationMs: 30000 });
    }
    assert.deepEqual(plan, expected, `${n} rounds`);
    assert.equal(plan.length, 2 * n - 1);
    assert.equal(plan.at(-1).type, 'bag', 'no trailing rest');
  }
});

test('buildPlan treats an empty or missing warm-up as no warm-up', () => {
  const settings = { ...BASE, roundsPerWorkout: 2 };
  const plain = buildPlan(settings, { warmup: null, rate: 1, config });
  assert.deepEqual(buildPlan(settings, { warmup: [], rate: 1, config }), plain);
  assert.deepEqual(buildPlan(settings, { rate: 1, config }), plain);
});

test('buildPlan with a warm-up prepends a timed segment and a glove-up rest', () => {
  const settings = { ...BASE, roundsPerWorkout: 3 };
  const plan = buildPlan(settings, { warmup: ROUTINES['5'], rate: 1, config });
  assert.deepEqual(plan.map((s) => s.type), ['timed', 'rest', 'bag', 'rest', 'bag', 'rest', 'bag']);
  assert.equal(plan[0].kind, 'warmup');
  assert.equal(plan[0].durationMs, 300000);
  assert.equal(plan[0].cues[0].text, 'Warm-up, 5 minutes');
  assert.equal(plan[1].durationMs, config.warmup.transitionSec * 1000);
  assert.equal(plan[1].enterSay, config.warmup.doneCallout);
  assert.equal(plan[3].enterSay, undefined, 'ordinary rests announce nothing on entry');
});

for (const mode of ['random', 'defense']) {
  test(`a warmupMin-0 session is event-for-event identical to one without the setting (${mode})`, () => {
    for (const seed of [1, 7]) {
      const withZero = run({ workoutMode: mode, warmupMin: 0 }, { seed });
      const without = run({ workoutMode: mode }, { seed });
      assert.deepEqual(withZero.log, without.log, `seed ${seed}`);
      assert.deepEqual(withZero.snaps, without.snaps, `seed ${seed}`);
    }
  });
}

test('a warmupMin-0 session keeps the classic shape: states, bells, combos, summary', () => {
  for (const n of [1, 3, 5]) {
    const { log, summary } = run({ warmupMin: 0, roundsPerWorkout: n });
    const expected = [STATES.PREPARING, STATES.COUNTDOWN];
    for (let i = 1; i <= n; i++) {
      expected.push(STATES.ROUND);
      if (i < n) expected.push(STATES.REST);
    }
    expected.push(STATES.COMPLETE);
    assert.deepEqual(statesOf(log), expected, `${n} rounds`);
    assert.equal(only(log, 'bell').length, 2 * n);
    assert.equal(cuesOf(log).length, 0);
    assert.equal(only(log, 'step').length, 0);
    const callouts = only(log, 'say').filter((e) => e.tag === 'combo');
    assert.equal(callouts.length, only(log, 'combo').length);
    assert.ok(callouts.length > 5 * n);
    assert.equal(summary.rounds, n);
    assert.equal(summary.warmupMin, 0);
    assert.equal(summary.completed, true);
  }
});

test('round durations in a warmupMin-0 session match the plan', () => {
  const { log } = run({ warmupMin: 0, roundsPerWorkout: 3, roundLengthMin: 2, restBetweenRoundsSec: 15 });
  const st = only(log, 'state');
  const at = (to, nth = 0) => st.filter((e) => e.to === to)[nth].t;
  assert.equal(at(STATES.REST, 0) - at(STATES.ROUND, 0), 120000);
  assert.equal(at(STATES.ROUND, 1) - at(STATES.REST, 0), 15000);
  assert.equal(at(STATES.COMPLETE) - at(STATES.ROUND, 2), 120000);
});

/* ---- 2. timedSegment ------------------------------------------------- */

const RATE = 1;
const estOf = (text, rate = RATE) =>
  estimateSpeechMs(applyPronunciation(text, config.pronunciation), rate, config.speechEstimate);

const SAMPLE_STEPS = [
  { name: 'Skip or bounce', sec: 35, cue: 'Light on your toes' },
  { name: 'Leg swings', sec: 30, cue: 'Tall posture, swing loosely', sides: true },
  { name: 'Hip circles', sec: 20 },
  { name: 'Stretch', sec: 40, sides: true },
];

test('timedSegment lays steps end to end and totals their seconds', () => {
  const seg = timedSegment(SAMPLE_STEPS, { intro: 'Warm-up, 2 minutes', rate: RATE, config });
  assert.equal(seg.type, 'timed');
  assert.equal(seg.steps.length, SAMPLE_STEPS.length);
  assert.equal(seg.steps[0].startMs, 0);
  seg.steps.forEach((s, i) => {
    assert.equal(s.endMs - s.startMs, SAMPLE_STEPS[i].sec * 1000);
    assert.equal(s.name, SAMPLE_STEPS[i].name, 'step fields are carried through');
    if (i > 0) assert.equal(s.startMs, seg.steps[i - 1].endMs, 'contiguous');
  });
  assert.equal(seg.durationMs, SAMPLE_STEPS.reduce((a, s) => a + s.sec * 1000, 0));
  assert.equal(seg.steps.at(-1).endMs, seg.durationMs);
});

test('timedSegment does not mutate the steps it is given', () => {
  const steps = SAMPLE_STEPS.map((s) => ({ ...s }));
  timedSegment(steps, { intro: 'x', rate: RATE, config });
  assert.deepEqual(steps, SAMPLE_STEPS);
});

test('timedSegment cues: intro first, in order, spaced by the estimated speech plus 300 ms', () => {
  for (const rate of [0.6, 1, 1.6]) {
    const seg = timedSegment(SAMPLE_STEPS, { intro: 'Warm-up, 2 minutes', rate, config });
    const { cues } = seg;
    assert.equal(cues[0].text, 'Warm-up, 2 minutes');
    assert.equal(cues[0].atMs, 0);
    assert.equal(cues[0].step, 0);
    for (let i = 1; i < cues.length; i++) {
      assert.ok(cues[i].atMs >= cues[i - 1].atMs, `non-decreasing at ${i}`);
      const prevEnd = cues[i - 1].atMs + estOf(cues[i - 1].text, rate);
      assert.ok(cues[i].atMs >= prevEnd + 300 - 1e-6,
        `cue ${i} "${cues[i].text}" at ${cues[i].atMs} starts before previous end ${prevEnd} + 300 (rate ${rate})`);
    }
  }
});

test('timedSegment: every step name is spoken at or after the step starts, and cues follow their name', () => {
  const seg = timedSegment(SAMPLE_STEPS, { intro: 'Intro', rate: RATE, config });
  seg.steps.forEach((s, i) => {
    const mine = seg.cues.filter((c) => c.step === i);
    const nameCue = mine.find((c) => c.text === s.name);
    assert.ok(nameCue, `name cue for ${s.name}`);
    assert.ok(nameCue.atMs >= s.startMs);
    if (s.cue) {
      const coach = mine.find((c) => c.text === s.cue);
      assert.ok(coach, `coaching cue for ${s.name}`);
      assert.ok(coach.atMs > nameCue.atMs, 'coaching cue comes after the name');
    } else {
      assert.ok(!mine.some((c) => c.text !== s.name && c.text !== 'Switch sides'));
    }
  });
});

test('timedSegment: "Switch sides" only for sided steps, at or after the midpoint, once each', () => {
  const seg = timedSegment(SAMPLE_STEPS, { intro: 'Intro', rate: RATE, config });
  const switches = seg.cues.filter((c) => c.text === 'Switch sides');
  assert.deepEqual(switches.map((c) => c.step), [1, 3]);
  for (const c of switches) {
    const s = seg.steps[c.step];
    assert.ok(s.sides);
    assert.ok(c.atMs >= s.startMs + (s.endMs - s.startMs) / 2, 'at or after the midpoint');
  }
  // With room to spare it lands exactly on the midpoint.
  const roomy = timedSegment([{ name: 'Swing', sec: 60, sides: true }], { rate: RATE, config });
  assert.equal(roomy.cues.find((c) => c.text === 'Switch sides').atMs, 30000);
});

test('timedSegment without an intro starts on the first step name', () => {
  const seg = timedSegment(SAMPLE_STEPS, { rate: RATE, config });
  assert.equal(seg.cues[0].text, SAMPLE_STEPS[0].name);
  assert.equal(seg.cues[0].atMs, 0);
});

test('timedSegment applies pronunciation when estimating speech time', () => {
  // "up-elbow" is spoken as "up elbow": one char longer, so a longer estimate.
  const steps = [{ name: 'up-elbow', sec: 30 }, { name: 'Next', sec: 30 }];
  const seg = timedSegment(steps, { rate: RATE, config });
  const spoken = estimateSpeechMs('up elbow', RATE, config.speechEstimate);
  assert.ok(Math.abs(seg.cues[1].atMs - 30000) < 1e-6, 'plenty of room: second name at its own start');
  const tight = timedSegment([{ name: 'up-elbow', sec: 1 }, { name: 'Next', sec: 30 }], { rate: RATE, config });
  assert.ok(Math.abs(tight.cues[1].atMs - (spoken + 300)) < 1e-6);
});

test('timedSegment pushes a cue back when the previous one has not finished', () => {
  const seg = timedSegment([{ name: 'One', sec: 1 }, { name: 'Two', sec: 1 }, { name: 'Three', sec: 1 }], {
    rate: 0.6, config,
  });
  assert.ok(seg.cues[1].atMs > 1000, 'second name delayed past its own start');
  assert.ok(seg.cues[2].atMs > 2000);
});

/* ---- 3. warm-up data lint -------------------------------------------- */

const PHASES = ['raise', 'mobilise', 'potentiate'];

test('warmups.json has 5, 8 and 12 minute routines that sum exactly', () => {
  assert.deepEqual(Object.keys(ROUTINES).sort((a, b) => a - b), ['5', '8', '12']);
  for (const [min, steps] of Object.entries(ROUTINES)) {
    assert.equal(steps.reduce((a, s) => a + s.sec, 0), Number(min) * 60, `${min}-minute routine`);
  }
});

test('warmups.json steps are well formed', () => {
  for (const [min, steps] of Object.entries(ROUTINES)) {
    for (const s of steps) {
      const label = `${min}: ${s.name}`;
      assert.equal(typeof s.name, 'string', label);
      assert.ok(s.name.length > 0, label);
      assert.ok(Number.isInteger(s.sec) && s.sec % 5 === 0, `${label} sec is a multiple of 5`);
      assert.ok(s.sec >= (s.sides ? 30 : 20), `${label} is long enough`);
      assert.ok(PHASES.includes(s.phase), `${label} has a known phase`);
      if (s.cue !== undefined) assert.ok(s.cue.split(/\s+/).length <= 6, `${label} cue is short`);
      if (s.sides !== undefined) assert.equal(typeof s.sides, 'boolean', label);
    }
  }
});

test('warmups.json phases go raise, mobilise, potentiate and never back', () => {
  for (const [min, steps] of Object.entries(ROUTINES)) {
    const idx = steps.map((s) => PHASES.indexOf(s.phase));
    for (let i = 1; i < idx.length; i++) {
      assert.ok(idx[i] >= idx[i - 1], `${min}: "${steps[i].name}" (${steps[i].phase}) follows "${steps[i - 1].name}" (${steps[i - 1].phase})`);
    }
    for (const p of PHASES) assert.ok(idx.includes(PHASES.indexOf(p)), `${min} has a ${p} phase`);
    assert.equal(steps[0].phase, 'raise');
    assert.equal(steps.at(-1).phase, 'potentiate');
  }
});

for (const speedPct of [0, 75]) {
  test(`warm-up cues keep up with the steps at voice speed ${speedPct}`, () => {
    const rate = voiceRate(speedPct, config.voiceRateRange);
    for (const min of Object.keys(ROUTINES)) {
      const settings = { ...BASE, warmupMin: Number(min) };
      const seg = buildPlan(settings, { warmup: ROUTINES[min], rate, config })[0];
      seg.steps.forEach((s, i) => {
        const nameCue = seg.cues.find((c) => c.step === i && c.text === s.name);
        assert.ok(nameCue, `${min}: no name cue for "${s.name}"`);
        const half = s.startMs + (s.endMs - s.startMs) / 2;
        assert.ok(nameCue.atMs < half,
          `${min}: "${s.name}" is announced at ${nameCue.atMs} ms, but the step is half over at ${half} ms (spacing has drifted)`);
      });
      for (const c of seg.cues) {
        assert.ok(c.atMs < seg.durationMs, `${min}: cue "${c.text}" at ${c.atMs} is after the segment ends (${seg.durationMs})`);
      }
      // cues are in order
      for (let i = 1; i < seg.cues.length; i++) assert.ok(seg.cues[i].atMs >= seg.cues[i - 1].atMs);
    }
  });
}

/* ---- 4. session with a 5-minute warm-up ------------------------------ */

const WARM = { warmupMin: 5 };

test('a 5-minute warm-up walks COUNTDOWN -> TIMED -> REST -> ROUND -> REST -> ROUND', () => {
  const { log } = run(WARM);
  assert.deepEqual(statesOf(log), [
    STATES.PREPARING, STATES.COUNTDOWN, STATES.TIMED, STATES.REST,
    STATES.ROUND, STATES.REST, STATES.ROUND, STATES.COMPLETE,
  ]);
});

test('durations: countdown, then 300 s of warm-up, then the glove-up rest, then round 1', () => {
  const { log } = run(WARM);
  const tTimed = enteredAt(log, STATES.TIMED);
  const tRest = enteredAt(log, STATES.REST);
  const tRound = enteredAt(log, STATES.ROUND);
  assert.equal(tTimed, BASE.countdownSec * 1000);
  assert.equal(tRest - tTimed, 300000);
  assert.equal(tRound - tRest, config.warmup.transitionSec * 1000);
});

test('no bell and no combo during the warm-up; the first bell is the start of round 1', () => {
  const { log } = run(WARM);
  const tTimed = enteredAt(log, STATES.TIMED);
  const tRound = enteredAt(log, STATES.ROUND);
  const quiet = log.filter((e) => e.t >= tTimed && e.t < tRound);
  assert.ok(quiet.length > 0);
  assert.equal(quiet.filter((e) => e.type === 'bell').length, 0);
  assert.equal(quiet.filter((e) => e.type === 'combo').length, 0);
  assert.equal(quiet.filter((e) => e.type === 'say' && e.tag === 'combo').length, 0);
  const firstBell = only(log, 'bell')[0];
  assert.equal(firstBell.t, tRound);
  const idxRound = log.findIndex((e) => e.type === 'state' && e.to === STATES.ROUND);
  assert.equal(log[idxRound + 1].type, 'bell', 'bell follows the ROUND transition');
  assert.equal(only(log, 'bell').length, 4, 'two bag rounds, two bells each; the warm-up adds none');
});

test('the done callout is said on entering the post-warm-up rest, then 10 seconds and 3-2-1', () => {
  const { log } = run(WARM);
  const tRest = enteredAt(log, STATES.REST);
  const tRound = enteredAt(log, STATES.ROUND);
  const restSays = only(log, 'say').filter((e) => e.tag === 'rest' && e.t >= tRest && e.t <= tRound);
  assert.deepEqual(restSays.map((e) => e.text), [config.warmup.doneCallout, '10 seconds', '3', '2', '1']);
  assert.equal(restSays[0].t, tRest);
  // and the ordinary rest between rounds 1 and 2 does not repeat it
  const all = only(log, 'say').filter((e) => e.text === config.warmup.doneCallout);
  assert.equal(all.length, 1);
});

test('warm-up cues are said in plan order at their scheduled times', () => {
  const { log, rate } = run(WARM);
  const tTimed = enteredAt(log, STATES.TIMED);
  const plan = buildPlan({ ...BASE, ...WARM }, { warmup: ROUTINES['5'], rate, config });
  const expected = plan[0].cues;
  const said = cuesOf(log);
  assert.deepEqual(
    said.map((e) => e.text),
    expected.map((c) => applyPronunciation(c.text, config.pronunciation)),
  );
  said.forEach((e, i) => {
    const due = tTimed + expected[i].atMs;
    assert.ok(e.t >= due && e.t < due + 2 * STEP_MS, `cue ${i} "${e.text}" said at ${e.t - tTimed}, due ${expected[i].atMs}`);
  });
  assert.ok(said.every((e) => e.t >= tTimed && e.t < tTimed + 300000), 'cues only during TIMED');
  assert.equal(said[0].text, 'Warm-up, 5 minutes');
});

test('step events fire once per step, in order, with the right next step', () => {
  const { log } = run(WARM);
  const steps = ROUTINES['5'];
  const tTimed = enteredAt(log, STATES.TIMED);
  const evs = only(log, 'step');
  assert.equal(evs.length, steps.length);
  let start = 0;
  evs.forEach((e, i) => {
    assert.equal(e.index, i);
    assert.equal(e.of, steps.length);
    assert.equal(e.step.name, steps[i].name);
    assert.equal(e.next?.name ?? null, steps[i + 1]?.name ?? null);
    assert.equal(e.next === null, i === steps.length - 1, 'last step has no next');
    assert.ok(e.t - tTimed >= start && e.t - tTimed < start + 2 * STEP_MS, `step ${i} fired at ${e.t - tTimed}, due ${start}`);
    start += steps[i].sec * 1000;
  });
});

test('snapshots during TIMED: kind, step, next step, countdown from 300 s', () => {
  const { snaps, log } = run(WARM);
  const tTimed = enteredAt(log, STATES.TIMED);
  const tRest = enteredAt(log, STATES.REST);
  const timed = snaps.filter((x) => x.snap.state === STATES.TIMED);
  assert.ok(timed.length > 100);
  assert.equal(timed[0].snap.remainingMs, 300000, 'starts at the full 300 s');
  assert.equal(timed[0].snap.totalMs, 300000);
  assert.equal(timed.at(-1).snap.remainingMs, 50, 'last TIMED tick is one tick from the end');
  for (const { t, snap } of timed) {
    assert.equal(snap.segment, 'timed');
    assert.equal(snap.segmentKind, 'warmup');
    assert.equal(snap.remainingMs, 300000 - (t - tTimed));
    assert.equal(snap.roundIndex, 0);
    assert.equal(snap.paused, false);
    assert.equal(snap.combo, null);
    assert.equal(snap.intensity, null);
  }
  // After the first tick inside TIMED, a step is always on screen.
  const steps = ROUTINES['5'];
  for (const { t, snap } of timed.slice(1)) {
    assert.ok(snap.step, `step at ${t}`);
    const i = steps.findIndex((s) => s.name === snap.step.name);
    assert.ok(i >= 0);
    assert.equal(snap.nextStep?.name ?? null, steps[i + 1]?.name ?? null);
    const into = t - tTimed;
    const start = steps.slice(0, i).reduce((a, s) => a + s.sec * 1000, 0);
    assert.ok(into >= start && into < start + steps[i].sec * 1000 + STEP_MS, `${snap.step.name} on screen at ${into}`);
  }
  // Steps only ever advance.
  const idx = timed.slice(1).map((x) => steps.findIndex((s) => s.name === x.snap.step.name));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] >= idx[i - 1]);
  // Snapshot outside TIMED carries no step.
  const after = snaps.filter((x) => x.t >= tRest);
  assert.ok(after.every((x) => x.snap.step === null && x.snap.nextStep === null));
  assert.ok(after.every((x) => x.snap.segmentKind !== 'warmup'));
});

test('roundIndex is 0 through TIMED and the post-warm-up rest, then counts bag rounds', () => {
  const { snaps, log } = run(WARM);
  const tRound = enteredAt(log, STATES.ROUND);
  for (const { t, snap } of snaps) {
    if (t < tRound) assert.equal(snap.roundIndex, 0, `at ${t} (${snap.state})`);
  }
  const rounds = snaps.filter((x) => x.snap.state === STATES.ROUND).map((x) => x.snap.roundIndex);
  assert.deepEqual([...new Set(rounds)], [1, 2]);
  const restSnap = snaps.find((x) => x.snap.state === STATES.REST);
  assert.equal(restSnap.snap.segment, 'rest');
  assert.equal(restSnap.snap.totalMs, config.warmup.transitionSec * 1000);
});

test('every warm-up length runs: 5, 8 and 12 minutes', () => {
  for (const min of [5, 8, 12]) {
    const { log, summary } = run({ warmupMin: min, roundsPerWorkout: 1 });
    const dur = enteredAt(log, STATES.REST) - enteredAt(log, STATES.TIMED);
    assert.equal(dur, min * 60000);
    assert.equal(only(log, 'step').length, ROUTINES[String(min)].length);
    assert.equal(summary.warmupMin, min);
  }
});

/* ---- 5. bag rounds only ---------------------------------------------- */

test('with a warm-up, ramp up still starts on round 1 and ends on the last round', () => {
  const { snaps, summary } = run({ warmupMin: 5, rampUp: true, intensity: 'hard', roundsPerWorkout: 3 });
  const peak = config.intensity.hard.baseGapMs;
  const extra = config.ramp.startExtraGapMs;
  const gapByRound = new Map();
  for (const { snap } of snaps) {
    if (snap.state === STATES.ROUND && !gapByRound.has(snap.roundIndex)) gapByRound.set(snap.roundIndex, snap.intensity.baseGapMs);
  }
  assert.deepEqual([...gapByRound.entries()], [[1, peak + extra], [2, peak + extra / 2], [3, peak]]);
  assert.equal(summary.rampUp, true);
  assert.equal(summary.rounds, 3);
});

test('ramp up with a warm-up gives the same round gaps as without one', () => {
  const gaps = (settings) => {
    const { snaps } = run({ rampUp: true, intensity: 'medium', roundsPerWorkout: 4, ...settings });
    const m = new Map();
    for (const { snap } of snaps) if (snap.state === STATES.ROUND && !m.has(snap.roundIndex)) m.set(snap.roundIndex, snap.intensity.baseGapMs);
    return [...m.values()];
  };
  assert.deepEqual(gaps({ warmupMin: 5 }), gaps({ warmupMin: 0 }));
});

test('the finisher is announced in every bag round and never during the warm-up', () => {
  const { log, summary } = run({ warmupMin: 5, finisherSec: 15, roundsPerWorkout: 3, intensity: 'hard' });
  const fins = only(log, 'finisher');
  assert.equal(fins.length, 3);
  const rounds = only(log, 'state').filter((e) => e.to === STATES.ROUND).map((e) => e.t);
  const ends = only(log, 'bell').filter((_, i) => i % 2 === 1).map((e) => e.t);
  fins.forEach((f, i) => {
    assert.ok(f.t > rounds[i] && f.t < ends[i], `finisher ${i} lies inside bag round ${i + 1}`);
  });
  const tTimed = enteredAt(log, STATES.TIMED);
  const tRound = enteredAt(log, STATES.ROUND);
  assert.ok(fins.every((f) => f.t >= tRound));
  assert.ok(!log.some((e) => e.t >= tTimed && e.t < tRound && (e.type === 'finisher' || (e.type === 'say' && e.text === config.finisher.callout))));
  assert.equal(summary.finisherSec, 15);
});

test('summary counts bag rounds only, and records the warm-up length', () => {
  for (const n of [1, 3]) {
    const { summary } = run({ warmupMin: 5, roundsPerWorkout: n });
    assert.equal(summary.rounds, n);
    assert.equal(summary.roundsPlanned, n);
    assert.equal(summary.warmupMin, 5);
    assert.equal(summary.completed, true);
    assert.ok(summary.durationSec >= 300 + n * 60);
  }
});

test('the post-warm-up rest is not mistaken for a round rest: 3 rounds give 3 + 1 rests, 3 bag rounds', () => {
  const { log } = run({ warmupMin: 5, roundsPerWorkout: 3 });
  const seq = statesOf(log);
  assert.equal(seq.filter((s) => s === STATES.ROUND).length, 3);
  assert.equal(seq.filter((s) => s === STATES.REST).length, 3);
  assert.equal(seq.filter((s) => s === STATES.TIMED).length, 1);
});

/* ---- 6. pause / abort in the warm-up --------------------------------- */

/** Start a session with a warm-up and tick it up to (just past) `toMs`, with a hook. */
function warmupDriver(settings = {}, { seed = 1 } = {}) {
  const s = { ...BASE, warmupMin: 5, ...settings };
  const session = createSession({ config, settings: s, combos: COMBOS, rng: createRng(seed) });
  const log = [];
  const api = {
    session,
    t: 0,
    log,
    push(events) { for (const e of events) log.push({ t: api.t, ...e }); return events; },
    tickTo(ms) {
      const out = [];
      while (api.t < ms) { api.t += STEP_MS; out.push(...api.push(session.tick(api.t))); }
      return out;
    },
  };
  api.push(session.start(0));
  api.push(session.ready(0));
  return api;
}

const WARM_START = BASE.countdownSec * 1000;

test('pausing during the warm-up freezes the clock and says nothing', () => {
  const d = warmupDriver();
  d.tickTo(WARM_START + 62000);
  const before = d.session.snapshot(d.t);
  assert.equal(before.state, STATES.TIMED);
  d.push(d.session.pause(d.t));
  const frozen = d.session.snapshot(d.t);
  assert.equal(frozen.paused, true);
  assert.equal(frozen.remainingMs, before.remainingMs);
  const stepBefore = frozen.step.name;
  // two minutes of ticking while paused, crossing several cue and step times
  const emitted = d.tickTo(d.t + 120000);
  assert.deepEqual(emitted, []);
  const still = d.session.snapshot(d.t);
  assert.equal(still.remainingMs, before.remainingMs);
  assert.equal(still.step.name, stepBefore);
  assert.equal(still.paused, true);
});

test('pause cancels speech; resume continues the warm-up with no burst of old cues', () => {
  const control = warmupDriver();
  control.tickTo(WARM_START + 300000 + 100);
  const controlCues = cuesOf(control.log).map((e) => e.text);

  const d = warmupDriver();
  d.tickTo(WARM_START + 62000);
  const pauseEvents = d.push(d.session.pause(d.t));
  assert.deepEqual(pauseEvents.map((e) => e.type), ['cancelSpeech']);
  d.tickTo(d.t + 90000);
  const remainingAtPause = d.session.snapshot(d.t).remainingMs;
  d.push(d.session.resume(d.t));
  assert.equal(d.session.snapshot(d.t).remainingMs, remainingAtPause);

  // the very first resume tick says at most one cue
  d.t += STEP_MS;
  const first = d.push(d.session.tick(d.t));
  assert.ok(first.filter((e) => e.type === 'say').length <= 1);

  d.tickTo(d.t + 400000);
  const cues = cuesOf(d.log).map((e) => e.text);
  assert.deepEqual(cues, controlCues, 'the same cues, once each, in the same order, as an unpaused run');

  // each tick said at most one cue
  const perTick = new Map();
  for (const e of cuesOf(d.log)) perTick.set(e.t, (perTick.get(e.t) ?? 0) + 1);
  assert.ok([...perTick.values()].every((n) => n === 1));
});

test('the warm-up still lasts 300 s of running time after a pause', () => {
  const d = warmupDriver();
  d.tickTo(WARM_START + 100000);
  d.push(d.session.pause(d.t));
  d.tickTo(d.t + 45000);
  const resumedAt = d.t;
  d.push(d.session.resume(d.t));
  d.tickTo(d.t + 400000);
  const tRest = d.log.find((e) => e.type === 'state' && e.to === STATES.REST).t;
  assert.equal(tRest - WARM_START, 300000 + (resumedAt - (WARM_START + 100000)));
});

test('a long gap between ticks says only the latest due cue, not the backlog', () => {
  const d = warmupDriver();
  d.tickTo(WARM_START + 10000);
  const before = cuesOf(d.log).length;
  // the tab was backgrounded: the next tick arrives 100 s later
  d.t += 100000;
  const out = d.push(d.session.tick(d.t));
  const cues = out.filter((e) => e.type === 'say');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].tag, 'cue');
  assert.equal(cuesOf(d.log).length, before + 1);
  assert.equal(out.filter((e) => e.type === 'step').length, 1, 'one step event, for the step now on screen');
  // and the cue said belongs to the step on screen, not an old one
  const snap = d.session.snapshot(d.t);
  const seg = buildPlan({ ...BASE, warmupMin: 5 }, { warmup: ROUTINES['5'], rate: voiceRate(BASE.voiceSpeedPct, config.voiceRateRange), config })[0];
  const planCue = seg.cues.filter((c) => c.atMs <= d.t - WARM_START).at(-1);
  assert.equal(cues[0].text, applyPronunciation(planCue.text, config.pronunciation));
  assert.equal(snap.step.name, ROUTINES['5'][planCue.step].name, 'the cue said is for the step on screen');
});

test('aborting during the warm-up finishes with rounds 0 and completed false', () => {
  const d = warmupDriver({ roundsPerWorkout: 3 });
  d.tickTo(WARM_START + 75000);
  assert.equal(d.session.snapshot(d.t).state, STATES.TIMED);
  const events = d.push(d.session.abort(d.t));
  const fin = events.find((e) => e.type === 'finished');
  assert.ok(fin);
  assert.equal(fin.summary.rounds, 0);
  assert.equal(fin.summary.completed, false);
  assert.equal(fin.summary.warmupMin, 5);
  assert.equal(fin.summary.roundsPlanned, 3);
  assert.equal(fin.summary.combosCalled, 0);
  assert.equal(fin.summary.durationSec, Math.round((d.t - 0) / 1000));
  assert.equal(events[0].type, 'cancelSpeech');
  assert.equal(d.session.snapshot(d.t).state, STATES.IDLE);
  // nothing more happens afterwards
  assert.deepEqual(d.tickTo(d.t + 5000), []);
});

test('aborting while paused in the warm-up also finishes cleanly', () => {
  const d = warmupDriver();
  d.tickTo(WARM_START + 40000);
  d.push(d.session.pause(d.t));
  const events = d.push(d.session.abort(d.t));
  const fin = events.find((e) => e.type === 'finished');
  assert.equal(fin.summary.rounds, 0);
  assert.equal(fin.summary.completed, false);
});

test('aborting in the post-warm-up rest keeps rounds 0', () => {
  const d = warmupDriver();
  d.tickTo(WARM_START + 300000 + 5000);
  assert.equal(d.session.snapshot(d.t).state, STATES.REST);
  const fin = d.push(d.session.abort(d.t)).find((e) => e.type === 'finished');
  assert.equal(fin.summary.rounds, 0);
  assert.equal(fin.summary.completed, false);
});

/* ---- 7. a missing routine -------------------------------------------- */

test('warmupMin set but no routines in config runs as a plain workout', () => {
  const noWarmups = { ...config, warmups: undefined };
  const missing = run({ warmupMin: 5 }, { cfg: noWarmups });
  const plain = run({}, { cfg: noWarmups });
  assert.equal(missing.summary.warmupMin, 0);
  assert.ok(!statesOf(missing.log).includes(STATES.TIMED));
  assert.deepEqual(statesOf(missing.log), statesOf(plain.log));
  assert.equal(only(missing.log, 'bell').length, only(plain.log, 'bell').length);
  assert.equal(cuesOf(missing.log).length, 0);
  assert.deepEqual(missing.log, plain.log, 'event-for-event the same as a plain workout');
});

test('warmupMin set but that length has no routine runs as a plain workout', () => {
  const partial = { ...config, warmups: { ...config.warmups, routines: { '8': ROUTINES['8'] } } };
  const { log, summary } = run({ warmupMin: 5 }, { cfg: partial });
  assert.equal(summary.warmupMin, 0);
  assert.ok(!statesOf(log).includes(STATES.TIMED));
});

test('an empty routine list also runs as a plain workout', () => {
  const empty = { ...config, warmups: { routines: { '5': [] } } };
  const { log } = run({ warmupMin: 5 }, { cfg: empty });
  assert.ok(!statesOf(log).includes(STATES.TIMED));
});

// session.js: `warmupSteps` is [] (truthy) here, so finish() reports warmupMin 5
// although buildPlan skipped the warm-up (it checks warmup?.length).
test('an empty routine list reports warmupMin 0 in the summary', () => {
  const empty = { ...config, warmups: { routines: { '5': [] } } };
  const { summary } = run({ warmupMin: 5 }, { cfg: empty });
  assert.equal(summary.warmupMin, 0);
});
