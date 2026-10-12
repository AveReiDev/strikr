import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, STRIKES, MOVES, COMBOS } from './fixtures.js';

import { strikeKeys, defensesFor, createDefenseSelector } from '../src/engine/defense.js';
import { classifyCombo } from '../src/engine/strikes.js';
import { createSelector, createRng } from '../src/engine/selector.js';
import { createSession, STATES } from '../src/engine/session.js';
import { estimateSpeechMs, voiceRate, gapMsFor, applyPronunciation } from '../src/engine/timing.js';

const config = loadConfig();
const MOVE_LIST = MOVES.defense;
const SPORTS = ['boxing', 'muaythai', 'kickboxing'];

const combo = (sport, display) => ({ id: `t-${display}`, sport, display, speech: display.replaceAll(' – ', ', '), actions: display.split(' – ').length });
const namesFor = (sport, display) => defensesFor(combo(sport, display), MOVE_LIST, STRIKES).map((m) => m.name);
const endsOnDefenseOrFootwork = (c) => {
  const parts = classifyCombo(c, STRIKES);
  const last = parts[parts.length - 1];
  return !last || last.kind === 'defense' || last.kind === 'footwork';
};

// Moves that make no sense with the hands only: boxing must never be told them.
const KICK_ONLY = ['Check', 'Block', 'Catch', 'Step back', 'Lean back', 'Frame'];

/* ---- strikeKeys ------------------------------------------------------ */

test('strikeKeys lists category, weapon, range, level and weapon-level', () => {
  const keys = strikeKeys({ category: 'rearKick', weapon: 'kick', range: 'kicking', level: 'leg' });
  assert.deepEqual([...keys].sort(), ['kick', 'kick-leg', 'kicking', 'leg', 'rearKick']);
});

test('strikeKeys copes with a missing strike and with absent fields', () => {
  assert.equal(strikeKeys(undefined).size, 0);
  assert.equal(strikeKeys({ weapon: 'knee' }).has('knee-undefined'), false);
});

/* ---- pairing --------------------------------------------------------- */

test('a lead hook is answered with a roll', () => {
  for (const sport of SPORTS) assert.ok(namesFor(sport, 'Jab – Cross – Lead hook').includes('Roll'), sport);
});

test('a jab or cross is answered with a slip or a parry', () => {
  for (const sport of SPORTS) {
    for (const display of ['Jab', 'Jab – Cross', 'Cross – Lead hook – Cross']) {
      const names = namesFor(sport, display);
      assert.ok(names.includes('Slip') && names.includes('Parry'), `${sport}: ${display} -> ${names}`);
      for (const n of names) assert.ok(['Slip', 'Parry', 'Pull back', 'Lean back'].includes(n), `${sport}: ${n}`);
    }
  }
});

test('an uppercut ending gets cover or pull back, not a slip', () => {
  const names = namesFor('boxing', 'Jab – Cross – Rear uppercut');
  assert.ok(names.includes('Cover') && names.includes('Pull back'));
  assert.ok(!names.includes('Slip'));
});

test('a rear low kick in Muay Thai is answered with a check', () => {
  const names = namesFor('muaythai', 'Jab – Cross – Rear low kick');
  assert.ok(names.includes('Check'));
  assert.ok(!names.includes('Block'), 'block is for the body');
});

test('a body kick is blocked or caught, a head kick is leaned away from', () => {
  const body = namesFor('muaythai', 'Jab – Cross – Rear body kick');
  assert.ok(body.includes('Block') && body.includes('Catch'));
  assert.ok(namesFor('muaythai', 'Jab – Cross – Rear high kick').includes('Lean back'));
});

test('a combo takes its defense from the last strike only', () => {
  const names = namesFor('muaythai', 'Rear low kick – Jab – Cross – Lead hook');
  assert.ok(names.includes('Roll'));
  assert.ok(!names.includes('Check'));
});

test('a trailing stage direction is ignored when picking the last strike', () => {
  assert.deepEqual(namesFor('muaythai', 'Jab – Cross – Lead hook (land switched)'), namesFor('muaythai', 'Jab – Cross – Lead hook'));
});

test('boxing never gets a kick-only defense, even from a fallback', () => {
  for (const display of ['Jab – Cross – Lead hook', 'Jab', 'Cross – Rear uppercut', 'Mystery strike']) {
    const names = namesFor('boxing', display);
    assert.ok(names.length > 0, display);
    for (const n of names) assert.ok(!KICK_ONLY.includes(n), `${display} -> ${n}`);
  }
  for (const c of COMBOS.filter((x) => x.sport === 'boxing')) {
    for (const m of defensesFor(c, MOVE_LIST, STRIKES)) assert.ok(!KICK_ONLY.includes(m.name), `${c.display} -> ${m.name}`);
  }
});

test('catch and frame are Muay Thai only', () => {
  for (const sport of ['boxing', 'kickboxing']) {
    for (const c of COMBOS.filter((x) => x.sport === sport)) {
      const names = defensesFor(c, MOVE_LIST, STRIKES).map((m) => m.name);
      assert.ok(!names.includes('Catch') && !names.includes('Frame'), `${sport}: ${c.display} -> ${names}`);
    }
    for (const m of ['Mystery strike']) {
      const names = namesFor(sport, m);
      assert.ok(!names.includes('Catch') && !names.includes('Frame'), sport);
    }
  }
  // ...and Muay Thai does get them.
  assert.ok(namesFor('muaythai', 'Jab – Cross – Rear body kick').includes('Catch'));
  assert.ok(namesFor('muaythai', 'Jab – Cross – Rear knee').includes('Frame'));
});

test('a combo already ending in a defense gets no defense', () => {
  assert.deepEqual(namesFor('muaythai', 'Jab – Cross – Rear knee – Frame off'), []);
  assert.deepEqual(namesFor('muaythai', 'Jab – Cross – Slip'), []);
});

test('a combo already ending in footwork gets no defense', () => {
  assert.deepEqual(namesFor('muaythai', 'Long jab – Step back'), []);
  assert.deepEqual(namesFor('boxing', 'Jab – Cross – Pivot out'), []);
});

test('an unrecognised last strike falls back to every move for the sport', () => {
  const forSport = (sport) => MOVE_LIST.filter((m) => !m.sports || m.sports.includes(sport)).map((m) => m.name);
  for (const sport of SPORTS) assert.deepEqual(namesFor(sport, 'Flurble'), forSport(sport), sport);
  assert.ok(namesFor('muaythai', 'Flurble').length > namesFor('boxing', 'Flurble').length);
});

test('an unrecognised last strike after a known one still falls back to every move', () => {
  const all = MOVE_LIST.filter((m) => !m.sports || m.sports.includes('boxing')).map((m) => m.name);
  assert.deepEqual(namesFor('boxing', 'Jab – Flurble'), all);
});

test('no moves at all means no defense, not a crash', () => {
  assert.deepEqual(defensesFor(combo('muaythai', 'Jab – Cross'), undefined, STRIKES), []);
  assert.deepEqual(defensesFor(combo('muaythai', 'Jab – Cross'), [], STRIKES), []);
});

/* ---- data lint ------------------------------------------------------- */

test('every defense in moves.json has a name and a non-empty after list', () => {
  assert.ok(MOVE_LIST.length > 0);
  const seen = new Set();
  for (const m of MOVE_LIST) {
    assert.ok(typeof m.name === 'string' && m.name.trim(), `name: ${JSON.stringify(m)}`);
    assert.ok(Array.isArray(m.after) && m.after.length > 0, `${m.name} has no after`);
    assert.ok(!seen.has(m.name), `duplicate move ${m.name}`);
    seen.add(m.name);
    if (m.sports) {
      assert.ok(Array.isArray(m.sports) && m.sports.length > 0, `${m.name} has an empty sports list`);
      for (const s of m.sports) assert.ok(SPORTS.includes(s), `${m.name}: unknown sport ${s}`);
    }
  }
});

test('every after key is something strikeKeys can produce for a shipped strike', () => {
  const producible = new Set();
  for (const c of COMBOS) {
    for (const p of classifyCombo(c, STRIKES)) if (p.kind === 'strike') for (const k of strikeKeys(p)) producible.add(k);
  }
  for (const m of MOVE_LIST) {
    for (const key of m.after) assert.ok(producible.has(key), `${m.name}: "${key}" matches no strike in combos.json (typo?)`);
  }
});

test('every move is chosen for at least one shipped combo in its sports', () => {
  for (const m of MOVE_LIST) {
    const used = COMBOS.some((c) => (!m.sports || m.sports.includes(c.sport))
      && defensesFor(c, MOVE_LIST, STRIKES).some((d) => d.name === m.name));
    assert.ok(used, `${m.name} is never offered for any shipped combo`);
  }
});

test('every shipped combo gets a defense unless it ends in defense or footwork', () => {
  for (const sport of SPORTS) {
    const inSport = COMBOS.filter((c) => c.sport === sport && !c.single);
    assert.ok(inSport.length > 0, sport);
    for (const c of inSport) {
      const options = defensesFor(c, MOVE_LIST, STRIKES);
      if (endsOnDefenseOrFootwork(c)) assert.equal(options.length, 0, `${c.id} "${c.display}" ends on a defense/footwork move`);
      else assert.ok(options.length > 0, `${c.id} "${c.display}" has no defense option`);
    }
  }
});

test('every defense option is allowed in the combo\'s sport', () => {
  for (const c of COMBOS) {
    for (const m of defensesFor(c, MOVE_LIST, STRIKES)) {
      assert.ok(!m.sports || m.sports.includes(c.sport), `${c.id}: ${m.name}`);
    }
  }
});

/* ---- createDefenseSelector ------------------------------------------- */

function innerFor({ sport = 'muaythai', tier = 'advanced', seed = 3 } = {}) {
  return createSelector({ combos: COMBOS, sport, tier, config, rng: createRng(seed) });
}
const defSel = (inner, seed = 9) => createDefenseSelector(inner, { moves: MOVE_LIST, strikes: STRIKES, rng: createRng(seed) });

/** An inner selector that replays a fixed list, with spies for pass-through. */
function stubInner(list) {
  let i = 0;
  const calls = { startRound: 0 };
  return {
    calls,
    pool: ['pool-marker'],
    recent: ['recent-marker'],
    startRound() { calls.startRound += 1; },
    next() { return list[i++ % list.length]; },
  };
}

test('the same seed gives the same combos and defenses', () => {
  const run = () => {
    const sel = defSel(innerFor({ seed: 5 }), 11);
    return Array.from({ length: 60 }, () => { const c = sel.next(); return [c.id, c.defense?.name ?? null]; });
  };
  assert.deepEqual(run(), run());
});

test('a different defense seed changes the defenses', () => {
  const run = (seed) => {
    const sel = defSel(innerFor({ seed: 5 }), seed);
    return Array.from({ length: 60 }, () => sel.next().defense?.name ?? null);
  };
  assert.notDeepEqual(run(1), run(2));
});

test('the same defense is never called twice in a row when another fits', () => {
  for (const sport of SPORTS) {
    const sel = defSel(innerFor({ sport, seed: 4 }), 21);
    let prev = null;
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      const c = sel.next();
      if (!c.defense) continue;
      const options = defensesFor(c, MOVE_LIST, STRIKES);
      if (options.length > 1 && prev !== null) {
        assert.notEqual(c.defense.name, prev, `${sport} #${i}: ${c.display}`);
        compared += 1;
      }
      prev = c.defense.name;
    }
    assert.ok(compared > 100, `${sport} compared ${compared}`);
  }
});

test('two options alternate strictly, a lone option may repeat', () => {
  const two = [combo('muaythai', 'Jab – Rear low kick')];   // Check, Step back
  const sel = defSel(stubInner(two));
  const names = Array.from({ length: 12 }, () => sel.next().defense.name);
  assert.deepEqual([...new Set(names)].sort(), ['Check', 'Step back']);
  names.slice(1).forEach((n, i) => assert.notEqual(n, names[i]));

  const lone = createDefenseSelector(stubInner([combo('boxing', 'Jab')]), {
    moves: [{ name: 'Slip', after: ['jab'] }], strikes: STRIKES, rng: createRng(1),
  });
  assert.deepEqual(Array.from({ length: 4 }, () => lone.next().defense.name), ['Slip', 'Slip', 'Slip', 'Slip']);
});

test('the defense fits the combo it is attached to', () => {
  const sel = defSel(innerFor({ seed: 8 }), 2);
  for (let i = 0; i < 200; i++) {
    const c = sel.next();
    const allowed = defensesFor(c, MOVE_LIST, STRIKES).map((m) => m.name);
    if (allowed.length) assert.ok(allowed.includes(c.defense.name), `${c.display} -> ${c.defense.name}`);
    else assert.equal(c.defense, undefined, c.display);
  }
});

test('the combo keeps its own id and fields', () => {
  const original = combo('muaythai', 'Jab – Cross – Lead hook');
  const out = defSel(stubInner([original])).next();
  assert.equal(out.id, original.id);
  assert.equal(out.display, original.display);
  assert.equal(out.speech, original.speech);
  assert.equal(out.actions, original.actions);
  assert.equal(original.defense, undefined, 'the inner combo is not mutated');
});

test('a defense is a one-action call, spoken as its name unless it has a speech', () => {
  const out = createDefenseSelector(stubInner([combo('boxing', 'Jab')]), {
    moves: [{ name: 'Slip', after: ['jab'] }, { name: 'Roll', speech: 'Roll under', after: ['hook'] }], strikes: STRIKES, rng: createRng(1),
  }).next();
  assert.deepEqual(out.defense, { name: 'Slip', speech: 'Slip', actions: 1 });

  const spoken = createDefenseSelector(stubInner([combo('boxing', 'Lead hook')]), {
    moves: [{ name: 'Roll', speech: 'Roll under', after: ['hook'] }], strikes: STRIKES, rng: createRng(1),
  }).next();
  assert.deepEqual(spoken.defense, { name: 'Roll', speech: 'Roll under', actions: 1 });
});

test('a combo that already ends on defense or footwork comes back untouched', () => {
  const c = combo('muaythai', 'Jab – Cross – Rear knee – Frame off');
  const out = defSel(stubInner([c])).next();
  assert.equal(out, c);
  assert.ok(!('defense' in out));
});

test('pool, recent and startRound pass through to the inner selector', () => {
  const inner = stubInner([combo('boxing', 'Jab')]);
  const sel = defSel(inner);
  assert.deepEqual(sel.pool, ['pool-marker']);
  assert.deepEqual(sel.recent, ['recent-marker']);
  sel.startRound();
  sel.startRound();
  assert.equal(inner.calls.startRound, 2);
});

test('pool and recent follow a real inner selector as it draws', () => {
  const inner = innerFor();
  const sel = defSel(inner);
  assert.equal(sel.pool, inner.pool);
  const first = sel.next();
  assert.deepEqual(sel.recent, [first.id]);
  assert.deepEqual(sel.recent, inner.recent);
});

test('startRound is optional on the inner selector', () => {
  const inner = { pool: [], recent: [], next: () => null };
  assert.doesNotThrow(() => defSel(inner).startRound());
});

test('an exhausted inner selector gives null', () => {
  assert.equal(defSel({ pool: [], recent: [], next: () => null }).next(), null);
});

/* ---- session in defense mode ----------------------------------------- */

const BASE = {
  sport: 'muaythai', tier: 'advanced', intensity: 'hard', roundLengthMin: 1,
  roundsPerWorkout: 3, restBetweenRoundsSec: 10, countdownSec: 0, voiceSpeedPct: 75,
  workoutMode: 'defense',
};

/**
 * Fake-clock driver. Speech lasts what the engine estimates and the driver
 * reports its end for combo AND defense calls, as main.js does. Every entry in
 * `log` carries the time `t` it was emitted; says also get `ended`, the time
 * speechEnded() was actually called for them.
 */
function createDriver({ settings = {}, seed = 1, stepMs = 25, combos = COMBOS } = {}) {
  const s = { ...BASE, ...settings };
  const rate = voiceRate(s.voiceSpeedPct, config.voiceRateRange);
  const session = createSession({ config, settings: s, combos, rng: createRng(seed) });
  const d = { session, settings: s, rate, log: [], t: 0, summary: null };
  let speechEndsAt = null;
  let lastSay = null;

  const push = (events) => {
    for (const e of events) {
      const entry = { t: d.t, ...e };
      d.log.push(entry);
      if (e.type === 'say' && (e.tag === 'combo' || e.tag === 'defense')) {
        speechEndsAt = d.t + estimateSpeechMs(e.text, rate, config.speechEstimate);
        lastSay = entry;
      } else if (e.type === 'cancelSpeech') {
        speechEndsAt = null;
      } else if (e.type === 'finished') {
        d.summary = e.summary;
      }
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
  d.pause = () => push(session.pause(d.t));
  d.resume = () => push(session.resume(d.t));
  d.finish = () => { d.runUntil(() => false); return d; };
  d.speaking = () => speechEndsAt !== null;
  push(session.start(0));
  push(session.ready(0));
  return d;
}

const runWorkout = (opts) => createDriver(opts).finish();
const only = (log, type) => log.filter((e) => e.type === type);
const says = (log, tag) => log.filter((e) => e.type === 'say' && e.tag === tag);

/** Splits the log into rounds: [{ start, end, events }], using the bells. */
function roundsOf(log) {
  const out = [];
  let cur = null;
  for (const e of log) {
    if (e.type === 'bell') {
      if (!cur) cur = { start: e.t, end: null, events: [] };
      else { cur.end = e.t; out.push(cur); cur = null; }
    } else if (cur) cur.events.push(e);
  }
  return out;
}

test('every combo is followed by exactly one defense say before the next combo', () => {
  for (const seed of [1, 2, 3]) {
    const { log, settings } = runWorkout({ seed });
    const rounds = roundsOf(log);
    assert.equal(rounds.length, settings.roundsPerWorkout);
    let withDefense = 0;
    for (const r of rounds) {
      const seq = r.events.filter((e) => e.type === 'combo' || (e.type === 'say' && e.tag === 'defense'));
      assert.ok(seq.some((e) => e.type === 'combo'), 'round had combos');
      for (let i = 0; i < seq.length; i++) {
        if (seq[i].type !== 'combo') continue;
        const next = seq[i + 1];
        if (seq[i].combo.defense) {
          assert.ok(next && next.type === 'say', `seed ${seed}: "${seq[i].combo.display}" was not followed by its defense`);
          assert.equal(next.text, seq[i].combo.defense.speech);
          withDefense += 1;
        } else {
          assert.ok(!next || next.type === 'combo', `seed ${seed}: "${seq[i].combo.display}" has no defense but one was said`);
        }
      }
      // A defense never comes first or twice in a row.
      seq.forEach((e, i) => { if (e.type === 'say') assert.equal(seq[i - 1]?.type, 'combo'); });
    }
    assert.ok(withDefense > 10, `seed ${seed}: only ${withDefense} defenses`);
  }
});

test('each defense is announced with a defense event, then its say', () => {
  const { log } = runWorkout();
  const defs = only(log, 'defense');
  assert.ok(defs.length > 10);
  for (const e of defs) {
    const i = log.indexOf(e);
    assert.equal(log[i + 1].type, 'say');
    assert.equal(log[i + 1].tag, 'defense');
    assert.equal(log[i + 1].text, applyPronunciation(e.defense.speech, config.pronunciation));
    assert.equal(log[i + 1].t, e.t);
  }
  assert.equal(says(log, 'defense').length, defs.length);
});

test('the defense lands after the combo\'s execution time plus the delay', () => {
  for (const intensity of ['hard', 'medium', 'light']) {
    const { log } = runWorkout({ settings: { intensity, roundsPerWorkout: 2, roundLengthMin: 2 } });
    const per = config.intensity[intensity].perActionMs;
    let checked = 0;
    log.forEach((e, i) => {
      if (e.type !== 'combo' || !e.combo.defense) return;
      const comboSay = log[i + 1];
      const defSay = log.slice(i + 2).find((x) => x.type === 'say' && x.tag === 'defense');
      assert.ok(comboSay.ended !== undefined, 'combo speech ended');
      const earliest = comboSay.ended + per * e.combo.actions + config.defense.delayMs;
      assert.ok(defSay.t >= earliest, `${intensity}: defense at ${defSay.t}, earliest ${earliest}`);
      // And it is not left hanging: the step size is the only slack.
      assert.ok(defSay.t - earliest <= 50, `${intensity}: defense ${defSay.t - earliest}ms late`);
      checked += 1;
    });
    assert.ok(checked > 5, intensity);
  }
});

test('the next combo waits a one-action gap after the defense', () => {
  for (const intensity of ['hard', 'medium']) {
    const { log } = runWorkout({ settings: { intensity, roundLengthMin: 2, roundsPerWorkout: 2 } });
    const { baseGapMs, perActionMs } = config.intensity[intensity];
    const oneAction = gapMsFor({ actions: 1 }, { baseGapMs, perActionMs });
    assert.equal(oneAction, baseGapMs + perActionMs);
    let checked = 0;
    for (const r of roundsOf(log)) {
      const list = r.events.filter((e) => e.type === 'say' && (e.tag === 'combo' || e.tag === 'defense'));
      for (let i = 0; i < list.length - 1; i++) {
        if (list[i].tag !== 'defense') continue;
        assert.equal(list[i + 1].tag, 'combo');
        const earliest = list[i].ended + oneAction;
        assert.ok(list[i + 1].t >= earliest, `${intensity}: next combo at ${list[i + 1].t}, earliest ${earliest}`);
        assert.ok(list[i + 1].t - earliest <= 50, `${intensity}: next combo ${list[i + 1].t - earliest}ms late`);
        checked += 1;
      }
    }
    assert.ok(checked > 5, intensity);
  }
});

test('a combo with no defense keeps the ordinary gap', () => {
  const { log } = runWorkout({ settings: { roundLengthMin: 2 }, seed: 6 });
  const per = config.intensity.hard;
  let checked = 0;
  for (const r of roundsOf(log)) {
    const list = r.events.filter((e) => e.type === 'combo' || (e.type === 'say' && e.tag === 'combo'));
    for (let i = 0; i + 2 < list.length; i += 2) {
      const [c, s, , nextSay] = [list[i], list[i + 1], list[i + 2], list[i + 3]];
      if (c.combo.defense || !nextSay) continue;
      const earliest = s.ended + gapMsFor(c.combo, per);
      assert.ok(nextSay.t >= earliest, `next at ${nextSay.t}, earliest ${earliest}`);
      checked += 1;
    }
  }
  // Muay Thai pools do contain combos that end on a defense/footwork move.
  assert.ok(checked >= 1, 'saw at least one combo without a defense');
});

test('combosCalled counts combos only, not defenses', () => {
  const { log, summary } = runWorkout({ settings: { roundLengthMin: 2 } });
  const combos = only(log, 'combo').length;
  const defenses = only(log, 'defense').length;
  assert.ok(defenses > 10);
  assert.equal(summary.combosCalled, combos);
  assert.ok(summary.combosCalled > defenses - 1, 'defenses are a subset of combo calls');
  assert.equal(says(log, 'combo').length, combos);
  assert.ok(says(log, 'combo').length + says(log, 'defense').length > summary.combosCalled);
});

test('the summary reports defense mode and completes', () => {
  const { summary, log } = runWorkout();
  assert.equal(summary.mode, 'defense');
  assert.equal(summary.completed, true);
  assert.equal(summary.rounds, BASE.roundsPerWorkout);
  assert.equal(log.filter((e) => e.type === 'state' && e.to === STATES.COMPLETE).length, 1);
});

test('the bell never cuts off a defense', () => {
  const lookahead = config.roundEndLookaheadMs;
  for (const intensity of ['hard', 'medium', 'light']) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const d = runWorkout({ seed, settings: { intensity, roundLengthMin: 1, roundsPerWorkout: 4, voiceSpeedPct: 40 } });
      const rate = d.rate;
      const rounds = roundsOf(d.log);
      assert.equal(rounds.length, 4);
      for (const r of rounds) {
        const combos = r.events.filter((e) => e.type === 'combo');
        const defSays = r.events.filter((e) => e.type === 'say' && e.tag === 'defense');
        const owed = combos.filter((c) => c.combo.defense);
        assert.equal(defSays.length, owed.length, `${intensity} seed ${seed}: a combo lost its defense`);
        for (const s of defSays) {
          assert.ok(s.t < r.end, `${intensity} seed ${seed}: defense said at/after the bell`);
          // Spoken (estimated) to the end no later than the lookahead allows past the bell.
          const speechEnd = s.t + estimateSpeechMs(s.text, rate, config.speechEstimate);
          assert.ok(speechEnd <= r.end + lookahead + 50, `${intensity} seed ${seed}: defense still talking ${speechEnd - r.end}ms after the bell`);
        }
      }
    }
  }
});

test('the round-end lookahead reserves time for the combo and its defense together', () => {
  const lookahead = config.roundEndLookaheadMs;
  for (const intensity of ['hard', 'medium']) {
    const d = runWorkout({ settings: { intensity, roundLengthMin: 1, roundsPerWorkout: 4 }, seed: 7 });
    const { perActionMs, baseGapMs } = config.intensity[intensity];
    for (const r of roundsOf(d.log)) {
      for (const e of r.events) {
        if (e.type !== 'combo' || !e.combo.defense) continue;
        const left = (r.end - r.start) - (e.t - r.start);
        const comboMs = estimateSpeechMs(applyPronunciation(e.combo.speech, config.pronunciation), d.rate, config.speechEstimate);
        const defMs = estimateSpeechMs(applyPronunciation(e.combo.defense.speech, config.pronunciation), d.rate, config.speechEstimate);
        const need = comboMs + defMs + perActionMs * e.combo.actions + config.defense.delayMs + baseGapMs + perActionMs;
        assert.ok(need <= left + lookahead + 50, `"${e.combo.display}" + ${e.combo.defense.name} needs ${need}ms, round had ${left}ms`);
      }
    }
  }
});

test('finisher combos get no defense', () => {
  for (const seed of [1, 2, 3]) {
    const { log, summary } = runWorkout({ seed, settings: { finisherSec: 20, roundLengthMin: 1, roundsPerWorkout: 3 } });
    assert.equal(summary.finisherSec, 20);
    const rounds = roundsOf(log);
    assert.equal(rounds.length, 3);
    for (const r of rounds) {
      const at = r.events.findIndex((e) => e.type === 'finisher');
      assert.ok(at >= 0, 'finisher announced');
      const before = r.events.slice(0, at);
      const after = r.events.slice(at);
      const finCombos = after.filter((e) => e.type === 'combo');
      assert.ok(finCombos.length >= 3, `seed ${seed}: finisher combos`);
      for (const e of finCombos) {
        assert.ok(e.combo.actions <= config.finisher.maxActions);
        assert.equal(e.combo.defense, undefined, `finisher combo "${e.combo.display}" has a defense`);
      }
      assert.equal(after.filter((e) => e.type === 'defense' || (e.type === 'say' && e.tag === 'defense')).length, 0);
      // The normal part of the round still has them, and the one in flight at the
      // switch is finished off before the finisher is announced.
      assert.ok(before.some((e) => e.type === 'defense'));
      const lastCombo = [...before].reverse().find((e) => e.type === 'combo');
      if (lastCombo?.combo.defense) {
        const defAt = before.findIndex((e, i) => i > before.indexOf(lastCombo) && e.type === 'defense');
        assert.ok(defAt > -1, 'the combo before the finisher still got its defense');
      }
    }
  }
});

test('pausing between a combo and its defense drops that defense', () => {
  for (const when of ['during-combo-speech', 'in-the-gap']) {
    const d = createDriver({ settings: { roundLengthMin: 3, roundsPerWorkout: 1 }, seed: 2 });
    // Find a combo that owes a defense.
    d.runUntil(() => d.log.some((e) => e.type === 'combo' && e.combo.defense));
    const owing = d.log.find((e) => e.type === 'combo' && e.combo.defense);
    assert.ok(owing, 'reached a combo with a defense');
    if (when === 'in-the-gap') {
      d.runUntil(() => !d.speaking());
      for (let i = 0; i < 4; i++) d.step();   // a little way into the beat
    }
    assert.equal(only(d.log, 'defense').length, 0, 'defense not yet said');

    d.pause();
    const pausedAt = d.t;
    for (let i = 0; i < 400; i++) d.step();   // 10 s paused: ticks are ignored
    assert.equal(only(d.log, 'defense').length, 0, 'nothing said while paused');
    d.resume();

    const resumeIdx = d.log.length;
    const resumedAt = d.t;
    assert.ok(resumedAt > pausedAt);
    d.runUntil(() => only(d.log.slice(resumeIdx), 'combo').length >= 3, 3 * 60 * 1000);
    const after = d.log.slice(resumeIdx).filter((e) => e.type === 'combo' || e.type === 'defense');
    assert.ok(after.length >= 3);
    assert.equal(after[0].type, 'combo', `${when}: the next thing said after resume must be a fresh combo, not the owed defense`);
    // From then on every defense belongs to a combo drawn after the resume.
    after.forEach((e, i) => {
      if (e.type !== 'defense') return;
      assert.equal(after[i - 1].type, 'combo');
      assert.equal(e.defense, after[i - 1].combo.defense);
    });
    assert.ok(!after.some((e) => e.type === 'defense' && e.defense === owing.combo.defense && e.t < resumedAt + 1000));
    assert.equal(d.log.slice(resumeIdx).find((e) => e.type === 'combo').combo.id === owing.combo.id, false, 'resumed on a different combo');
  }
});

test('resuming with no defense owed carries on as normal', () => {
  const d = createDriver({ settings: { roundLengthMin: 3, roundsPerWorkout: 1 }, seed: 4 });
  // Pause right after a defense has been spoken and its speech has ended.
  d.runUntil(() => only(d.log, 'defense').length >= 1);
  d.runUntil(() => !d.speaking());
  d.pause();
  d.resume();
  const idx = d.log.length;
  d.runUntil(() => only(d.log.slice(idx), 'defense').length >= 2, 3 * 60 * 1000);
  const after = d.log.slice(idx).filter((e) => e.type === 'combo' || e.type === 'defense');
  assert.equal(after[0].type, 'combo');
  assert.ok(only(d.log.slice(idx), 'defense').length >= 2, 'defenses keep coming after a resume');
});

test('the session gives defense mode the same combos as random for the same seed', () => {
  // Defense mode must not disturb which combos are drawn... only the rng stream
  // is shared, so compare the first combo, which is drawn before any defense pick.
  const a = runWorkout({ seed: 12, settings: { workoutMode: 'defense', roundsPerWorkout: 1 } });
  const b = runWorkout({ seed: 12, settings: { workoutMode: 'random', roundsPerWorkout: 1 } });
  assert.equal(only(a.log, 'combo')[0].combo.id, only(b.log, 'combo')[0].combo.id);
});

test('defense mode works in every sport', () => {
  for (const sport of SPORTS) {
    const { log, summary } = runWorkout({ settings: { sport, tier: 'advanced', roundLengthMin: 2, roundsPerWorkout: 1 }, seed: 3 });
    assert.equal(summary.completed, true, sport);
    assert.ok(only(log, 'defense').length > 5, sport);
    if (sport === 'boxing') {
      for (const e of only(log, 'defense')) assert.ok(!KICK_ONLY.includes(e.defense.name), `${sport}: ${e.defense.name}`);
    }
  }
});

/* ---- random mode is unchanged ---------------------------------------- */

test('random mode never produces defense events or defenses on combos', () => {
  for (const seed of [1, 2, 3]) {
    const { log, summary } = runWorkout({ seed, settings: { workoutMode: 'random', roundLengthMin: 2 } });
    assert.equal(only(log, 'defense').length, 0);
    assert.equal(says(log, 'defense').length, 0);
    assert.ok(only(log, 'combo').length > 10);
    for (const e of only(log, 'combo')) assert.equal(e.combo.defense, undefined);
    assert.equal(summary.mode, 'random');
  }
});

test('a workout with no mode set behaves as random', () => {
  const { log, summary } = runWorkout({ settings: { workoutMode: undefined } });
  assert.equal(only(log, 'defense').length, 0);
  assert.equal(summary.mode, 'random');
});

test('ladder and pyramid modes have no defense either', () => {
  for (const workoutMode of ['ladder', 'pyramid']) {
    const { log } = runWorkout({ settings: { workoutMode, roundLengthMin: 2, roundsPerWorkout: 1 } });
    assert.equal(only(log, 'defense').length, 0, workoutMode);
    assert.ok(only(log, 'combo').length > 3, workoutMode);
  }
});

test('random mode timing is the plain combo gap, with or without the defense code', () => {
  const { log } = runWorkout({ settings: { workoutMode: 'random', roundLengthMin: 2, roundsPerWorkout: 1 }, seed: 5 });
  const list = log.filter((e) => e.type === 'combo' || (e.type === 'say' && e.tag === 'combo'));
  let checked = 0;
  for (let i = 0; i + 3 < list.length; i += 2) {
    const [c, s, , next] = [list[i], list[i + 1], list[i + 2], list[i + 3]];
    const earliest = s.ended + gapMsFor(c.combo, config.intensity.hard);
    assert.ok(next.t >= earliest && next.t - earliest <= 50, `gap off by ${next.t - earliest}`);
    checked += 1;
  }
  assert.ok(checked > 5);
});

test('boxing can circle out after working inside', () => {
  assert.ok(namesFor('boxing', 'Jab – Cross – Lead hook').includes('Circle out'));
  assert.ok(namesFor('boxing', 'Jab – Rear uppercut').includes('Circle out'));
  assert.ok(!namesFor('boxing', 'Jab – Cross').includes('Circle out'));
});
