/**
 * User settings: the shape, the allowed values, and persistence.
 *
 * Defaults come from data/config.json, never from literals here — so a
 * non-developer can change what a fresh install looks like by editing one
 * JSON file.
 */

import { KEYS, sanitiseFields } from './storage.js';

export const SPORTS = ['boxing', 'muaythai', 'kickboxing'];
export const TIERS = ['beginner', 'intermediate', 'advanced'];
export const INTENSITIES = ['light', 'medium', 'hard', 'custom'];
export const ROUND_LENGTHS = [1, 2, 3, 4, 5, 10];
export const WORKOUT_MODES = ['random', 'ladder', 'pyramid'];

/**
 * Allowed values for the picker rows on the settings screen.
 *
 * roundsPerWorkout is every whole number up to the largest goal, because the
 * progressive-training suggestion steps one round at a time and resets to 70%
 * of the goal — any gap in this list is a suggestion that silently cannot be
 * loaded, since set() ignores values outside it.
 */
export const CHOICES = {
  roundsPerWorkout: Array.from({ length: 15 }, (_, i) => i + 1),
  restBetweenRoundsSec: [10, 15, 20, 30, 45, 60, 90],
  countdownSec: [0, 3, 5, 10],
  ladderReps: [1, 2, 3],
};

export const GOAL_INTENSITIES = ['light', 'medium', 'hard'];
export const GOAL_ROUNDS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15];
export const GOAL_ROUND_LENGTHS = [1, 2, 3, 4, 5];

export function settingsSchema(config) {
  const custom = config.intensity.custom;
  return {
    sport: { oneOf: SPORTS },
    tier: { oneOf: TIERS },
    intensity: { oneOf: INTENSITIES },
    roundLengthMin: { oneOf: ROUND_LENGTHS },
    roundsPerWorkout: { oneOf: CHOICES.roundsPerWorkout },
    restBetweenRoundsSec: { oneOf: CHOICES.restBetweenRoundsSec },
    countdownSec: { oneOf: CHOICES.countdownSec },
    voiceGender: { oneOf: ['male', 'female'] },
    voiceSpeedPct: { type: 'number', integer: true, min: 0, max: 100 },
    darkMode: { type: 'boolean' },
    focusWeak: { type: 'boolean' },
    workoutMode: { oneOf: WORKOUT_MODES },
    ladderReps: { oneOf: CHOICES.ladderReps },
    customIntensity: {
      type: 'object',
      defaults: { baseGapMs: custom.baseGapMs, perActionMs: custom.perActionMs },
      schema: {
        baseGapMs: { type: 'number', integer: true, min: 0, max: 10000 },
        perActionMs: { type: 'number', integer: true, min: 0, max: 3000 },
      },
    },
  };
}

export function defaultSettings(config) {
  const d = config.defaults;
  return {
    sport: d.sport,
    tier: d.tier,
    intensity: d.intensity,
    roundLengthMin: d.roundLengthMin,
    roundsPerWorkout: d.roundsPerWorkout,
    restBetweenRoundsSec: d.restBetweenRoundsSec,
    countdownSec: d.countdownSec,
    voiceGender: d.voiceGender,
    voiceSpeedPct: d.voiceSpeedPct,
    darkMode: d.darkMode,
    focusWeak: false,
    workoutMode: 'random',
    ladderReps: 1,
    focus: null,
    customIntensity: {
      baseGapMs: config.intensity.custom.baseGapMs,
      perActionMs: config.intensity.custom.perActionMs,
    },
    goal: null,
  };
}

function sanitiseFocus(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  return raw;
}

function sanitiseGoal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rounds = typeof raw.rounds === 'number' && GOAL_ROUNDS.includes(raw.rounds) ? raw.rounds : null;
  const intensity = GOAL_INTENSITIES.includes(raw.intensity) ? raw.intensity : null;
  const roundLengthMin = typeof raw.roundLengthMin === 'number' && GOAL_ROUND_LENGTHS.includes(raw.roundLengthMin) ? raw.roundLengthMin : null;
  if (!rounds || !intensity || !roundLengthMin) return null;
  return { rounds, intensity, roundLengthMin };
}

export function createSettingsStore({ config, storage, onChange }) {
  const defaults = defaultSettings(config);
  const schema = settingsSchema(config);

  let current = storage.read(
    KEYS.settings,
    defaults,
    (raw, fallback) => {
      const out = sanitiseFields(raw, fallback, schema);
      out.focus = sanitiseFocus(raw?.focus);
      out.goal = sanitiseGoal(raw?.goal);
      return out;
    }
  );

  function persist() {
    storage.write(KEYS.settings, current);
    onChange?.(current);
  }

  return {
    get all() { return { ...current }; },
    get(key) { return current[key]; },

    set(key, value) {
      if (key === 'goal') {
        current.goal = sanitiseGoal(value);
        persist();
        return current.goal;
      }
      if (key === 'focus') {
        current.focus = sanitiseFocus(value);
        persist();
        return current.focus;
      }
      const next = sanitiseFields({ ...current, [key]: value }, defaults, schema);
      next.focus = current.focus;
      next.goal = current.goal;
      current = next;
      persist();
      return current[key];
    },

    /** Move a stepper field to its next allowed value, wrapping round. */
    cycle(key) {
      const options = CHOICES[key] ?? schema[key]?.oneOf;
      if (!options) return current[key];
      const i = options.indexOf(current[key]);
      return this.set(key, options[(i + 1) % options.length]);
    },

    setCustomIntensity(patch) {
      return this.set('customIntensity', { ...current.customIntensity, ...patch });
    },

    /**
     * The intensity the engine should actually use. Selecting Custom swaps in
     * the user's own numbers while keeping the same shape as a built-in one.
     */
    resolveIntensity() {
      if (current.intensity !== 'custom') return config.intensity[current.intensity];
      return {
        label: 'CUSTOM',
        baseGapMs: current.customIntensity.baseGapMs,
        perActionMs: current.customIntensity.perActionMs,
      };
    },

    reset() {
      current = { ...defaults, customIntensity: { ...defaults.customIntensity }, focus: null, goal: null };
      persist();
      return current;
    },
  };
}
