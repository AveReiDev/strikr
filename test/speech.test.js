/**
 * These tests exist because of a real bug: main.js passed a *copy* of the
 * settings into createSpeech, so changing the voice or the speed updated the
 * screen and localStorage but had no audible effect. Nothing caught it until
 * it was used on a phone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url)));

/* A minimal stand-in for the browser speech API. */
function installFakeSpeechSynthesis(voices) {
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const spoken = [];
  globalThis.SpeechSynthesisUtterance = FakeUtterance;
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => voices,
      speak: (u) => {
        spoken.push({ text: u.text, rate: u.rate, voice: u.voice?.name });
        // Fire onend as a real engine would, so the watchdog timer is cleared
        // and the suite does not sit waiting for it.
        queueMicrotask(() => u.onend?.());
      },
      cancel: () => {},
      onvoiceschanged: null,
    },
  };
  return spoken;
}

const VOICES = [
  { name: 'Samantha', lang: 'en-US' },
  { name: 'Daniel', lang: 'en-GB' },
  { name: 'Karen', lang: 'en-AU' },
  { name: 'Amelie', lang: 'fr-FR' },
];

/** A stand-in for the settings store: has .get, and can change. */
function fakeStore(initial) {
  const state = { ...initial };
  return { get: (k) => state[k], set: (k, v) => { state[k] = v; } };
}

const { createSpeech } = await (async () => {
  installFakeSpeechSynthesis(VOICES);
  return import('../src/audio/speech.js');
})();

test('refuses a plain settings copy instead of failing silently', () => {
  installFakeSpeechSynthesis(VOICES);
  // This is exactly the mistake that shipped: passing settings.all.
  assert.throws(
    () => createSpeech({ config, settings: { voiceGender: 'male', voiceSpeedPct: 75 } }),
    /live settings store/
  );
});

test('voice speed follows the live setting, not the value at construction', () => {
  installFakeSpeechSynthesis(VOICES);
  const store = fakeStore({ voiceGender: 'male', voiceSpeedPct: 75 });
  const speech = createSpeech({ config, settings: store });

  const at75 = speech.rate;
  store.set('voiceSpeedPct', 0);
  const at0 = speech.rate;
  store.set('voiceSpeedPct', 100);
  const at100 = speech.rate;

  assert.equal(at0, config.voiceRateRange.min);
  assert.equal(at100, config.voiceRateRange.max);
  assert.ok(at0 < at75 && at75 < at100, `rates did not track the setting: ${at0}/${at75}/${at100}`);
});

test('the rate actually reaches the utterance', () => {
  const spoken = installFakeSpeechSynthesis(VOICES);
  const store = fakeStore({ voiceGender: 'male', voiceSpeedPct: 75 });
  const speech = createSpeech({ config, settings: store });

  speech.speak('Jab, Cross');
  store.set('voiceSpeedPct', 10);
  speech.speak('Jab, Cross');

  assert.equal(spoken.length, 2);
  assert.ok(spoken[1].rate < spoken[0].rate,
    `second utterance should be slower: ${spoken[0].rate} then ${spoken[1].rate}`);
});

test('male and female resolve to different voices', () => {
  installFakeSpeechSynthesis(VOICES);
  const store = fakeStore({ voiceGender: 'male', voiceSpeedPct: 75 });
  const speech = createSpeech({ config, settings: store });

  const male = speech.voiceName;
  store.set('voiceGender', 'female');
  speech.refreshVoice();
  const female = speech.voiceName;

  assert.notEqual(male, female, `both genders picked "${male}"`);
  assert.equal(male, 'Daniel');       // first male candidate present in config
  assert.equal(female, 'Samantha');   // first female candidate present in config
});

test('the chosen voice reaches the utterance', () => {
  const spoken = installFakeSpeechSynthesis(VOICES);
  const store = fakeStore({ voiceGender: 'female', voiceSpeedPct: 75 });
  const speech = createSpeech({ config, settings: store });
  speech.speak('Jab, Cross');
  assert.equal(spoken[0].voice, 'Samantha');
});

test('falls back to an English voice when no candidate matches', () => {
  installFakeSpeechSynthesis([{ name: 'Nobody', lang: 'en-US' }, { name: 'Amelie', lang: 'fr-FR' }]);
  const speech = createSpeech({
    config, settings: fakeStore({ voiceGender: 'male', voiceSpeedPct: 75 }),
  });
  assert.equal(speech.voiceName, 'Nobody', 'should fall back to the first English voice');
});

test('reports the system default when there are no English voices at all', () => {
  installFakeSpeechSynthesis([{ name: 'Amelie', lang: 'fr-FR' }]);
  const speech = createSpeech({
    config, settings: fakeStore({ voiceGender: 'male', voiceSpeedPct: 75 }),
  });
  assert.equal(speech.voiceName, 'system default');
});

test('every configured voice candidate list is non-empty', () => {
  for (const gender of ['male', 'female']) {
    const list = config.voiceCandidates?.[gender];
    assert.ok(Array.isArray(list) && list.length > 0, `${gender} has no candidates`);
  }
  // The two lists must not lead to the same voice on a typical iOS device.
  const overlap = config.voiceCandidates.male
    .filter((m) => config.voiceCandidates.female.includes(m));
  assert.deepEqual(overlap, [], `candidate lists overlap: ${overlap}`);
});
