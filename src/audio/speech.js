/**
 * The ONLY file that touches SpeechSynthesis.
 *
 * Everything above this line asks for "speak this string, tell me when you are
 * done". If device text-to-speech is ever swapped for recorded clips, this file
 * changes and nothing else does.
 */

/**
 * iOS sometimes never fires `onend`. Without a backstop the workout would hang
 * forever waiting for a callout that already finished. Phase 0 measured zero
 * failures in 81 callouts, so this should never fire — but "should never" is
 * not the same as "cannot".
 */
const WATCHDOG_FACTOR = 2.5;
const WATCHDOG_PAD_MS = 3000;

import { voiceRate } from '../engine/timing.js';

/**
 * `settings` must be the live settings store, not a snapshot of it. Passing a
 * plain copy here silently freezes the voice and speed at whatever they were
 * when the page loaded — changing them then updates the screen and storage but
 * has no audible effect.
 */
export function createSpeech({ config, settings }) {
  if (typeof settings?.get !== 'function') {
    throw new TypeError('createSpeech needs the live settings store, not a copy');
  }
  const synth = window.speechSynthesis;
  const supported = !!synth;
  let voice = null;
  const keepAlive = [];   // holds utterances so garbage collection cannot eat onend

  const rate = () => voiceRate(settings.get('voiceSpeedPct'), config.voiceRateRange);

  /**
   * Voice availability differs by device and iOS version, so candidate names
   * live in config and are matched loosely. Documented fallback: the first
   * English voice, then whatever the system defaults to.
   */
  function pickVoice() {
    if (!supported) return null;
    const en = synth.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
    const wanted = config.voiceCandidates?.[settings.get('voiceGender')] ?? [];
    for (const name of wanted) {
      const hit = en.find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
      if (hit) return hit;
    }
    return en[0] ?? null;
  }

  function refreshVoice() {
    voice = pickVoice();
    return voice;
  }

  if (supported) {
    refreshVoice();
    synth.onvoiceschanged = refreshVoice;
  }

  return {
    supported,
    refreshVoice,
    get voiceName() { return voice ? voice.name : 'system default'; },
    get rate() { return rate(); },

    /**
     * iOS will not speak later unless the first utterance is fired inside the
     * user gesture that started things. Must be called from the tap handler.
     */
    prime() {
      if (!supported) return;
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0.01;
      keepAlive.push(u);
      synth.speak(u);
    },

    /** Resolves when the voice has finished, or when the watchdog gives up. */
    speak(text) {
      if (!supported) return Promise.resolve('unsupported');
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        u.rate = rate();
        if (config.speechVolume != null) u.volume = config.speechVolume;
        keepAlive.push(u);
        if (keepAlive.length > 40) keepAlive.shift();

        let settled = false;
        const done = (how) => {
          if (settled) return;
          settled = true;
          clearTimeout(wd);
          resolve(how);
        };
        u.onend = () => done('onend');
        u.onerror = () => done('error');

        const est = (config.speechEstimate.fixedMs
          + config.speechEstimate.msPerChar * text.length) / rate();
        const wd = setTimeout(() => done('watchdog'), est * WATCHDOG_FACTOR + WATCHDOG_PAD_MS);

        synth.speak(u);
      });
    },

    cancel() {
      if (supported) { try { synth.cancel(); } catch (_) {} }
    },
  };
}
