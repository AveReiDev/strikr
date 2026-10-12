import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, STRIKES, COMBOS } from './fixtures.js';

import {
  rangesFor, emphasisApplies, rangeShare, inRange, emphasisWeight, emphasisPrefer,
  callableRanges, createRangeSelector,
} from '../src/engine/emphasis.js';
import { createSelector, createRng, buildPool } from '../src/engine/selector.js';
import { createLadderSelector, buildLadderPool } from '../src/engine/ladder.js';
import { createDefenseSelector } from '../src/engine/defense.js';
import { createSession } from '../src/engine/session.js';
import { estimateSpeechMs, voiceRate, applyPronunciation } from '../src/engine/timing.js';
import { EMPHASES } from '../src/store/settings.js';

const config = loadConfig();
const SPORTS = ['boxing', 'muaythai', 'kickboxing'];
const c = (sport, display) => ({
  id: `t-${display}`, sport, display, speech: display.replaceAll(' – ', ', '), actions: display.split(' – ').length,
});

/* ---- data ------------------------------------------------------------ */

test('every range has a callout, valid sports and is an emphasis setting', () => {
  const ranges = Object.entries(STRIKES.ranges);
  assert.ok(ranges.length >= 6);
  for (const [name, r] of ranges) {
    assert.ok(EMPHASES.includes(name), `${name} is not in EMPHASES`);
    assert.ok(typeof r.callout === 'string' && r.callout.trim(), name);
    for (const s of r.sports) assert.ok(SPORTS.includes(s), `${name}: ${s}`);
  }
});

test('the four named ranges for Muay Thai, three for kickboxing, inside/outside for boxing', () => {
  const names = (sport) => rangesFor(sport, STRIKES).map((r) => r.name);
  assert.deepEqual(names('muaythai'), ['kicking', 'punching', 'close', 'clinch']);
  assert.deepEqual(names('kickboxing'), ['kicking', 'punching', 'close']);
  assert.deepEqual(names('boxing'), ['outside', 'inside']);
  assert.equal(emphasisApplies('clinch', 'kickboxing', STRIKES), false);
  assert.equal(emphasisApplies('inside', 'muaythai', STRIKES), false);
  assert.equal(emphasisApplies('kicking', 'boxing', STRIKES), false);
  for (const sport of SPORTS) {
    for (const e of ['off', 'levels', 'ranges']) assert.equal(emphasisApplies(e, sport, STRIKES), true);
  }
});

test('every shipped combo strike classifies into a range of its own sport', () => {
  for (const combo of COMBOS) {
    const own = new Set(rangesFor(combo.sport, STRIKES).map((r) => r.name));
    const total = [...own].reduce((sum, r) => sum + rangeShare(combo, r, STRIKES), 0);
    // Shares over the sport's ranges add up to 1, or 0 for a combo of only
    // defence and footwork.
    assert.ok(Math.abs(total - 1) < 1e-9 || total === 0, `${combo.id}: ${total}`);
  }
});

test('the new combos give Muay Thai clinch and every sport close work to call', () => {
  const pool = (sport, tier) => buildPool(COMBOS, { sport, tier });
  const count = (sport, tier, range) => pool(sport, tier).filter((x) => rangeShare(x, range, STRIKES) > 0).length;
  assert.ok(count('muaythai', 'intermediate', 'clinch') >= 6);
  assert.ok(count('muaythai', 'advanced', 'clinch') >= 10);
  assert.ok(count('kickboxing', 'beginner', 'close') >= 6);
  assert.ok(count('muaythai', 'beginner', 'close') >= 6);
});

/* ---- weights --------------------------------------------------------- */

test('share counts strikes only, from the combo\'s own ranges', () => {
  assert.equal(rangeShare(c('muaythai', 'Lead teep – Cross – Rear knee'), 'kicking', STRIKES), 1 / 3);
  assert.equal(rangeShare(c('muaythai', 'Lead elbow – Rear knee'), 'close', STRIKES), 1);
  assert.equal(rangeShare(c('muaythai', 'Jab – Cross – Roll – Lead hook'), 'punching', STRIKES), 1);
  assert.equal(rangeShare(c('boxing', 'Jab – Cross – Lead hook – Rear uppercut'), 'inside', STRIKES), 0.5);
  assert.equal(rangeShare(c('boxing', 'Jab – Cross'), 'punching', STRIKES), 0);
  assert.equal(rangeShare(c('muaythai', 'Flying armbar'), 'close', STRIKES), 0);
});

test('knees and elbows after a clinch entry are clinch work', () => {
  const clinch = (d) => rangeShare(c('muaythai', d), 'clinch', STRIKES);
  assert.equal(clinch('Clinch – Rear knee – Lead knee'), 1);
  assert.equal(clinch('Jab – Cross – Clinch – Rear knee'), 0.5);
  assert.equal(clinch('Rear elbow – Clinch – Lead knee'), 2 / 3);   // the elbow came first
  assert.equal(rangeShare(c('muaythai', 'Rear elbow – Clinch – Lead knee'), 'close', STRIKES), 1 / 3);
  assert.equal(inRange(c('muaythai', 'Jab – Cross – Clinch – Rear knee'), 'clinch', STRIKES), true);
  assert.equal(inRange(c('muaythai', 'Jab – Cross – Rear knee'), 'close', STRIKES), false);
});

test('range calls prefer combos mostly in range, then any strike from it', () => {
  const cursor = { current: 'kicking' };
  const [mostly, any] = emphasisPrefer('ranges', { strikes: STRIKES, cursor });
  const kicks = c('muaythai', 'Lead teep – Rear body kick');
  const oneKick = c('muaythai', 'Jab – Cross – Lead hook – Rear low kick');
  const hands = c('muaythai', 'Jab – Cross');
  assert.deepEqual([mostly(kicks), mostly(oneKick), mostly(hands)], [true, false, false]);
  assert.deepEqual([any(kicks), any(oneKick), any(hands)], [true, true, false]);
  cursor.current = null;
  assert.ok(mostly(hands) && any(hands), 'no range yet: everything');
});

test('a fixed range weighs 1 + k × share; one the sport lacks weighs everything the same', () => {
  const k = config.emphasis.rangePerShare;
  const close = emphasisWeight('close', { strikes: STRIKES, config });
  assert.equal(close(c('muaythai', 'Jab – Cross')), 1);
  assert.equal(close(c('muaythai', 'Lead elbow – Rear knee')), 1 + k);
  assert.equal(close(c('muaythai', 'Jab – Rear knee')), 1 + k / 2);
  const clinch = emphasisWeight('clinch', { strikes: STRIKES, config });
  for (const combo of COMBOS.filter((x) => x.sport === 'boxing')) assert.equal(clinch(combo), 1);
  assert.equal(emphasisPrefer('close', { strikes: STRIKES, cursor: { current: 'close' } }), null);
});

/** Mean share of `range`, and the fraction of calls with any of it, over many draws. */
function lean(sport, tier, emphasis, range) {
  const sel = createSelector({ combos: COMBOS, sport, tier, config, rng: createRng(11), emphasis });
  let share = 0;
  let hits = 0;
  const N = 1500;
  for (let i = 0; i < N; i++) {
    const x = rangeShare(sel.next(), range, STRIKES);
    share += x;
    if (x > 0) hits += 1;
  }
  return { share: share / N, hits: hits / N };
}

test('a fixed range calls more of that range, in every sport, without shrinking the pool', () => {
  const cases = [
    ['muaythai', 'kicking'], ['muaythai', 'punching'], ['muaythai', 'close'], ['muaythai', 'clinch'],
    ['kickboxing', 'kicking'], ['kickboxing', 'close'], ['boxing', 'inside'], ['boxing', 'outside'],
  ];
  for (const [sport, range] of cases) {
    const off = lean(sport, 'advanced', 'off', range);
    const on = lean(sport, 'advanced', range, range);
    assert.ok(on.share > off.share + 0.05, `${sport} ${range} share: ${on.share.toFixed(3)} vs ${off.share.toFixed(3)}`);
    // Combos with any of the range: what you notice on the bag. Boxing
    // already has an inside strike in most combos, so ask for less there.
    const room = Math.min(0.05, (1 - off.hits) * 0.3);
    assert.ok(on.hits > off.hits + room, `${sport} ${range} calls: ${on.hits.toFixed(3)} vs ${off.hits.toFixed(3)}`);
  }
  const args = { combos: COMBOS, sport: 'muaythai', tier: 'beginner', config, rng: createRng(1) };
  assert.equal(createSelector({ ...args, emphasis: 'clinch' }).pool.length, createSelector({ ...args, emphasis: 'off' }).pool.length);
});

/* ---- range calls ----------------------------------------------------- */

test('only ranges the pool can feed are called', () => {
  const names = (sport, tier, focus) => callableRanges(buildPool(COMBOS, { sport, tier, focus }), sport, STRIKES, 4)
    .map((r) => r.name);
  assert.deepEqual(names('muaythai', 'advanced'), ['kicking', 'punching', 'close', 'clinch']);
  assert.ok(!names('muaythai', 'beginner').includes('clinch'), 'beginner Muay Thai has too little clinch');
  assert.deepEqual(names('boxing', 'beginner'), ['outside', 'inside']);
  assert.ok(!names('muaythai', 'advanced', 'hands').includes('kicking'), 'a Hands focus has no kicks');
});

function rangeSelector(sport, tier, { seed = 5, inner, every } = {}) {
  const cursor = { current: null };
  const args = { combos: COMBOS, sport, tier, config, rng: createRng(seed), emphasis: 'ranges', rangeCursor: cursor };
  const base = inner ? inner(args) : createSelector(args);
  const ranges = callableRanges(base.pool, sport, STRIKES, 4);
  return { cursor, ranges, sel: createRangeSelector(base, { ranges, cursor, rng: createRng(seed + 100), every }) };
}

test('range calls open with a call, move every 3–5 combos to a different range, and draw for it', () => {
  for (const [sport, tier] of [['muaythai', 'advanced'], ['kickboxing', 'intermediate'], ['boxing', 'beginner']]) {
    const { sel } = rangeSelector(sport, tier);
    const draws = Array.from({ length: 400 }, () => sel.next());
    assert.equal(draws[0].rangeCall, true, `${sport}: the first combo is announced`);
    let run = 0;
    let prev = null;
    let off = 0;
    for (const [i, d] of draws.entries()) {
      assert.ok(d.range?.callout, `${sport}: every combo carries its range`);
      if (d.rangeCall) {
        if (i > 0) assert.ok(run >= 3 && run <= 5, `${sport}: ${run} combos in a range`);
        assert.notEqual(d.range.name, prev, `${sport}: called the same range twice running`);
        prev = d.range.name;
        run = 0;
      } else {
        assert.equal(d.range.name, prev);
      }
      run += 1;
      if (rangeShare(d, d.range.name, STRIKES) === 0) off += 1;
    }
    // Only a range whose combos are all in the no-repeat window falls back.
    assert.ok(off / draws.length < 0.1, `${sport}: ${off} of ${draws.length} combos missed the called range`);
  }
});

test('the combo right after a call is thrown mostly from that range', () => {
  for (const [sport, tier] of [['muaythai', 'advanced'], ['kickboxing', 'advanced'], ['boxing', 'intermediate']]) {
    const { sel } = rangeSelector(sport, tier, { seed: 8 });
    let calls = 0;
    let mostly = 0;
    for (let i = 0; i < 600; i++) {
      const d = sel.next();
      if (!d.rangeCall) continue;
      calls += 1;
      if (inRange(d, d.range.name, STRIKES)) mostly += 1;
    }
    assert.ok(mostly / calls > 0.9, `${sport}: ${mostly} of ${calls}`);
  }
});

test('every callable range gets called', () => {
  const { sel, ranges } = rangeSelector('muaythai', 'advanced');
  const called = new Set();
  for (let i = 0; i < 300; i++) { const d = sel.next(); if (d.rangeCall) called.add(d.range.name); }
  assert.deepEqual([...called].sort(), ranges.map((r) => r.name).sort());
});

test('a new round opens with a fresh range call', () => {
  const { sel } = rangeSelector('muaythai', 'advanced');
  sel.next(); sel.next();
  const before = sel.next().range.name;
  sel.startRound();
  const first = sel.next();
  assert.equal(first.rangeCall, true);
  assert.notEqual(first.range.name, before);
});

test('ladders change range only between climbs', () => {
  const { sel } = rangeSelector('muaythai', 'advanced', {
    inner: (args) => createLadderSelector({ ...args, reps: 1 }),
  });
  assert.equal(sel.pool.length, buildLadderPool(COMBOS, { sport: 'muaythai', tier: 'advanced' }).length);
  for (let i = 0; i < 500; i++) {
    const rung = sel.next();
    if (rung.rangeCall) assert.equal(rung.ladder.rung, 1, 'a range call mid-climb');
  }
});

test('with fewer than two callable ranges nothing is called', () => {
  const cursor = { current: null };
  const base = createSelector({ combos: COMBOS, sport: 'muaythai', tier: 'beginner', config, rng: createRng(2), emphasis: 'ranges', rangeCursor: cursor });
  const sel = createRangeSelector(base, { ranges: rangesFor('muaythai', STRIKES).slice(0, 1), cursor, rng: createRng(3) });
  for (let i = 0; i < 50; i++) assert.equal(sel.next().rangeCall, undefined);
  assert.equal(cursor.current, null);
});

test('defense mode wraps range calls and keeps both', () => {
  const { sel } = rangeSelector('muaythai', 'advanced');
  const def = createDefenseSelector(sel, { moves: config.moves.defense, strikes: STRIKES, rng: createRng(9) });
  const draws = Array.from({ length: 40 }, () => def.next());
  assert.equal(draws[0].rangeCall, true);
  assert.ok(draws.filter((d) => d.defense).length > 30);
  assert.ok(draws.every((d) => d.range));
});

/* ---- session --------------------------------------------------------- */

const BASE = {
  sport: 'muaythai', tier: 'advanced', intensity: 'hard', roundLengthMin: 1,
  roundsPerWorkout: 3, restBetweenRoundsSec: 10, countdownSec: 0, voiceSpeedPct: 75,
  workoutMode: 'random', emphasis: 'ranges',
};

/** Fake-clock driver, as in defense.test.js: speech lasts what the engine estimates. */
function createDriver({ settings = {}, seed = 1, stepMs = 25 } = {}) {
  const s = { ...BASE, ...settings };
  const rate = voiceRate(s.voiceSpeedPct, config.voiceRateRange);
  const session = createSession({ config, settings: s, combos: COMBOS, rng: createRng(seed) });
  const d = { session, rate, log: [], t: 0, summary: null };
  let speechEndsAt = null;
  let lastSay = null;
  const push = (events) => {
    for (const e of events) {
      const entry = { t: d.t, ...e };
      d.log.push(entry);
      if (e.type === 'say' && ['combo', 'defense', 'range'].includes(e.tag)) {
        speechEndsAt = d.t + estimateSpeechMs(e.text, rate, config.speechEstimate);
        lastSay = entry;
      } else if (e.type === 'cancelSpeech') speechEndsAt = null;
      else if (e.type === 'finished') d.summary = e.summary;
    }
  };
  d.step = () => {
    d.t += stepMs;
    if (speechEndsAt !== null && d.t >= speechEndsAt) {
      speechEndsAt = null;
      if (lastSay) lastSay.ended = d.t;
      push(session.speechEnded(d.t));
    }
    push(session.tick(d.t));
  };
  d.runUntil = (pred, maxMs = 30 * 60 * 1000) => {
    const limit = d.t + maxMs;
    while (!pred() && d.t < limit && !d.summary) d.step();
    return pred();
  };
  d.finish = () => { d.runUntil(() => false); return d; };
  push(session.start(0));
  push(session.ready(0));
  return d;
}

test('a range call is said, then after the move beat its combo, which alone counts as a call', () => {
  const { log, summary } = createDriver().finish();
  const ranges = log.filter((e) => e.type === 'range');
  const combos = log.filter((e) => e.type === 'combo');
  assert.ok(ranges.length >= 3, 'at least one call per round');
  assert.equal(summary.combosCalled, combos.length);
  assert.equal(summary.emphasis, 'ranges');
  log.forEach((e, i) => {
    if (e.type !== 'range') return;
    const say = log[i + 1];
    assert.equal(say.tag, 'range');
    assert.equal(say.text, applyPronunciation(e.range.callout, config.pronunciation));
    const next = log.slice(i + 2).find((x) => x.type === 'combo' || x.type === 'bell');
    assert.equal(next.type, 'combo', 'the bell never falls between a range call and its combo');
    assert.equal(next.combo.range.name, e.range.name);
    const wait = next.t - say.ended;
    assert.ok(wait >= config.emphasis.rangeCallMoveMs && wait < config.emphasis.rangeCallMoveMs + 100, `beat ${wait}`);
  });
});

test('each round opens with a range call', () => {
  const { log } = createDriver().finish();
  let inRound = false;
  let first = true;
  for (const e of log) {
    if (e.type === 'bell') { inRound = !inRound; first = true; continue; }
    if (!inRound) continue;
    if (first && (e.type === 'range' || e.type === 'combo')) {
      assert.equal(e.type, 'range');
      first = false;
    }
  }
});

test('a pause during a range call calls the range again on resume', () => {
  const d = createDriver();
  d.runUntil(() => d.log.some((e) => e.type === 'range'));
  const called = d.log.filter((e) => e.type === 'range').length;
  d.session.pause(d.t);
  d.t += 5000;
  d.session.resume(d.t);
  d.runUntil(() => d.log.some((e) => e.type === 'combo'));
  assert.equal(d.log.filter((e) => e.type === 'range').length, called + 1);
});

test('range calls work in every mode and stay off the finisher', () => {
  for (const workoutMode of ['random', 'ladder', 'defense', 'footwork']) {
    const { log, summary } = createDriver({ settings: { workoutMode, finisherSec: 15 } }).finish();
    assert.ok(log.some((e) => e.type === 'range'), workoutMode);
    assert.ok(summary.combosCalled > 0, workoutMode);
  }
});

test('other emphases call no ranges', () => {
  for (const emphasis of ['off', 'levels', 'close']) {
    const { log } = createDriver({ settings: { emphasis } }).finish();
    assert.equal(log.filter((e) => e.type === 'range').length, 0, emphasis);
  }
});
