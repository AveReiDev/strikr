import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, STRIKES, MOVES, COMBOS } from './fixtures.js';

import { footworkFor, withFootwork, createFootworkSelector } from '../src/engine/footwork.js';
import { strikeKeys } from '../src/engine/defense.js';
import { classifyCombo } from '../src/engine/strikes.js';
import { createSelector, createRng } from '../src/engine/selector.js';
import { createSession, STATES } from '../src/engine/session.js';
import { estimateSpeechMs, voiceRate, gapMsFor, applyPronunciation } from '../src/engine/timing.js';
import { createSettingsStore, WORKOUT_MODES } from '../src/store/settings.js';
import { createHistory } from '../src/store/history.js';
import { createStorage, KEYS, SCHEMA_VERSION } from '../src/store/storage.js';

const config = loadConfig();
const MOVE_LIST = MOVES.footwork;
const DEFENSE_LIST = MOVES.defense;
const SPORTS = ['boxing', 'muaythai', 'kickboxing'];

const combo = (sport, display) => ({
  id: `t-${display}`, sport, display,
  speech: display.replaceAll(' – ', ', '),
  actions: display.split(' – ').length,
});
const optionsFor = (sport, display) => footworkFor(combo(sport, display), MOVE_LIST, STRIKES);
const names = (list) => list.map((m) => m.name);
const hasFootwork = (c) => classifyCombo(c, STRIKES).some((p) => p.kind === 'footwork');

/* ---- data lint ------------------------------------------------------- */

test('every footwork move has a unique name, one non-empty before/after list, actions and valid sports', () => {
  assert.ok(Array.isArray(MOVE_LIST) && MOVE_LIST.length > 0);
  const seen = new Set();
  for (const m of MOVE_LIST) {
    assert.ok(typeof m.name === 'string' && m.name.trim(), `name: ${JSON.stringify(m)}`);
    assert.ok(!seen.has(m.name), `duplicate move ${m.name}`);
    seen.add(m.name);

    const hasBefore = 'before' in m;
    const hasAfter = 'after' in m;
    assert.ok(hasBefore !== hasAfter, `${m.name} must have exactly one of before/after`);
    const keys = hasBefore ? m.before : m.after;
    assert.ok(Array.isArray(keys) && keys.length > 0, `${m.name} has an empty or invalid key list`);
    for (const k of keys) assert.ok(typeof k === 'string' && k, `${m.name}: bad key ${JSON.stringify(k)}`);
    assert.equal(new Set(keys).size, keys.length, `${m.name} repeats a key`);

    assert.ok(typeof m.actions === 'number' && Number.isFinite(m.actions) && m.actions > 0, `${m.name}: actions ${m.actions}`);
    if (m.speech !== undefined) assert.ok(typeof m.speech === 'string' && m.speech.trim(), `${m.name}: bad speech`);
    if (m.sports) {
      assert.ok(Array.isArray(m.sports) && m.sports.length > 0, `${m.name} has an empty sports list`);
      for (const s of m.sports) assert.ok(SPORTS.includes(s), `${m.name}: unknown sport ${s}`);
    }
  }
});

test('every key is something strikeKeys can produce for a shipped strike', () => {
  const producible = new Set();
  for (const c of COMBOS) {
    for (const p of classifyCombo(c, STRIKES)) if (p.kind === 'strike') for (const k of strikeKeys(p)) producible.add(k);
  }
  for (const m of MOVE_LIST) {
    for (const key of m.before ?? m.after) assert.ok(producible.has(key), `${m.name}: "${key}" matches no strike in combos.json (typo?)`);
  }
});

test('every footwork name is classified as footwork by the strike dictionary', () => {
  for (const m of MOVE_LIST) {
    for (const sport of SPORTS) {
      const parts = classifyCombo(combo(sport, m.name), STRIKES);
      assert.equal(parts.length, 1, `${m.name} (${sport})`);
      assert.equal(parts[0].kind, 'footwork', `${m.name} (${sport}) is ${parts[0].kind}`);
    }
    if (m.speech) assert.equal(classifyCombo(combo('muaythai', m.speech), STRIKES)[0].kind, 'footwork', `speech "${m.speech}"`);
  }
});

test('only movement exits are shared with the defense list, by design', () => {
  // Pivot out and Step back are both a way off the line after a combo and a
  // defensive answer, so the two lists share them on purpose. Anything else
  // shared is probably a copy-paste slip.
  const defenseNames = new Set(DEFENSE_LIST.map((m) => m.name));
  const shared = MOVE_LIST.filter((m) => defenseNames.has(m.name));
  assert.deepEqual(shared.map((m) => m.name).sort(), ['Pivot out', 'Step back']);
  for (const m of shared) assert.ok(m.after && !m.before, `${m.name} is an exit`);
});

test('every footwork move is offered for at least one shipped combo in its sports', () => {
  for (const m of MOVE_LIST) {
    const used = COMBOS.some((c) => (!m.sports || m.sports.includes(c.sport))
      && (names(footworkFor(c, MOVE_LIST, STRIKES).before).includes(m.name)
        || names(footworkFor(c, MOVE_LIST, STRIKES).after).includes(m.name)));
    assert.ok(used, `${m.name} is never offered for any shipped combo`);
  }
});

/* ---- footworkFor ----------------------------------------------------- */

test('a Muay Thai teep opener can be entered with a shuffle in', () => {
  assert.ok(names(optionsFor('muaythai', 'Lead teep – Cross').before).includes('Shuffle in'));
  assert.ok(names(optionsFor('kickboxing', 'Lead teep – Cross').before).includes('Shuffle in'));
});

test('boxing never gets Shuffle in or Reset stance', () => {
  for (const display of ['Lead teep – Cross', 'Jab – Cross – Lead hook', 'Jab', 'Rear low kick', 'Mystery strike']) {
    const { before, after } = optionsFor('boxing', display);
    for (const n of [...names(before), ...names(after)]) assert.ok(!['Shuffle in', 'Reset stance'].includes(n), `${display} -> ${n}`);
  }
  for (const c of COMBOS.filter((x) => x.sport === 'boxing')) {
    const { before, after } = footworkFor(c, MOVE_LIST, STRIKES);
    for (const m of [...before, ...after]) assert.ok(!m.sports || m.sports.includes('boxing'), `${c.id}: ${m.name}`);
  }
});

test('a punch opener gets step in or slide in, not a shuffle', () => {
  for (const sport of SPORTS) {
    const { before } = optionsFor(sport, 'Jab – Cross');
    assert.deepEqual(names(before), ['Step in', 'Slide in'], sport);
  }
});

test('a combo ending on a hook can pivot out', () => {
  for (const sport of SPORTS) {
    const { after } = optionsFor(sport, 'Jab – Cross – Lead hook');
    assert.ok(names(after).includes('Pivot out'), sport);
  }
  assert.ok(!names(optionsFor('boxing', 'Jab – Cross').after).includes('Pivot out'), 'a cross is not a hook');
});

test('an exit is chosen from the last strike only, an entry from the first only', () => {
  const kickEnd = names(optionsFor('muaythai', 'Jab – Cross – Rear low kick').after);
  assert.ok(kickEnd.includes('Reset stance') && kickEnd.includes('Step back'));
  const punchEnd = names(optionsFor('muaythai', 'Rear low kick – Jab – Cross').after);
  assert.ok(!punchEnd.includes('Reset stance'), 'Reset stance is for kicks');
  const kickStart = names(optionsFor('muaythai', 'Rear low kick – Jab').before);
  assert.ok(!kickStart.includes('Step in'), 'a leg kick opener is not stepped into');
});

test('a combo that already contains footwork gets nothing', () => {
  for (const display of [
    'Long jab – Step back – Pull counter cross – Lead hook',
    'Jab feint – Step in – Rear uppercut – Lead hook',
    'Jab – Cross – Lead hook – Pivot out – Cross',
    'Jab – Cross – Pivot out',
    'Step in – Jab – Cross',
  ]) assert.deepEqual(optionsFor('boxing', display), { before: [], after: [] }, display);

  for (const id of ['bx-adv-10', 'bx-int-10']) {
    const c = COMBOS.find((x) => x.id === id);
    assert.ok(c, id);
    assert.deepEqual(footworkFor(c, MOVE_LIST, STRIKES), { before: [], after: [] }, c.display);
  }
});

test('every shipped combo that contains footwork gets nothing', () => {
  let checked = 0;
  for (const c of COMBOS.filter(hasFootwork)) {
    assert.deepEqual(footworkFor(c, MOVE_LIST, STRIKES), { before: [], after: [] }, `${c.id} "${c.display}"`);
    checked += 1;
  }
  assert.ok(checked >= 4, `only ${checked} combos with footwork`);
});

test('a combo opening with a defense gets no entry, but can get an exit', () => {
  const { before, after } = optionsFor('muaythai', 'Slip – Jab – Cross');
  assert.deepEqual(before, []);
  assert.ok(after.length > 0);
});

test('a combo opening with a feint gets no entry', () => {
  const { before, after } = optionsFor('boxing', 'Jab feint – Jab');
  assert.deepEqual(before, []);
  assert.ok(after.length > 0);
});

test('a combo ending on a defense pairs its exit with the last strike', () => {
  // "Lead hook – Slip": measured against the hook, not the defense.
  const withDefense = names(optionsFor('muaythai', 'Jab – Lead hook – Slip').after);
  assert.deepEqual(withDefense, names(optionsFor('muaythai', 'Jab – Lead hook').after));
  assert.ok(withDefense.includes('Pivot out'));
  // The entry still comes from the opener.
  assert.deepEqual(names(optionsFor('muaythai', 'Jab – Lead hook – Slip').before), names(optionsFor('muaythai', 'Jab – Lead hook').before));
  // Same for a kick followed by a defense.
  assert.ok(names(optionsFor('muaythai', 'Jab – Rear low kick – Check').after).includes('Reset stance'));
});

test('a combo with no strike at all gets nothing, not a crash', () => {
  for (const display of ['Slip', 'Slip – Roll', 'Flurble']) {
    assert.deepEqual(optionsFor('muaythai', display), { before: [], after: [] }, display);
  }
  assert.deepEqual(footworkFor({ sport: 'muaythai', display: '' }, MOVE_LIST, STRIKES), { before: [], after: [] });
});

test('an unrecognised opener gets no entry and an unrecognised ending no exit', () => {
  assert.deepEqual(optionsFor('boxing', 'Flurble – Jab').before, []);
  assert.deepEqual(optionsFor('boxing', 'Jab – Flurble').after, []);
});

test('a trailing stage direction is ignored', () => {
  assert.deepEqual(
    optionsFor('muaythai', 'Jab – Cross – Lead hook (land switched)'),
    optionsFor('muaythai', 'Jab – Cross – Lead hook'),
  );
  assert.deepEqual(
    optionsFor('muaythai', '(southpaw) – Jab – Cross'),
    optionsFor('muaythai', 'Jab – Cross'),
  );
});

test('no moves at all means no footwork, not a crash', () => {
  assert.deepEqual(footworkFor(combo('muaythai', 'Jab – Cross'), undefined, STRIKES), { before: [], after: [] });
  assert.deepEqual(footworkFor(combo('muaythai', 'Jab – Cross'), [], STRIKES), { before: [], after: [] });
});

test('entries come from before-moves and exits from after-moves, in the combo\'s sport', () => {
  for (const c of COMBOS) {
    const { before, after } = footworkFor(c, MOVE_LIST, STRIKES);
    for (const m of before) assert.ok(m.before && !m.after && (!m.sports || m.sports.includes(c.sport)), `${c.id}: entry ${m.name}`);
    for (const m of after) assert.ok(m.after && !m.before && (!m.sports || m.sports.includes(c.sport)), `${c.id}: exit ${m.name}`);
  }
});

test('nearly every shipped combo gets at least one footwork option, in every sport', () => {
  // Combos that already contain footwork get nothing by design, so they are not
  // counted against coverage. Shipped exceptions at the time of writing:
  //   muaythai: mt-adv-07 "Long guard entry – Rear elbow – Clinch – Lead knee – Rear knee – Turn and dump"
  //     (a clinch opener and an unclassified ending match no before/after key)
  //   boxing / kickboxing: none (boxing's 5 empty combos all already contain footwork)
  for (const sport of SPORTS) {
    const eligible = COMBOS.filter((c) => c.sport === sport && !c.single && !hasFootwork(c));
    assert.ok(eligible.length > 20, sport);
    const missing = eligible.filter((c) => {
      const { before, after } = footworkFor(c, MOVE_LIST, STRIKES);
      return !before.length && !after.length;
    });
    const share = 1 - missing.length / eligible.length;
    assert.ok(share >= 0.95, `${sport}: ${(share * 100).toFixed(1)}% covered; missing ${missing.map((c) => `${c.id} "${c.display}"`).join('; ')}`);
  }
});

test('single strikes can be moved to or from as well', () => {
  const singles = COMBOS.filter((c) => c.single);
  assert.ok(singles.length > 0);
  const covered = singles.filter((c) => {
    const { before, after } = footworkFor(c, MOVE_LIST, STRIKES);
    return before.length || after.length;
  });
  assert.ok(covered.length / singles.length >= 0.9, `${covered.length}/${singles.length}`);
});

/* ---- withFootwork ---------------------------------------------------- */

const STEP_IN = { name: 'Step in', before: ['punching'], actions: 1 };
const CIRCLE = { name: 'Circle left', after: ['punching'], actions: 1.5 };

test('an entry goes before the combo in display and speech', () => {
  const c = combo('boxing', 'Jab – Cross');
  const out = withFootwork(c, STEP_IN, 'before');
  assert.equal(out.display, 'Step in – Jab – Cross');
  assert.equal(out.speech, 'Step in, Jab, Cross');
  assert.equal(out.actions, 3);
  assert.deepEqual(out.footwork, { name: 'Step in', position: 'before' });
});

test('an exit goes after the combo in display and speech, with its own actions', () => {
  const c = combo('boxing', 'Jab – Cross');
  const out = withFootwork(c, CIRCLE, 'after');
  assert.equal(out.display, 'Jab – Cross – Circle left');
  assert.equal(out.speech, 'Jab, Cross, Circle left');
  assert.equal(out.actions, 3.5);
  assert.deepEqual(out.footwork, { name: 'Circle left', position: 'after' });
});

test('a move is spoken as its speech when it has one, shown as its name', () => {
  const out = withFootwork(combo('boxing', 'Jab'), { name: 'Step in', speech: 'Step in close', before: ['jab'], actions: 1 }, 'before');
  assert.equal(out.display, 'Step in – Jab');
  assert.equal(out.speech, 'Step in close, Jab');
});

test('a move with no actions counts as one', () => {
  assert.equal(withFootwork(combo('boxing', 'Jab'), { name: 'Step in', before: ['jab'] }, 'before').actions, 2);
});

test('withFootwork keeps the id and other fields, and does not mutate its input', () => {
  const c = { ...combo('boxing', 'Jab – Cross'), tier: 'beginner', tags: ['a'], frequency: 'common' };
  const snapshot = JSON.parse(JSON.stringify(c));
  const move = { ...STEP_IN };
  const moveSnapshot = JSON.parse(JSON.stringify(move));
  for (const position of ['before', 'after']) {
    const out = withFootwork(c, move, position);
    assert.notEqual(out, c);
    assert.equal(out.id, c.id);
    assert.equal(out.sport, c.sport);
    assert.equal(out.tier, 'beginner');
    assert.deepEqual(out.tags, ['a']);
    assert.equal(out.frequency, 'common');
  }
  assert.deepEqual(c, snapshot);
  assert.deepEqual(move, moveSnapshot);
  assert.ok(!('footwork' in c));
});

test('a derived combo still reads as one with the footwork move classified as footwork', () => {
  const out = withFootwork(combo('muaythai', 'Lead teep – Cross'), MOVE_LIST.find((m) => m.name === 'Shuffle in'), 'before');
  const parts = classifyCombo(out, STRIKES);
  assert.deepEqual(parts.map((p) => p.kind), ['footwork', 'strike', 'strike']);
});

/* ---- createFootworkSelector ------------------------------------------ */

function innerFor({ sport = 'muaythai', tier = 'advanced', seed = 3 } = {}) {
  return createSelector({ combos: COMBOS, sport, tier, config, rng: createRng(seed) });
}
const fwSel = (inner, seed = 9, moves = MOVE_LIST) => createFootworkSelector(inner, { moves, strikes: STRIKES, rng: createRng(seed) });

/** An inner selector that replays a fixed list, with spies for pass-through. */
function stubInner(list) {
  let i = 0;
  const calls = { startRound: 0, next: 0 };
  return {
    calls,
    pool: ['pool-marker'],
    recent: ['recent-marker'],
    startRound() { calls.startRound += 1; },
    next() { calls.next += 1; return list[i++ % list.length]; },
  };
}

test('the same seed gives the same combos and footwork', () => {
  const run = () => {
    const sel = fwSel(innerFor({ seed: 5 }), 11);
    return Array.from({ length: 80 }, () => { const c = sel.next(); return [c.id, c.display, c.footwork?.name ?? null, c.footwork?.position ?? null]; });
  };
  assert.deepEqual(run(), run());
});

test('a different footwork seed changes the footwork', () => {
  const run = (seed) => {
    const sel = fwSel(innerFor({ seed: 5 }), seed);
    return Array.from({ length: 80 }, () => sel.next().display);
  };
  assert.notDeepEqual(run(1), run(2));
});

test('the footwork fits the combo it is attached to', () => {
  for (const sport of SPORTS) {
    const sel = fwSel(innerFor({ sport, seed: 8 }), 2);
    let moved = 0;
    for (let i = 0; i < 200; i++) {
      const c = sel.next();
      const original = COMBOS.find((x) => x.id === c.id);
      const { before, after } = footworkFor(original, MOVE_LIST, STRIKES);
      if (c.footwork) {
        const allowed = names(c.footwork.position === 'before' ? before : after);
        assert.ok(allowed.includes(c.footwork.name), `${sport}: ${original.display} -> ${c.footwork.position} ${c.footwork.name}`);
        moved += 1;
      } else {
        assert.deepEqual({ before, after }, { before: [], after: [] }, original.display);
        assert.equal(c, original, 'a combo with no option is passed through as is');
      }
    }
    assert.ok(moved > 150, `${sport}: only ${moved} of 200 had footwork`);
  }
});

test('the derived display and speech wrap the original in the right place', () => {
  const sel = fwSel(innerFor({ seed: 6 }), 4);
  let before = 0;
  let after = 0;
  for (let i = 0; i < 200; i++) {
    const c = sel.next();
    if (!c.footwork) continue;
    const original = COMBOS.find((x) => x.id === c.id);
    const move = MOVE_LIST.find((m) => m.name === c.footwork.name);
    if (c.footwork.position === 'before') {
      assert.equal(c.display, `${move.name} – ${original.display}`);
      assert.equal(c.speech, `${move.speech ?? move.name}, ${original.speech}`);
      before += 1;
    } else {
      assert.equal(c.display, `${original.display} – ${move.name}`);
      assert.equal(c.speech, `${original.speech}, ${move.speech ?? move.name}`);
      after += 1;
    }
    assert.equal(c.actions, original.actions + move.actions);
  }
  assert.ok(before > 20 && after > 20, `before ${before}, after ${after}`);
});

test('entry and exit are chosen about evenly when both are available', () => {
  const both = combo('muaythai', 'Jab – Cross – Lead hook');
  const { before, after } = footworkFor(both, MOVE_LIST, STRIKES);
  assert.ok(before.length > 0 && after.length > 0);
  assert.ok(after.length > before.length, 'exits outnumber entries, so a uniform pick over both lists would not be even');

  const sel = fwSel(stubInner([both]), 17);
  const draws = 2000;
  let entries = 0;
  for (let i = 0; i < draws; i++) if (sel.next().footwork.position === 'before') entries += 1;
  const share = entries / draws;
  assert.ok(share > 0.4 && share < 0.6, `entry share ${share}`);
});

test('the position split follows the rng exactly: below one half is an entry', () => {
  const both = combo('muaythai', 'Jab – Cross – Lead hook');
  const rolls = [0.49, 0, 0.5, 0, 0.99, 0];   // position roll, move roll, ...
  let i = 0;
  const sel = createFootworkSelector(stubInner([both]), { moves: MOVE_LIST, strikes: STRIKES, rng: () => rolls[i++ % rolls.length] });
  assert.equal(sel.next().footwork.position, 'before');
  assert.equal(sel.next().footwork.position, 'after');
  assert.equal(sel.next().footwork.position, 'after');
});

test('only one list available means that list is used, with no position roll wasted', () => {
  // "Slip – Jab – Cross" can only exit; "Jab" under a before-only list can only enter.
  // (Muay Thai: boxing swaps the 'punching' range for inside/outside.)
  const exitOnly = fwSel(stubInner([combo('muaythai', 'Slip – Jab – Cross')]));
  for (let i = 0; i < 20; i++) assert.equal(exitOnly.next().footwork.position, 'after');

  const entryOnly = fwSel(stubInner([combo('muaythai', 'Jab')]), 1, [STEP_IN]);
  for (let i = 0; i < 20; i++) assert.equal(entryOnly.next().footwork.position, 'before');
});

test('the same move is never called twice in a row when another fits', () => {
  for (const display of ['Jab – Cross – Lead hook', 'Jab – Rear low kick', 'Lead teep – Cross']) {
    const c = combo('muaythai', display);
    const sel = fwSel(stubInner([c]), 21);
    let prev = null;
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      const out = sel.next();
      const options = footworkFor(c, MOVE_LIST, STRIKES)[out.footwork.position];
      if (options.length > 1 && prev !== null) {
        assert.notEqual(out.footwork.name, prev, `${display} #${i}`);
        compared += 1;
      }
      prev = out.footwork.name;
    }
    assert.ok(compared > 100, `${display}: compared ${compared}`);
  }
});

test('across a real workout no move repeats back to back when the combo has a choice', () => {
  for (const sport of SPORTS) {
    const sel = fwSel(innerFor({ sport, seed: 4 }), 6);
    let prev = null;
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      const c = sel.next();
      if (!c.footwork) continue;
      const original = COMBOS.find((x) => x.id === c.id);
      const options = footworkFor(original, MOVE_LIST, STRIKES)[c.footwork.position];
      if (options.length > 1 && prev !== null) {
        assert.notEqual(c.footwork.name, prev, `${sport} #${i}: ${c.display}`);
        compared += 1;
      }
      prev = c.footwork.name;
    }
    assert.ok(compared > 100, `${sport}: compared ${compared}`);
  }
});

test('a lone option may repeat', () => {
  const lone = fwSel(stubInner([combo('muaythai', 'Jab')]), 1, [STEP_IN]);
  assert.deepEqual(Array.from({ length: 4 }, () => lone.next().footwork.name), ['Step in', 'Step in', 'Step in', 'Step in']);
});

test('every fitting move gets picked over time', () => {
  const c = combo('muaythai', 'Jab – Cross – Lead hook');
  const { before, after } = footworkFor(c, MOVE_LIST, STRIKES);
  const sel = fwSel(stubInner([c]), 31);
  const seen = new Set();
  for (let i = 0; i < 600; i++) seen.add(sel.next().footwork.name);
  assert.deepEqual([...seen].sort(), [...new Set([...names(before), ...names(after)])].sort());
});

test('a combo with no option, or with footwork already, comes back untouched', () => {
  for (const c of [
    combo('boxing', 'Long jab – Step back – Pull counter cross – Lead hook'),
    combo('boxing', 'Jab feint – Step in – Rear uppercut – Lead hook'),
    combo('muaythai', 'Slip'),
    combo('muaythai', 'Flurble'),
  ]) {
    const out = fwSel(stubInner([c])).next();
    assert.equal(out, c, c.display);
    assert.ok(!('footwork' in out));
  }
});

test('the combo keeps its own id, the input is not mutated, and nothing but the footwork fields change', () => {
  const original = { ...combo('muaythai', 'Jab – Cross – Lead hook'), tier: 'advanced', tags: ['x'] };
  const snapshot = JSON.parse(JSON.stringify(original));
  const out = fwSel(stubInner([original])).next();
  assert.equal(out.id, original.id);
  assert.equal(out.sport, original.sport);
  assert.equal(out.tier, 'advanced');
  assert.deepEqual(out.tags, ['x']);
  assert.ok(out.footwork);
  assert.ok(out.actions > original.actions);
  assert.deepEqual(original, snapshot, 'the inner combo is not mutated');
});

test('pool, recent and startRound pass through to the inner selector', () => {
  const inner = stubInner([combo('boxing', 'Jab')]);
  const sel = fwSel(inner);
  assert.deepEqual(sel.pool, ['pool-marker']);
  assert.deepEqual(sel.recent, ['recent-marker']);
  sel.startRound();
  sel.startRound();
  assert.equal(inner.calls.startRound, 2);
});

test('pool and recent follow a real inner selector as it draws', () => {
  const inner = innerFor();
  const sel = fwSel(inner);
  assert.equal(sel.pool, inner.pool);
  const first = sel.next();
  assert.deepEqual(sel.recent, [first.id]);
  assert.deepEqual(sel.recent, inner.recent);
});

test('the inner selector still sees the original combo: balance and recent are credited to the real id', () => {
  const inner = innerFor({ seed: 2 });
  const seen = [];
  const spy = {
    get pool() { return inner.pool; },
    get recent() { return inner.recent; },
    startRound() { inner.startRound?.(); },
    next() { const c = inner.next(); seen.push(c); return c; },
  };
  const sel = fwSel(spy, 5);
  const out = Array.from({ length: 60 }, () => sel.next());
  assert.equal(seen.length, 60);
  out.forEach((c, i) => {
    assert.equal(c.id, seen[i].id);
    assert.ok(!('footwork' in seen[i]), 'the inner selector\'s combo is the plain one');
    assert.equal(seen[i].display, COMBOS.find((x) => x.id === c.id).display);
  });
  // The inner selector's recent list holds real combo ids, which all exist in the library.
  assert.ok(sel.recent.length > 0);
  for (const id of sel.recent) assert.ok(COMBOS.some((x) => x.id === id), id);
  assert.deepEqual(sel.recent.slice(-1), [out[out.length - 1].id]);
});

test('the footwork selector draws the same combo sequence as the plain selector for the same inner seed', () => {
  const plain = innerFor({ seed: 13 });
  const wrapped = fwSel(innerFor({ seed: 13 }), 77);
  for (let i = 0; i < 80; i++) assert.equal(wrapped.next().id, plain.next().id, `draw ${i}`);
});

test('startRound is optional on the inner selector', () => {
  const inner = { pool: [], recent: [], next: () => null };
  assert.doesNotThrow(() => fwSel(inner).startRound());
});

test('an exhausted inner selector gives null', () => {
  assert.equal(fwSel({ pool: [], recent: [], next: () => null }).next(), null);
});

/* ---- session in footwork mode ---------------------------------------- */

const BASE = {
  sport: 'muaythai', tier: 'advanced', intensity: 'hard', roundLengthMin: 1,
  roundsPerWorkout: 3, restBetweenRoundsSec: 10, countdownSec: 0, voiceSpeedPct: 75,
  workoutMode: 'footwork',
};

/** Fake-clock driver, as in defense.test.js: speech lasts what the engine estimates. */
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
  d.finish = () => { d.runUntil(() => false); return d; };
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

test('every combo is said with its footwork move in it', () => {
  for (const seed of [1, 2, 3]) {
    const { log } = runWorkout({ seed });
    const combos = only(log, 'combo');
    assert.ok(combos.length > 10, `seed ${seed}`);
    let withMove = 0;
    log.forEach((e, i) => {
      if (e.type !== 'combo') return;
      const sayEvent = log[i + 1];
      assert.equal(sayEvent.type, 'say');
      assert.equal(sayEvent.tag, 'combo');
      assert.equal(sayEvent.text, applyPronunciation(e.combo.speech, config.pronunciation));
      if (e.combo.footwork) {
        const move = MOVE_LIST.find((m) => m.name === e.combo.footwork.name);
        assert.ok(move, e.combo.footwork.name);
        assert.ok(sayEvent.text.toLowerCase().includes(applyPronunciation(move.speech ?? move.name, config.pronunciation).toLowerCase()),
          `"${sayEvent.text}" lacks ${move.name}`);
        withMove += 1;
      }
    });
    assert.ok(withMove / combos.length > 0.9, `seed ${seed}: only ${withMove}/${combos.length} had footwork`);
  }
});

test('the gap after a footwork combo is the ordinary gap for its increased actions', () => {
  for (const intensity of ['hard', 'medium', 'light']) {
    const { log } = runWorkout({ settings: { intensity, roundLengthMin: 2, roundsPerWorkout: 2 } });
    const per = config.intensity[intensity];
    let checked = 0;
    for (const r of roundsOf(log)) {
      const list = r.events.filter((e) => e.type === 'combo' || (e.type === 'say' && e.tag === 'combo'));
      for (let i = 0; i + 3 < list.length; i += 2) {
        const [c, s, , nextSay] = [list[i], list[i + 1], list[i + 2], list[i + 3]];
        if (!c.combo.footwork || s.ended === undefined) continue;
        const original = COMBOS.find((x) => x.id === c.combo.id);
        const earliest = s.ended + gapMsFor(c.combo, per);
        assert.ok(c.combo.actions > original.actions, 'footwork adds execution time');
        assert.ok(gapMsFor(c.combo, per) > gapMsFor(original, per));
        assert.ok(nextSay.t >= earliest, `${intensity}: next combo at ${nextSay.t}, earliest ${earliest}`);
        assert.ok(nextSay.t - earliest <= 50, `${intensity}: next combo ${nextSay.t - earliest}ms late`);
        checked += 1;
      }
    }
    assert.ok(checked > 5, intensity);
  }
});

test('footwork mode has no defense events or defense says', () => {
  for (const seed of [1, 2, 3]) {
    const { log } = runWorkout({ seed, settings: { roundLengthMin: 2 } });
    assert.equal(only(log, 'defense').length, 0);
    assert.equal(says(log, 'defense').length, 0);
    for (const e of only(log, 'combo')) assert.equal(e.combo.defense, undefined);
  }
});

test('the summary reports footwork mode and completes', () => {
  const { summary, log } = runWorkout();
  assert.equal(summary.mode, 'footwork');
  assert.equal(summary.completed, true);
  assert.equal(summary.rounds, BASE.roundsPerWorkout);
  assert.equal(log.filter((e) => e.type === 'state' && e.to === STATES.COMPLETE).length, 1);
});

test('combosCalled counts combos, one per call', () => {
  const { log, summary } = runWorkout({ settings: { roundLengthMin: 2 } });
  const combos = only(log, 'combo').length;
  assert.ok(combos > 10);
  assert.equal(summary.combosCalled, combos);
  assert.equal(says(log, 'combo').length, combos);
});

test('every combo called is a real library combo, credited by its own id', () => {
  const { log } = runWorkout({ settings: { roundLengthMin: 2 } });
  for (const e of only(log, 'combo')) {
    const original = COMBOS.find((x) => x.id === e.combo.id);
    assert.ok(original, e.combo.id);
    assert.ok(e.combo.display.includes(original.display), `"${e.combo.display}" does not contain "${original.display}"`);
  }
});

test('finisher combos are plain', () => {
  for (const seed of [1, 2, 3]) {
    const { log, summary } = runWorkout({ seed, settings: { finisherSec: 20, roundLengthMin: 1, roundsPerWorkout: 3 } });
    assert.equal(summary.finisherSec, 20);
    const rounds = roundsOf(log);
    assert.equal(rounds.length, 3);
    for (const r of rounds) {
      const at = r.events.findIndex((e) => e.type === 'finisher');
      assert.ok(at >= 0, 'finisher announced');
      const finCombos = r.events.slice(at).filter((e) => e.type === 'combo');
      assert.ok(finCombos.length >= 3, `seed ${seed}: finisher combos`);
      for (const e of finCombos) {
        assert.ok(!('footwork' in e.combo), `finisher combo "${e.combo.display}" has footwork`);
        assert.ok(COMBOS.some((x) => x.id === e.combo.id && x.display === e.combo.display), 'finisher combo is the library combo as is');
      }
      // The normal part of the round still has footwork.
      assert.ok(r.events.slice(0, at).some((e) => e.type === 'combo' && e.combo.footwork));
    }
  }
});

test('the bell never cuts off a footwork combo', () => {
  const lookahead = config.roundEndLookaheadMs;
  for (const intensity of ['hard', 'medium', 'light']) {
    for (const seed of [1, 2, 3]) {
      const d = runWorkout({ seed, settings: { intensity, roundLengthMin: 1, roundsPerWorkout: 3, voiceSpeedPct: 40 } });
      const rounds = roundsOf(d.log);
      assert.equal(rounds.length, 3);
      for (const r of rounds) {
        for (const s of r.events.filter((e) => e.type === 'say' && e.tag === 'combo')) {
          assert.ok(s.t < r.end, `${intensity} seed ${seed}: combo said at/after the bell`);
          const speechEnd = s.t + estimateSpeechMs(s.text, d.rate, config.speechEstimate);
          assert.ok(speechEnd <= r.end + lookahead + 50, `${intensity} seed ${seed}: still talking ${speechEnd - r.end}ms after the bell`);
        }
      }
    }
  }
});

test('footwork mode works in every sport', () => {
  for (const sport of SPORTS) {
    const { log, summary } = runWorkout({ settings: { sport, tier: 'advanced', roundLengthMin: 2, roundsPerWorkout: 1 }, seed: 3 });
    assert.equal(summary.completed, true, sport);
    const moved = only(log, 'combo').filter((e) => e.combo.footwork);
    assert.ok(moved.length > 5, sport);
    for (const e of moved) {
      const move = MOVE_LIST.find((m) => m.name === e.combo.footwork.name);
      assert.ok(!move.sports || move.sports.includes(sport), `${sport}: ${move.name}`);
    }
  }
});

test('the session gives footwork mode the same first combo as random for the same seed', () => {
  const a = runWorkout({ seed: 12, settings: { workoutMode: 'footwork', roundsPerWorkout: 1 } });
  const b = runWorkout({ seed: 12, settings: { workoutMode: 'random', roundsPerWorkout: 1 } });
  assert.equal(only(a.log, 'combo')[0].combo.id, only(b.log, 'combo')[0].combo.id);
});

/* ---- random mode is unchanged ---------------------------------------- */

test('random mode has no footwork on any combo', () => {
  for (const seed of [1, 2, 3]) {
    const { log, summary } = runWorkout({ seed, settings: { workoutMode: 'random', roundLengthMin: 2 } });
    assert.ok(only(log, 'combo').length > 10);
    for (const e of only(log, 'combo')) {
      assert.ok(!('footwork' in e.combo), e.combo.display);
      assert.equal(e.combo.display, COMBOS.find((x) => x.id === e.combo.id).display);
    }
    assert.equal(summary.mode, 'random');
  }
});

test('defense and ladder modes have no footwork either', () => {
  for (const workoutMode of ['defense', 'ladder']) {
    const { log } = runWorkout({ settings: { workoutMode, roundLengthMin: 2, roundsPerWorkout: 1 } });
    assert.ok(only(log, 'combo').length > 3, workoutMode);
    for (const e of only(log, 'combo')) assert.ok(!('footwork' in e.combo), `${workoutMode}: ${e.combo.display}`);
  }
});

/* ---- settings and history -------------------------------------------- */

function memoryStorage() {
  const mem = new Map();
  return {
    mem,
    read: (k, fallback, sanitise) => (mem.has(k) ? sanitise(mem.get(k), fallback) : fallback),
    write: (k, v) => mem.set(k, JSON.parse(JSON.stringify(v))),
  };
}

test('footwork is an allowed workout mode', () => {
  assert.ok(WORKOUT_MODES.includes('footwork'));
});

test('the footwork mode can be set and survives a reload', () => {
  const storage = memoryStorage();
  const settings = createSettingsStore({ config, storage });
  assert.equal(settings.get('workoutMode'), 'random');
  settings.set('workoutMode', 'footwork');
  assert.equal(settings.get('workoutMode'), 'footwork');
  assert.equal(createSettingsStore({ config, storage }).get('workoutMode'), 'footwork');
  assert.equal(storage.mem.get(KEYS.settings).workoutMode, 'footwork');
});

test('a misspelt workout mode never lands; the store falls back to the default', () => {
  const settings = createSettingsStore({ config, storage: memoryStorage() });
  settings.set('workoutMode', 'footwork');
  settings.set('workoutMode', 'footwerk');
  assert.equal(settings.get('workoutMode'), 'random');
});

function fakeBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}
const makeHistory = (backend) => createHistory({ storage: createStorage({ backend }) });
let seq = 0;
const record = (over = {}) => {
  seq += 1;
  return {
    id: `fw${seq}`,
    startedAt: new Date().toISOString(),
    sport: 'muaythai',
    tier: 'advanced',
    intensity: 'hard',
    rounds: 3,
    roundLengthSec: 180,
    restSec: 30,
    durationSec: 600,
    combosCalled: 40,
    completed: true,
    ...over,
  };
};

test('a history record with mode footwork keeps it across a reload', () => {
  const backend = fakeBackend();
  const added = makeHistory(backend).add(record({ mode: 'footwork' }));
  assert.equal(added.mode, 'footwork');
  const [stored] = makeHistory(backend).all();
  assert.equal(stored.mode, 'footwork');
  assert.ok(SCHEMA_VERSION >= 1);
});

test('a real footwork summary round-trips into history as footwork', () => {
  const { summary } = runWorkout();
  assert.equal(summary.mode, 'footwork');
  const backend = fakeBackend();
  makeHistory(backend).add(record({ mode: summary.mode }));
  assert.equal(makeHistory(backend).all()[0].mode, 'footwork');
});
