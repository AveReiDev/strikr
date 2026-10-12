import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from './fixtures.js';

import { stationsFor, createConditioningPicker } from '../src/engine/conditioning.js';
import { buildPlan, timedSegment } from '../src/engine/plan.js';
import { createSession, STATES } from '../src/engine/session.js';
import { createRng } from '../src/engine/selector.js';
import { estimateSpeechMs, voiceRate, applyPronunciation } from '../src/engine/timing.js';
import { sessionLoad, workoutLoad, applyWeekPlan } from '../src/engine/load.js';
import { createStorage } from '../src/store/storage.js';
import { createHistory } from '../src/store/history.js';
import { CHOICES, defaultSettings } from '../src/store/settings.js';

const config = loadConfig();
const L = config.load;
const EXERCISES = config.exercises.exercises;
const LOW = EXERCISES.filter((e) => !e.impact);
const COMBOS = JSON.parse(readFileSync(new URL('../data/combos.json', import.meta.url))).combos;
const ROUTINES = config.warmups.routines;

const BASE = {
  sport: 'muaythai',
  tier: 'advanced',
  intensity: 'medium',
  roundLengthMin: 1,
  roundsPerWorkout: 3,
  restBetweenRoundsSec: 10,
  countdownSec: 5,
  voiceSpeedPct: 75,
};
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

const picker = (seed, over = {}) => createConditioningPicker({
  exercises: EXERCISES, lowImpact: false, rng: createRng(seed), totalRounds: 6, config, ...over,
});
/** The work steps (not the setup step) of a round's steps. */
const work = (steps) => steps.filter((s) => !s.setup);
/** The exercise objects behind a round's work steps. */
const exOf = (steps) => work(steps).map((s) => EXERCISES.find((e) => e.name === s.exercise));

/* ---- 1. stations ----------------------------------------------------- */

test('stationsFor: up to a minute is one station, 90 s two, 2 min three', () => {
  assert.deepEqual(stationsFor(30), [30]);
  assert.deepEqual(stationsFor(45), [45]);
  assert.deepEqual(stationsFor(60), [60]);
  assert.deepEqual(stationsFor(90), [45, 45]);
  assert.deepEqual(stationsFor(120), [40, 40, 40]);
});

test('stationsFor: stations sum to the input, in multiples of 5, remainder on the last', () => {
  for (const sec of [30, 45, 60, 90, 120, 100, 95, 125, 135, 150]) {
    const st = stationsFor(sec);
    assert.equal(st.reduce((a, b) => a + b, 0), sec, `${sec} sums`);
    assert.ok(st.every((x) => x % 5 === 0 && x > 0), `${sec} multiples of 5`);
    assert.equal(st.slice(0, -1).every((x) => x === st[0]), true, `${sec} equal until the last`);
    assert.ok(st.at(-1) >= st[0], `${sec} remainder lands on the last`);
  }
  assert.deepEqual(stationsFor(125), [40, 40, 45]);
  assert.deepEqual(stationsFor(100), [50, 50]);
});

/* ---- 2. exercise data lint ------------------------------------------- */

test('exercise library: enums, types and cues are valid', () => {
  assert.ok(EXERCISES.length >= 16);
  for (const e of EXERCISES) {
    assert.ok(['legs', 'push', 'core', 'full'].includes(e.category), `${e.name} category`);
    assert.ok([1, 2, 3].includes(e.intensity), `${e.name} intensity`);
    assert.equal(typeof e.impact, 'boolean', `${e.name} impact`);
    assert.ok(e.plyo === undefined || typeof e.plyo === 'boolean', `${e.name} plyo`);
    assert.ok(e.sides === undefined || typeof e.sides === 'boolean', `${e.name} sides`);
    assert.equal(typeof e.cue, 'string');
    const cueWords = e.cue.trim().split(/\s+/);
    assert.ok(cueWords.length >= 1 && cueWords.length <= 6, `${e.name} cue is at most 6 words`);
  }
});

test('exercise library: names are unique, short, and speakable', () => {
  const names = EXERCISES.map((e) => e.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'unique names');
  for (const n of names) {
    assert.ok(n.trim() === n && n.length > 0);
    assert.ok(n.split(/\s+/).length <= 3, `${n} is at most 3 words`);
    assert.ok(!/[\d()]/.test(n), `${n} has no digits or parentheses`);
  }
});

test('exercise library: plyo implies impact', () => {
  for (const e of EXERCISES) if (e.plyo) assert.equal(e.impact, true, `${e.name}`);
});

test('exercise library: every category keeps at least four low-impact exercises', () => {
  for (const cat of ['legs', 'push', 'core', 'full']) {
    const n = LOW.filter((e) => e.category === cat).length;
    assert.ok(n >= 4, `${cat} has ${n} low-impact`);
  }
});

/* ---- 3. picker safety ------------------------------------------------ */

test('picker: never two plyometric exercises back to back within a round', () => {
  for (const lowImpact of [false, true]) {
    for (const seed of SEEDS) {
      const p = picker(seed, { lowImpact });
      for (let n = 1; n <= 6; n++) {
        const ex = exOf(p.steps(n, 120));
        for (let i = 1; i < ex.length; i++) {
          assert.ok(!(ex[i - 1].plyo && ex[i].plyo), `seed ${seed} round ${n}: ${ex[i - 1].name} then ${ex[i].name}`);
        }
      }
    }
  }
});

test('picker: no intensity-3 plyometrics once a round is past two thirds of the workout', () => {
  for (const total of [3, 6, 7]) {
    for (const seed of SEEDS) {
      const p = picker(seed, { totalRounds: total });
      for (let n = 1; n <= total; n++) {
        const late = n > (total * 2) / 3;
        for (const e of exOf(p.steps(n, 120))) {
          if (late) assert.ok(!(e.plyo && e.intensity >= 3), `seed ${seed} total ${total} round ${n}: ${e.name}`);
        }
      }
    }
  }
});

test('picker: the late rule leaves early rounds free to use intensity-3 plyometrics', () => {
  // Guards the test above from passing only because the library has none.
  let early = 0;
  for (const seed of SEEDS) {
    const p = picker(seed);
    for (let n = 1; n <= 2; n++) early += exOf(p.steps(n, 120)).filter((e) => e.plyo && e.intensity >= 3).length;
  }
  assert.ok(early > 0, 'some intensity-3 plyo appears early on');
});

test('picker: low impact never yields an impact exercise', () => {
  for (const seed of SEEDS) {
    const p = picker(seed, { lowImpact: true });
    for (let n = 1; n <= 6; n++) {
      for (const e of exOf(p.steps(n, 120))) assert.equal(e.impact, false, `seed ${seed}: ${e.name}`);
    }
  }
  // and without it, impact exercises do turn up
  let impact = 0;
  for (const seed of SEEDS) for (const e of exOf(picker(seed).steps(1, 120))) impact += e.impact ? 1 : 0;
  assert.ok(impact > 0);
});

test('picker: consecutive stations differ in category whenever the library allows', () => {
  for (const lowImpact of [false, true]) {
    for (const seed of SEEDS) {
      const p = picker(seed, { lowImpact });
      for (let n = 1; n <= 6; n++) {
        const ex = exOf(p.steps(n, 120));
        for (let i = 1; i < ex.length; i++) {
          assert.notEqual(ex[i].category, ex[i - 1].category, `seed ${seed} round ${n}`);
        }
      }
    }
  }
});

test('picker: an unused exercise in a different category is always preferred to a repeat', () => {
  // Rebuild what the picker saw (used set, previous station) from its output.
  for (const seed of SEEDS) {
    const p = picker(seed, { lowImpact: true });
    const used = new Set();
    for (let n = 1; n <= 6; n++) {
      const late = n > 4;
      let prev = null;
      for (const e of exOf(p.steps(n, 120))) {
        const safe = LOW.filter((x) => !(prev?.plyo && x.plyo) && !(late && x.plyo && x.intensity >= 3));
        const better = safe.filter((x) => !used.has(x.name) && x.category !== prev?.category);
        if (better.length) assert.ok(better.some((x) => x.name === e.name), `seed ${seed} round ${n}: repeated ${e.name}`);
        used.add(e.name);
        prev = e;
      }
    }
  }
});

test('picker: with a pool that cannot force a repeat, nothing repeats until the pool is spent', () => {
  // Four categories x two exercises, all low impact: eight stations (two
  // 2-minute rounds plus two stations of a third) use each exercise once.
  const cats = ['legs', 'push', 'core', 'full'];
  const small = cats.flatMap((category) => [1, 2].map((i) => ({
    name: `${category} move ${i}`, category, intensity: 1, impact: false, cue: 'Stay tight',
  })));
  for (const seed of SEEDS) {
    const p = createConditioningPicker({ exercises: small, lowImpact: false, rng: createRng(seed), totalRounds: 3, config });
    const names = [...exOf2(p.steps(1, 120), small), ...exOf2(p.steps(2, 120), small)].map((e) => e.name);
    // six stations from a pool of eight: no repeats at all
    assert.equal(new Set(names).size, names.length, `seed ${seed}: ${names.join(', ')}`);
  }
});
const exOf2 = (steps, pool) => work(steps).map((s) => pool.find((e) => e.name === s.exercise));

test('picker: once the pool is exhausted it repeats, but still obeys the safety rules', () => {
  const pool = [
    { name: 'Alpha', category: 'legs', intensity: 1, impact: false, cue: 'Go' },
    { name: 'Beta', category: 'push', intensity: 1, impact: false, cue: 'Go' },
  ];
  for (const seed of SEEDS.slice(0, 40)) {
    const p = createConditioningPicker({ exercises: pool, lowImpact: false, rng: createRng(seed), totalRounds: 4, config });
    for (let n = 1; n <= 4; n++) {
      const steps = p.steps(n, 120);
      assert.equal(work(steps).length, 3);
      const names = work(steps).map((s) => s.exercise);
      assert.ok(names.every((x, i) => i === 0 || x !== names[i - 1]), `alternates: ${names}`);
    }
  }
  // a single-exercise library still produces rounds
  const one = createConditioningPicker({ exercises: pool.slice(0, 1), lowImpact: false, rng: createRng(1), totalRounds: 2, config });
  assert.equal(work(one.steps(1, 120)).length, 3);
});

test('picker: unused exercises are still preferred when the whole pool is one category', () => {
  const pool = ['a', 'b', 'c', 'd'].map((name) => ({ name, category: 'legs', intensity: 1, impact: false, cue: 'Stay tight' }));
  for (const seed of SEEDS) {
    const p = createConditioningPicker({ exercises: pool, lowImpact: false, rng: createRng(seed), totalRounds: 3, config });
    const names = work(p.steps(1, 120)).map((s) => s.exercise);
    assert.equal(new Set(names).size, names.length, `seed ${seed}: ${names.join(', ')}`);
  }
});

test('picker: plyo rule holds even when it forces a repeat', () => {
  // Only one non-plyo exercise exists: it must fill every second station.
  const pool = [
    { name: 'Hop one', category: 'legs', intensity: 1, impact: true, plyo: true, cue: 'Go' },
    { name: 'Hop two', category: 'full', intensity: 1, impact: true, plyo: true, cue: 'Go' },
    { name: 'Hold', category: 'core', intensity: 1, impact: false, cue: 'Go' },
  ];
  for (const seed of SEEDS.slice(0, 60)) {
    const p = createConditioningPicker({ exercises: pool, lowImpact: false, rng: createRng(seed), totalRounds: 3, config });
    for (let n = 1; n <= 3; n++) {
      const ex = exOf2(p.steps(n, 120), pool);
      for (let i = 1; i < ex.length; i++) assert.ok(!(ex[i - 1].plyo && ex[i].plyo), `seed ${seed}`);
    }
  }
});

test('picker: the same seed gives the same workout; different seeds differ', () => {
  const full = (seed) => {
    const p = picker(seed);
    return [1, 2, 3, 4, 5, 6].map((n) => p.steps(n, 120));
  };
  assert.deepEqual(full(11), full(11));
  assert.notDeepEqual(full(11), full(12));
});

test('picker: an empty or missing library gives null', () => {
  for (const exercises of [[], undefined, null]) {
    const p = createConditioningPicker({ exercises, lowImpact: false, rng: createRng(1), totalRounds: 3, config });
    assert.equal(p.steps(1, 60), null);
    assert.equal(p.steps(1, 120), null);
  }
  // a library that low impact empties entirely
  const p = createConditioningPicker({
    exercises: EXERCISES.filter((e) => e.impact), lowImpact: true, rng: createRng(1), totalRounds: 3, config,
  });
  assert.equal(p.steps(1, 60), null);
});

/* ---- 4. step shape --------------------------------------------------- */

test('steps: a setup step with the name and cue, then Go on the first work step', () => {
  for (const sec of [30, 45, 60, 90, 120]) {
    const steps = picker(3).steps(1, sec);
    const [setup, first] = steps;
    assert.equal(setup.setup, true);
    assert.equal(setup.sec, 5);
    const ex = EXERCISES.find((e) => e.name === setup.name);
    assert.ok(ex, 'setup names a library exercise');
    assert.equal(setup.cue, ex.cue);
    assert.equal(first.speak, 'Go');
    assert.equal(first.name, ex.name, 'the first work step is the exercise being set up for');
    assert.equal(first.exercise, ex.name);
    assert.equal(first.sec, stationsFor(sec)[0]);
    assert.ok(!first.setup);
    assert.equal(steps.filter((s) => s.setup).length, 1, 'only one setup step per round');
    assert.equal(work(steps).length, stationsFor(sec).length);
  }
});

test('steps: later stations say "Switch, <name>" and carry sides', () => {
  for (const seed of SEEDS.slice(0, 50)) {
    const steps = picker(seed).steps(1, 120);
    const ws = work(steps);
    assert.deepEqual(ws.map((s) => s.sec), [40, 40, 40]);
    ws.slice(1).forEach((s) => {
      assert.equal(s.speak, `Switch, ${s.name}`);
      assert.equal(s.exercise, s.name);
    });
    for (const s of ws) {
      const ex = EXERCISES.find((e) => e.name === s.exercise);
      assert.equal(s.sides, ex.sides, `${s.exercise} sides copied`);
    }
  }
  // at least one two-sided and one one-sided exercise get picked across seeds
  const sides = new Set();
  for (const seed of SEEDS) for (const s of work(picker(seed).steps(1, 120))) sides.add(Boolean(s.sides));
  assert.deepEqual([...sides].sort(), [false, true]);
});

test('steps: total seconds are the setup plus the conditioning time', () => {
  for (const sec of [30, 45, 60, 90, 120]) {
    const steps = picker(5).steps(2, sec);
    assert.equal(steps.reduce((a, s) => a + s.sec, 0), 5 + sec, `${sec}`);
  }
});

test('steps: config.conditioning.setupSec overrides the five-second default', () => {
  const cfg = { ...config, conditioning: { setupSec: 8 } };
  const steps = picker(5, { config: cfg }).steps(1, 60);
  assert.equal(steps[0].sec, 8);
  assert.equal(steps.reduce((a, s) => a + s.sec, 0), 68);
});

/* ---- timedSegment: speak and marks ----------------------------------- */

test('timedSegment: a step speaks its `speak` text instead of its name, then its cue', () => {
  const seg = timedSegment([{ name: 'Squats', speak: 'Go', sec: 20, cue: 'Chest tall' }], { rate: 1, config });
  assert.deepEqual(seg.cues.map((c) => c.text), ['Go', 'Chest tall']);
  assert.ok(!seg.cues.some((c) => c.text === 'Squats'));
});

test('timedSegment: marks are timed from the end, skipped if they would precede the start', () => {
  const seg = timedSegment([{ name: 'A', sec: 30 }], { rate: 1, config, marks: [{ fromEndMs: 10000, text: 'Ten seconds' }, { fromEndMs: 30000, text: 'Never' }, { fromEndMs: 60000, text: 'Nope' }] });
  const ten = seg.cues.find((c) => c.text === 'Ten seconds');
  assert.equal(ten.atMs, 20000);
  assert.ok(!seg.cues.some((c) => c.text === 'Never' || c.text === 'Nope'));
});

test('timedSegment: cues are sorted by time, a step name stays ahead of its cue, and they are spaced', () => {
  const est = (text, rate) => estimateSpeechMs(applyPronunciation(text, config.pronunciation), rate, config.speechEstimate);
  for (const rate of [0.8, 1, 1.4]) {
    const steps = [
      { name: 'Wall sit', sec: 5, cue: 'Thighs level, back flat', setup: true },
      { name: 'Wall sit', speak: 'Go', sec: 40 },
      { name: 'Single leg bridge', speak: 'Switch, Single leg bridge', sec: 40, sides: true },
    ];
    const seg = timedSegment(steps, { rate, config, marks: [{ fromEndMs: 10000, text: 'Ten seconds' }] });
    assert.deepEqual(seg.cues.slice(0, 2).map((c) => c.text), ['Wall sit', 'Thighs level, back flat']);
    for (let i = 1; i < seg.cues.length; i++) {
      const prev = seg.cues[i - 1];
      assert.ok(seg.cues[i].atMs >= prev.atMs + est(prev.text, rate) + 300, `rate ${rate}: cue ${i}`);
    }
  }
});

/* ---- 5. plan --------------------------------------------------------- */

const cond = (settings, seed = 1) => ({
  ...settings,
  _picker: picker(seed, { totalRounds: Math.max(0, settings.roundsPerWorkout - 1) }),
});
const planFor = (over = {}, { seed = 1, rate = 1, warmup = null } = {}) => {
  const settings = { ...BASE, conditioningSec: 60, ...over };
  return buildPlan(settings, { warmup, conditioning: cond(settings, seed)._picker, rate, config });
};

test('plan: a conditioning round sits between every pair of bag rounds, followed by a Rest rest', () => {
  for (const n of [2, 3, 5]) {
    const plan = planFor({ roundsPerWorkout: n });
    const expected = [];
    for (let i = 1; i <= n; i++) {
      expected.push('bag');
      if (i < n) expected.push('timed', 'rest');
    }
    assert.deepEqual(plan.map((s) => s.type), expected, `${n} rounds`);
    const timed = plan.filter((s) => s.type === 'timed');
    assert.equal(timed.length, n - 1);
    timed.forEach((t, i) => {
      assert.equal(t.kind, 'conditioning');
      assert.equal(t.round, i + 1);
      assert.equal(t.workSec, 60);
      assert.equal(t.durationMs, (5 + 60) * 1000);
    });
    plan.forEach((seg, i) => {
      if (seg.type === 'timed') {
        assert.equal(plan[i - 1].type, 'bag');
        assert.equal(plan[i + 1].type, 'rest');
        assert.equal(plan[i + 1].enterSay, 'Rest');
        assert.equal(plan[i + 1].durationMs, BASE.restBetweenRoundsSec * 1000);
      }
    });
    assert.equal(plan.at(-1).type, 'bag', 'no conditioning or rest after the last bag round');
    assert.equal(plan[0].type, 'bag', 'none before the first');
    assert.deepEqual(plan.filter((s) => s.type === 'bag').map((s) => s.round), Array.from({ length: n }, (_, i) => i + 1));
  }
});

test('plan: one round has no conditioning at all', () => {
  const plan = planFor({ roundsPerWorkout: 1 });
  assert.deepEqual(plan, [{ type: 'bag', round: 1, durationMs: 60000 }]);
});

test('plan: a Ten seconds cue lands ten seconds before the end for 30 s and longer', () => {
  for (const sec of [30, 45, 60, 90, 120]) {
    for (const seed of [1, 2, 3]) {
      const plan = planFor({ conditioningSec: sec, roundsPerWorkout: 4 }, { seed });
      for (const seg of plan.filter((s) => s.type === 'timed')) {
        const tens = seg.cues.filter((c) => c.text === 'Ten seconds');
        assert.equal(tens.length, 1, `${sec}s seed ${seed}`);
        assert.equal(tens[0].atMs, seg.durationMs - 10000, `${sec}s seed ${seed}`);
      }
    }
  }
});

test('plan: cue spacing holds in every conditioning segment, all cues fall inside it, and they never run backwards', () => {
  for (const rate of [0.7, 1, 1.5]) {
    const est = (text) => estimateSpeechMs(applyPronunciation(text, config.pronunciation), rate, config.speechEstimate);
    for (const sec of [30, 45, 60, 90, 120]) {
      for (const seed of SEEDS.slice(0, 60)) {
        const plan = planFor({ conditioningSec: sec, roundsPerWorkout: 5 }, { seed, rate });
        for (const seg of plan.filter((s) => s.type === 'timed')) {
          seg.cues.forEach((c, i) => {
            assert.ok(c.atMs < seg.durationMs, `${sec}s seed ${seed} rate ${rate}: "${c.text}" at ${c.atMs} is after the end`);
            if (i === 0) return;
            const prev = seg.cues[i - 1];
            assert.ok(c.atMs >= prev.atMs + est(prev.text) + 300, `${sec}s seed ${seed} rate ${rate}: "${c.text}" crowds "${prev.text}"`);
          });
        }
      }
    }
  }
});

test('plan: every work step is announced (Go / Switch) inside its own window', () => {
  for (const seed of SEEDS.slice(0, 60)) {
    const plan = planFor({ conditioningSec: 120, roundsPerWorkout: 4 }, { seed, rate: 1 });
    for (const seg of plan.filter((s) => s.type === 'timed')) {
      for (const step of seg.steps.filter((s) => !s.setup)) {
        const cue = seg.cues.find((c) => c.text === step.speak);
        assert.ok(cue, `seed ${seed}: "${step.speak}" is scheduled`);
        assert.ok(cue.atMs >= step.startMs && cue.atMs < step.endMs, `seed ${seed}: "${step.speak}" at ${cue.atMs} in [${step.startMs}, ${step.endMs})`);
      }
    }
  }
});

test('plan: with conditioningSec 0 or no picker it is identical to the plan without conditioning', () => {
  for (const n of [1, 2, 4]) {
    for (const warmup of [null, ROUTINES['5']]) {
      const settings = { ...BASE, roundsPerWorkout: n };
      const old = buildPlan(settings, { warmup, rate: 1, config });
      assert.deepEqual(buildPlan({ ...settings, conditioningSec: 0 }, { warmup, conditioning: picker(1), rate: 1, config }), old, `off, ${n} rounds`);
      assert.deepEqual(buildPlan({ ...settings, conditioningSec: 60 }, { warmup, rate: 1, config }), old, `no picker, ${n} rounds`);
      assert.deepEqual(buildPlan({ ...settings, conditioningSec: 60 }, { warmup, conditioning: null, rate: 1, config }), old);
      assert.ok(!old.some((s) => s.kind === 'conditioning'));
      assert.ok(old.every((s) => s.enterSay !== 'Rest'));
    }
  }
});

test('plan: a warm-up still comes first, then bag round 1', () => {
  const plan = planFor({ roundsPerWorkout: 3 }, { warmup: ROUTINES['5'] });
  assert.deepEqual(plan.map((s) => s.type), ['timed', 'rest', 'bag', 'timed', 'rest', 'bag', 'timed', 'rest', 'bag']);
  assert.deepEqual(plan.filter((s) => s.type === 'timed').map((s) => s.kind), ['warmup', 'conditioning', 'conditioning']);
  assert.equal(plan[1].enterSay, config.warmup.doneCallout);
});

/* ---- 6. session ------------------------------------------------------ */

const STEP_MS = 50;
const only = (log, type) => log.filter((e) => e.type === type);
const statesOf = (log) => only(log, 'state').map((e) => e.to);

/**
 * Fake-clock driver (same pattern as plan.test.js). Speech is simulated at the
 * engine's own estimate and only combo/defense speech reports back, as in the
 * real app. `abortWhen(log, t)` may return true to abort at that tick.
 */
function run(settings = {}, { seed = 1, maxMs = 60 * 60 * 1000, abortWhen = null } = {}) {
  const s = { ...BASE, ...settings };
  const rate = voiceRate(s.voiceSpeedPct, config.voiceRateRange);
  const session = createSession({ config, settings: s, combos: COMBOS, rng: createRng(seed) });
  const log = [];
  const snaps = [];
  let t = 0;
  let speechEndsAt = null;
  let speechTag = null;
  let summary = null;

  const push = (events) => {
    for (const e of events) {
      log.push({ t, ...e });
      if (e.type === 'say') {
        speechEndsAt = t + estimateSpeechMs(e.text, rate, config.speechEstimate);
        speechTag = e.tag;
      } else if (e.type === 'cancelSpeech') speechEndsAt = null;
      else if (e.type === 'finished') summary = e.summary;
    }
  };

  push(session.start(t));
  push(session.ready(t));
  while (t < maxMs && !summary) {
    t += STEP_MS;
    if (speechEndsAt !== null && t >= speechEndsAt) {
      const tag = speechTag;
      speechEndsAt = null;
      if (tag === 'combo' || tag === 'defense') push(session.speechEnded(t));
    }
    push(session.tick(t));
    snaps.push({ t, snap: session.snapshot(t) });
    if (abortWhen && !summary && abortWhen(log, t)) push(session.abort(t));
  }
  return { log, snaps, summary, settings: s, t };
}

/** Events strictly inside the nth (1-based) TIMED state of a log, up to the next state change. */
function insideTimed(log, nth) {
  const idx = log.map((e, i) => (e.type === 'state' && e.to === STATES.TIMED ? i : -1)).filter((i) => i >= 0)[nth - 1];
  const rest = log.slice(idx + 1);
  const end = rest.findIndex((e) => e.type === 'state');
  return end < 0 ? rest : rest.slice(0, end);
}

test('session: states run ROUND, TIMED, REST, ROUND ... and complete', () => {
  for (const n of [2, 3, 4]) {
    const { log, summary } = run({ roundsPerWorkout: n, conditioningSec: 30 });
    const expected = [STATES.PREPARING, STATES.COUNTDOWN];
    for (let i = 1; i <= n; i++) {
      expected.push(STATES.ROUND);
      if (i < n) expected.push(STATES.TIMED, STATES.REST);
    }
    expected.push(STATES.COMPLETE);
    assert.deepEqual(statesOf(log), expected, `${n} rounds`);
    assert.equal(summary.completed, true);
    assert.equal(summary.rounds, n);
  }
});

test('session: no combos, defenses or bells during conditioning; the voice follows the cues', () => {
  const { log } = run({ roundsPerWorkout: 3, conditioningSec: 60, workoutMode: 'defense' });
  for (const nth of [1, 2]) {
    const inside = insideTimed(log, nth);
    assert.ok(inside.length > 0);
    assert.equal(inside.filter((e) => e.type === 'bell' || e.type === 'combo' || e.type === 'defense').length, 0, `conditioning ${nth}`);
    const says = inside.filter((e) => e.type === 'say');
    assert.ok(says.length >= 3, 'name, cue, Go, ten seconds');
    assert.ok(says.every((e) => e.tag === 'cue'), `conditioning ${nth}: ${says.map((e) => e.tag)}`);
    assert.ok(says.some((e) => e.text === 'Go'));
    assert.ok(says.some((e) => e.text === 'Ten seconds'));
  }
  assert.equal(only(log, 'bell').length, 6, 'three bag rounds, two bells each, none for conditioning');
});

test('session: a 2-minute conditioning round announces each station once', () => {
  const { log } = run({ roundsPerWorkout: 2, conditioningSec: 120 });
  const says = insideTimed(log, 1).filter((e) => e.type === 'say').map((e) => e.text);
  assert.equal(says.filter((x) => x === 'Go').length, 1);
  assert.equal(says.filter((x) => x.startsWith('Switch, ')).length, 2);
  assert.equal(only(insideTimed(log, 1), 'step').length, 4, 'setup + three stations');
});

test('session: Rest is said on entering the rest after conditioning, and only then', () => {
  const { log } = run({ roundsPerWorkout: 4, conditioningSec: 45 });
  const rests = log.map((e, i) => (e.type === 'state' && e.to === STATES.REST ? i : -1)).filter((i) => i >= 0);
  assert.equal(rests.length, 3);
  for (const i of rests) {
    const next = log[i + 1];
    assert.equal(next.type, 'say');
    assert.equal(next.text, 'Rest');
    assert.equal(next.tag, 'rest');
    assert.equal(next.t, log[i].t, 'on entry');
  }
  assert.equal(log.filter((e) => e.type === 'say' && e.text === 'Rest').length, 3);

  const plain = run({ roundsPerWorkout: 4, conditioningSec: 0 });
  assert.equal(plain.log.filter((e) => e.type === 'say' && e.text === 'Rest').length, 0, 'no conditioning, no Rest call');
});

test('session: a full run counts roundsPerWorkout - 1 conditioning rounds in the summary', () => {
  for (const n of [1, 2, 3, 5]) {
    const { summary } = run({ roundsPerWorkout: n, conditioningSec: 30 });
    assert.equal(summary.conditioningRounds, n - 1, `${n} rounds`);
    assert.equal(summary.conditioningSec, 30);
    assert.equal(summary.lowImpact, false);
  }
});

test('session: summary reports lowImpact only while conditioning is on', () => {
  assert.equal(run({ roundsPerWorkout: 2, conditioningSec: 30, lowImpact: true }).summary.lowImpact, true);
  const off = run({ roundsPerWorkout: 2, conditioningSec: 0, lowImpact: true }).summary;
  assert.equal(off.lowImpact, false);
  assert.equal(off.conditioningSec, 0);
  assert.equal(off.conditioningRounds, 0);
});

test('session: aborting mid-conditioning does not count the round in progress', () => {
  const abortInSecondConditioning = (log, t) => {
    const entered = only(log, 'state').filter((e) => e.to === STATES.TIMED);
    return entered.length === 2 && t >= entered[1].t + 10000;
  };
  const { summary, log } = run({ roundsPerWorkout: 4, conditioningSec: 60 }, { abortWhen: abortInSecondConditioning });
  assert.equal(summary.completed, false);
  assert.equal(summary.conditioningRounds, 1, 'only the first, finished, one counts');
  assert.equal(summary.rounds, 2, 'two bag rounds finished');
  assert.equal(only(log, 'state').filter((e) => e.to === STATES.TIMED).length, 2);
});

test('session: aborting during the first conditioning round counts none; aborting in a rest counts the finished ones', () => {
  const first = run({ roundsPerWorkout: 3, conditioningSec: 30 }, {
    abortWhen: (log, t) => { const e = only(log, 'state').filter((x) => x.to === STATES.TIMED); return e.length === 1 && t >= e[0].t + 5000; },
  });
  assert.equal(first.summary.conditioningRounds, 0);
  assert.equal(first.summary.rounds, 1);

  const inRest = run({ roundsPerWorkout: 3, conditioningSec: 30 }, {
    abortWhen: (log, t) => { const e = only(log, 'state').filter((x) => x.to === STATES.REST); return e.length === 2 && t >= e[1].t + 1000; },
  });
  assert.equal(inRest.summary.conditioningRounds, 2, 'the second conditioning round finished before that rest');
});

test('session: with a warm-up, bag rounds are still numbered 1..N and the warm-up is not conditioning', () => {
  const { log, snaps, summary } = run({ warmupMin: 5, roundsPerWorkout: 3, conditioningSec: 45 });
  assert.deepEqual(statesOf(log), [
    STATES.PREPARING, STATES.COUNTDOWN,
    STATES.TIMED, STATES.REST,
    STATES.ROUND, STATES.TIMED, STATES.REST,
    STATES.ROUND, STATES.TIMED, STATES.REST,
    STATES.ROUND, STATES.COMPLETE,
  ]);
  const seen = [];
  for (const { snap } of snaps) if (snap.state === STATES.ROUND && seen.at(-1) !== snap.roundIndex) seen.push(snap.roundIndex);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(summary.warmupMin, 5);
  assert.equal(summary.rounds, 3);
  assert.equal(summary.conditioningRounds, 2, 'the warm-up is not counted');
  assert.equal(summary.conditioningSec, 45);
});

test('session: ramp-up round gaps are unaffected by conditioning', () => {
  const gaps = (settings) => {
    const { snaps } = run({ rampUp: true, intensity: 'hard', roundsPerWorkout: 4, ...settings });
    const m = new Map();
    for (const { snap } of snaps) if (snap.state === STATES.ROUND && !m.has(snap.roundIndex)) m.set(snap.roundIndex, snap.intensity.baseGapMs);
    return [...m.entries()];
  };
  const off = gaps({ conditioningSec: 0 });
  assert.equal(off.length, 4);
  assert.deepEqual(gaps({ conditioningSec: 60 }), off);
  assert.deepEqual(gaps({ conditioningSec: 60, warmupMin: 5 }), off);
});

test('session: the snapshot shows the conditioning step while it runs', () => {
  const { snaps } = run({ roundsPerWorkout: 2, conditioningSec: 60 });
  const timed = snaps.filter((s) => s.snap.state === STATES.TIMED);
  assert.ok(timed.length > 0);
  const withStep = timed.filter((s) => s.snap.step);
  assert.equal(withStep[0].snap.step.setup, true, 'opens on the get-set step');
  const names = new Set(withStep.map((s) => s.snap.step.exercise).filter(Boolean));
  assert.equal(names.size, 1, 'a 60 s round is one exercise');
  assert.ok(EXERCISES.some((e) => names.has(e.name)));
  assert.ok(timed.every((s) => s.snap.totalMs === 65000));
});

test('session: a conditioning workout is deterministic for a seed, and low impact changes only the exercises', () => {
  const a = run({ roundsPerWorkout: 3, conditioningSec: 120 }, { seed: 4 });
  const b = run({ roundsPerWorkout: 3, conditioningSec: 120 }, { seed: 4 });
  assert.deepEqual(a.log, b.log);
  const low = run({ roundsPerWorkout: 6, conditioningSec: 120, lowImpact: true }, { seed: 4 });
  const names = new Set(only(low.log, 'step').map((e) => e.step.exercise).filter(Boolean));
  assert.ok(names.size > 0);
  for (const n of names) assert.equal(EXERCISES.find((e) => e.name === n).impact, false, n);
});

test('session: a missing exercise library turns conditioning off', () => {
  const noLib = { ...config, exercises: undefined };
  const session = createSession({ config: noLib, settings: { ...BASE, conditioningSec: 60 }, combos: COMBOS, rng: createRng(1) });
  const events = [...session.start(0), ...session.ready(0)];
  assert.ok(events.length > 0);
  let summary = null;
  for (let t = 50; t < 20 * 60 * 1000 && !summary; t += 50) {
    for (const e of session.tick(t)) if (e.type === 'finished') summary = e.summary;
  }
  assert.equal(summary.conditioningSec, 0);
  assert.equal(summary.conditioningRounds, 0);
});

/* ---- 7. load --------------------------------------------------------- */

test('load: a record without conditioning fields is scored exactly as before', () => {
  const r = (over) => sessionLoad({ intensity: 'hard', rounds: 4, roundLengthSec: 120, ...over }, L);
  assert.equal(r({}), 12);
  assert.equal(r({ conditioningRounds: 3 }), 12, 'rounds without a length add nothing');
  assert.equal(r({ conditioningSec: 60 }), 12, 'a length without rounds adds nothing');
  assert.equal(r({ conditioningSec: 60, conditioningRounds: 0 }), 12);
});

test('load: conditioning adds rounds x minutes x factor, all times the intensity factor', () => {
  const rec = { intensity: 'hard', rounds: 4, roundLengthSec: 120, conditioningSec: 60, conditioningRounds: 3 };
  assert.equal(sessionLoad(rec, L), (8 + 3) * 1.5);
  assert.equal(sessionLoad({ ...rec, intensity: 'light' }, L), 11);
  assert.equal(sessionLoad({ ...rec, conditioningSec: 120, conditioningRounds: 1 }, L), (8 + 2) * 1.5);
  assert.equal(sessionLoad(rec, { ...L, conditioningFactor: 0.5 }), (8 + 1.5) * 1.5);
  assert.equal(sessionLoad(rec, { ...L, conditioningFactor: undefined }), (8 + 3) * 1.5, 'missing factor counts as 1');
});

test('load: workoutLoad prices one fewer conditioning round than bag rounds', () => {
  assert.equal(workoutLoad(4, 'hard', 2, 60, L), (8 + 3) * 1.5);
  assert.equal(workoutLoad(4, 'hard', 2, 0, L), 12);
  assert.equal(workoutLoad(4, 'hard', 2, undefined, L), 12);
  assert.equal(workoutLoad(1, 'hard', 2, 120, L), 3, 'a single round has no conditioning');
  assert.equal(workoutLoad(0, 'hard', 2, 60, L), 0);
  assert.equal(workoutLoad(3, 'custom', 1, 90, L), (3 + 3) * 1.25);
  assert.equal(workoutLoad(3, 'hard', 2, 60, { ...L, conditioningFactor: 0.5 }), (6 + 1) * 1.5);
});

test('load: a finished workout scores the same planned as played', () => {
  const { summary } = run({ roundsPerWorkout: 4, conditioningSec: 60, intensity: 'hard', roundLengthMin: 2 });
  assert.equal(sessionLoad(summary, L), workoutLoad(4, 'hard', 2, 60, L));
});

const SUG = { rounds: 8, intensity: 'hard', roundLengthMin: 2, reason: 'You did 7 rounds hard on Mon', goalReached: false };
const plan = (over) => ({ thisWeek: 0, reference: 50, target: 55, easy: false, weekOfBlock: 2, blockLength: 4, ...over });

test('applyWeekPlan: conditioning off is identical to the old behaviour', () => {
  for (const thisWeek of [0, 10, 40, 54, 80]) {
    for (const easy of [false, true]) {
      const p = plan({ thisWeek, easy, target: easy ? 30 : 55 });
      const old = applyWeekPlan(SUG, p, L);
      assert.deepEqual(applyWeekPlan(SUG, p, L, { conditioningSec: 0 }), old, `${thisWeek}/${easy}`);
      assert.deepEqual(applyWeekPlan(SUG, p, L, {}), old);
    }
  }
  // the numbers from the existing load tests
  const s = applyWeekPlan(SUG, plan({ thisWeek: 40 }), L, { conditioningSec: 0 });
  assert.equal(s.rounds, 5);
  assert.match(s.reason, /Trimmed/);
  assert.doesNotMatch(s.reason, /conditioning/);
  assert.equal(applyWeekPlan(SUG, plan({ thisWeek: 10 }), L, { conditioningSec: 0 }).reason, SUG.reason);
  const easy = applyWeekPlan(SUG, plan({ easy: true, target: 30 }), L, { conditioningSec: 0 });
  assert.equal(easy.rounds, 5);
  assert.match(easy.reason, /Easy week/);
  const done = applyWeekPlan(SUG, plan({ thisWeek: 54 }), L, { conditioningSec: 0 });
  assert.equal(done.weekDone, true);
  assert.equal(done.rounds, 3);
});

test('applyWeekPlan: conditioning trims more rounds, and the reason says why', () => {
  // 15 left: 5 hard 2-min rounds cost 15, but with a minute of conditioning
  // between them n rounds cost (3n - 1) x 1.5, so only 3 fit.
  const s = applyWeekPlan(SUG, plan({ thisWeek: 40 }), L, { conditioningSec: 60 });
  assert.equal(s.rounds, 3);
  assert.ok(workoutLoad(3, 'hard', 2, 60, L) <= 15 && workoutLoad(4, 'hard', 2, 60, L) > 15);
  assert.match(s.reason, /Trimmed/);
  assert.match(s.reason, /conditioning counts toward it/);
  assert.equal(s.intensity, 'hard');

  // 30 left: 7 rounds with a minute of conditioning, 5 with two minutes.
  const sixty = applyWeekPlan(SUG, plan({ thisWeek: 25 }), L, { conditioningSec: 60 });
  const twoMin = applyWeekPlan(SUG, plan({ thisWeek: 25 }), L, { conditioningSec: 120 });
  assert.equal(sixty.rounds, 7);
  assert.equal(twoMin.rounds, 5);
});

test('applyWeekPlan: a fit suggestion is left alone, reason included', () => {
  const s = applyWeekPlan(SUG, plan({ thisWeek: 10 }), L, { conditioningSec: 60 });
  assert.equal(s.rounds, 8);
  assert.equal(s.reason, SUG.reason);
});

test('applyWeekPlan: an easy week with conditioning keeps the Easy week wording and mentions conditioning', () => {
  const s = applyWeekPlan(SUG, plan({ easy: true, target: 30, thisWeek: 15 }), L, { conditioningSec: 60 });
  assert.equal(s.rounds, 3);
  assert.match(s.reason, /Easy week/);
  assert.match(s.reason, /conditioning counts toward it/);
});

test('applyWeekPlan: the week is done when not even one bag round fits, conditioning or not', () => {
  const s = applyWeekPlan(SUG, plan({ thisWeek: 54 }), L, { conditioningSec: 60 });
  assert.equal(s.weekDone, true);
  assert.equal(s.intensity, 'light');
  assert.equal(s.rounds, 3);
});

test('applyWeekPlan: conditioning never yields more rounds than without, and always a value settings accept', () => {
  for (let rounds = 1; rounds <= 15; rounds++) {
    for (const thisWeek of [0, 20, 40, 54, 80]) {
      for (const easy of [false, true]) {
        for (const conditioningSec of CHOICES.conditioningSec) {
          const p = plan({ thisWeek, easy });
          const without = applyWeekPlan({ ...SUG, rounds }, p, L);
          const withCond = applyWeekPlan({ ...SUG, rounds }, p, L, { conditioningSec });
          assert.ok(CHOICES.roundsPerWorkout.includes(withCond.rounds), `${rounds}/${thisWeek}/${easy}/${conditioningSec} -> ${withCond.rounds}`);
          assert.ok(withCond.rounds <= without.rounds || withCond.weekDone, `${rounds}/${thisWeek}/${easy}/${conditioningSec}`);
        }
      }
    }
  }
});

test('applyWeekPlan: no target and goal-reached suggestions pass through untouched with conditioning on', () => {
  assert.deepEqual(applyWeekPlan(SUG, plan({ target: null }), L, { conditioningSec: 90 }), SUG);
  const reached = { ...SUG, goalReached: true };
  assert.deepEqual(applyWeekPlan(reached, plan({ thisWeek: 999 }), L, { conditioningSec: 90 }), reached);
});

/* ---- settings -------------------------------------------------------- */

test('settings: conditioningSec and lowImpact have the allowed values and off defaults', () => {
  assert.deepEqual(CHOICES.conditioningSec, [0, 30, 45, 60, 90, 120]);
  const d = defaultSettings(config);
  assert.equal(d.conditioningSec, 0);
  assert.equal(d.lowImpact, false);
});

/* ---- 8. history ------------------------------------------------------ */

function fakeBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

let seq = 0;
function record(over = {}) {
  seq += 1;
  return {
    id: `c${seq}`,
    startedAt: new Date().toISOString(),
    sport: 'muaythai',
    tier: 'advanced',
    intensity: 'medium',
    rounds: 3,
    roundLengthSec: 120,
    restSec: 30,
    durationSec: 600,
    combosCalled: 40,
    completed: true,
    ...over,
  };
}

/** Add a record, then load history afresh from the same backend. */
function roundTrip(over) {
  const backend = fakeBackend();
  const first = createHistory({ storage: createStorage({ backend }) });
  const rec = record(over);
  first.add(rec);
  const reloaded = createHistory({ storage: createStorage({ backend }) });
  return reloaded.all().find((r) => r.id === rec.id);
}

test('history: conditioning fields survive a reload', () => {
  const r = roundTrip({ conditioningSec: 60, conditioningRounds: 2, lowImpact: true });
  assert.equal(r.conditioningSec, 60);
  assert.equal(r.conditioningRounds, 2);
  assert.equal(r.lowImpact, true);
  assert.equal(roundTrip({ conditioningSec: 120, conditioningRounds: 0 }).conditioningRounds, 0);
  for (const sec of [30, 45, 60, 90, 120]) assert.equal(roundTrip({ conditioningSec: sec, conditioningRounds: 1 }).conditioningSec, sec);
});

test('history: lowImpact is only kept when true, and a record without conditioning gains no fields', () => {
  const r = roundTrip({ conditioningSec: 45, conditioningRounds: 2, lowImpact: false });
  assert.equal('lowImpact' in r, false);
  const plain = roundTrip({});
  for (const k of ['conditioningSec', 'conditioningRounds', 'lowImpact']) assert.equal(k in plain, false, k);
});

test('history: an invalid conditioningSec drops all three fields', () => {
  for (const bad of [0, 15, 61, -30, '60', null, NaN, 'abc']) {
    const r = roundTrip({ conditioningSec: bad, conditioningRounds: 2, lowImpact: true });
    for (const k of ['conditioningSec', 'conditioningRounds', 'lowImpact']) assert.equal(k in r, false, `${String(bad)} -> ${k}`);
  }
});

test('history: a bad conditioningRounds is zeroed, not trusted', () => {
  for (const bad of [-1, 1.5, '2', undefined, null]) {
    const r = roundTrip({ conditioningSec: 60, conditioningRounds: bad });
    assert.equal(r.conditioningSec, 60);
    assert.equal(r.conditioningRounds, 0, String(bad));
  }
});

test('history: a session summary round-trips and scores the same afterwards', () => {
  const { summary } = run({ roundsPerWorkout: 3, conditioningSec: 90, lowImpact: true, intensity: 'hard' });
  const r = roundTrip({
    ...summary,
    startedAt: new Date().toISOString(),
    conditioningSec: summary.conditioningSec || undefined,
    conditioningRounds: summary.conditioningRounds,
    lowImpact: summary.lowImpact || undefined,
  });
  assert.equal(r.conditioningSec, 90);
  assert.equal(r.conditioningRounds, 2);
  assert.equal(r.lowImpact, true);
  assert.equal(sessionLoad(r, L), sessionLoad(summary, L));
});
