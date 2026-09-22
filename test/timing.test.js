import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  gapMsFor,
  voiceRate,
  estimateSpeechMs,
  canStartCallout,
  applyPronunciation,
  formatClock,
} from '../src/engine/timing.js';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));

test('gap maths for every intensity across 2 to 7 actions', () => {
  // Expected values follow baseGapMs + perActionMs * actions.
  const expected = {
    light:  { 2: 4200, 3: 4900, 4: 5600, 5: 6300, 6: 7000, 7: 7700 },
    medium: { 2: 3000, 3: 3700, 4: 4400, 5: 5100, 6: 5800, 7: 6500 },
    hard:   { 2: 1800, 3: 2500, 4: 3200, 5: 3900, 6: 4600, 7: 5300 },
  };

  for (const [key, byActions] of Object.entries(expected)) {
    const intensity = config.intensity[key];
    for (const [actions, ms] of Object.entries(byActions)) {
      assert.equal(
        gapMsFor({ actions: Number(actions) }, intensity), ms,
        `${key} at ${actions} actions`
      );
    }
  }
});

test('gaps increase with action count and decrease with intensity', () => {
  for (const key of ['light', 'medium', 'hard']) {
    const i = config.intensity[key];
    for (let a = 2; a < 7; a++) {
      assert.ok(gapMsFor({ actions: a }, i) < gapMsFor({ actions: a + 1 }, i));
    }
  }
  for (let a = 2; a <= 7; a++) {
    const l = gapMsFor({ actions: a }, config.intensity.light);
    const m = gapMsFor({ actions: a }, config.intensity.medium);
    const h = gapMsFor({ actions: a }, config.intensity.hard);
    assert.ok(l > m && m > h, `intensities out of order at ${a} actions`);
  }
});

test('intensity does not compress the time allowed per strike', () => {
  // The time to physically throw one strike does not change because the user
  // picked Hard. Intensity is expressed through baseGapMs (recovery), not
  // perActionMs (execution). Getting this wrong made 7-action combos on Hard
  // impossible to complete — the shortfall multiplies by combo length.
  const per = ['light', 'medium', 'hard'].map((k) => config.intensity[k].perActionMs);
  assert.equal(new Set(per).size, 1, `perActionMs differs across intensities: ${per}`);

  // The gap difference between two intensities must therefore be constant,
  // not widening as combos get longer.
  const spread = (actions) =>
    gapMsFor({ actions }, config.intensity.light) - gapMsFor({ actions }, config.intensity.hard);
  for (let a = 3; a <= 7; a++) assert.equal(spread(a), spread(2));
});

test('no Hard gap lands on the 2s audio-session teardown boundary', () => {
  // Phase 0: a gap of almost exactly 2000ms cost ~631ms instead of ~317ms.
  // The keep-alive tone makes this moot, but if it ever fails we should not
  // also be sitting on the worst possible gap length.
  for (let a = 2; a <= 7; a++) {
    const gap = gapMsFor({ actions: a }, config.intensity.hard);
    assert.ok(Math.abs(gap - 2000) > 150, `hard at ${a} actions gives ${gap}ms`);
  }
});

test('voice speed maps onto the configured rate range', () => {
  const r = config.voiceRateRange;
  assert.equal(voiceRate(0, r), 0.6);
  assert.equal(voiceRate(100, r), 1.6);
  assert.ok(Math.abs(voiceRate(75, r) - 1.35) < 1e-9);
  // Out-of-range input is clamped rather than extrapolated.
  assert.equal(voiceRate(-50, r), 0.6);
  assert.equal(voiceRate(500, r), 1.6);
});

test('speech estimate matches what Phase 0 measured on the device', () => {
  // "Jab, Cross, Lead hook" is 21 characters and measured 1022ms on iOS at
  // rate 1.35 across 27 samples.
  const est = estimateSpeechMs('Jab, Cross, Lead hook', 1.35, config.speechEstimate);
  assert.ok(Math.abs(est - 1022) < 60, `estimate ${Math.round(est)}ms vs 1022ms measured`);
});

test('speech estimate grows with length and shrinks with rate', () => {
  const c = config.speechEstimate;
  assert.ok(estimateSpeechMs('short', 1, c) < estimateSpeechMs('a much longer string', 1, c));
  assert.ok(estimateSpeechMs('same text', 1.6, c) < estimateSpeechMs('same text', 0.6, c));
});

test('the lookahead never schedules a callout that overruns the round', () => {
  const lookaheadMs = config.roundEndLookaheadMs;

  // Comfortably inside the round.
  assert.equal(canStartCallout({
    remainingMs: 30000, estSpeechMs: 2000, gapMs: 4000, lookaheadMs,
  }), true);

  // Exactly at the limit: overrun equals the allowance.
  assert.equal(canStartCallout({
    remainingMs: 5500, estSpeechMs: 2000, gapMs: 4000, lookaheadMs,
  }), true);

  // One millisecond beyond it.
  assert.equal(canStartCallout({
    remainingMs: 5499, estSpeechMs: 2000, gapMs: 4000, lookaheadMs,
  }), false);

  // Nothing starts once the round is over.
  assert.equal(canStartCallout({
    remainingMs: 0, estSpeechMs: 500, gapMs: 1000, lookaheadMs,
  }), false);
});

test('lookahead holds across every intensity and action count', () => {
  const lookaheadMs = config.roundEndLookaheadMs;
  for (const key of ['light', 'medium', 'hard']) {
    const intensity = config.intensity[key];
    for (let actions = 2; actions <= 7; actions++) {
      const gapMs = gapMsFor({ actions }, intensity);
      const estSpeechMs = estimateSpeechMs('x'.repeat(40), 1.35, config.speechEstimate);
      const need = estSpeechMs + gapMs;
      // Just too little time: must refuse.
      assert.equal(canStartCallout({
        remainingMs: need - lookaheadMs - 1, estSpeechMs, gapMs, lookaheadMs,
      }), false, `${key}/${actions} should refuse`);
      // Just enough: must allow.
      assert.equal(canStartCallout({
        remainingMs: need - lookaheadMs, estSpeechMs, gapMs, lookaheadMs,
      }), true, `${key}/${actions} should allow`);
    }
  }
});

test('pronunciation applies to whole words, case-insensitively', () => {
  const rules = { 'up-elbow': 'up elbow', 'step-up': 'step up', teep: 'teep' };
  assert.equal(applyPronunciation('Lead up-elbow', rules), 'Lead up elbow');
  assert.equal(applyPronunciation('Step-up knee', rules), 'step up knee');
  // Must not fire inside a longer word.
  assert.equal(applyPronunciation('teeping', rules), 'teeping');
  assert.equal(applyPronunciation('Lead teep', rules), 'Lead teep');
});

test('clock formatting', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(1000), '0:01');
  assert.equal(formatClock(59000), '0:59');
  assert.equal(formatClock(60000), '1:00');
  assert.equal(formatClock(125000), '2:05');
  assert.equal(formatClock(-500), '0:00');
});
