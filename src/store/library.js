/**
 * The combo library: shipped combos.json merged with the user's own data.
 *
 * The shipped library is READ-ONLY and is never written to storage. Only two
 * things are persisted: per-combo overrides (enabled, frequency) keyed by id,
 * and the user's own custom combos. That way a corrected combos.json shipped
 * later does not clobber anything the user has done.
 */

import { KEYS, sanitiseFields } from './storage.js';

export const FREQUENCIES = ['occasional', 'common', 'constant'];
export const SPORTS = ['boxing', 'muaythai', 'kickboxing'];
export const TIERS = ['beginner', 'intermediate', 'advanced'];

export const SPORT_LABEL = {
  boxing: 'Boxing',
  muaythai: 'Muay Thai',
  kickboxing: 'Kickboxing',
};

const EN_DASH = '–';

/**
 * Derive speech and action count from a display string, using the same rule as
 * the generator that built combos.json:
 *   - split on the en dash (a spaced hyphen is accepted too, since that is what
 *     people actually type)
 *   - parentheticals are dropped from the speech but still counted as actions,
 *     because they consume real time on the bag
 *
 * The split deliberately requires whitespace around a plain hyphen so that
 * hyphenated strikes such as "up-elbow" and "step-up" survive intact.
 */
export function deriveFromDisplay(input) {
  const segments = String(input ?? '')
    .split(new RegExp(`\\s*${EN_DASH}\\s*|\\s*—\\s*|\\s+-\\s+`))
    .map((s) => s.trim())
    .filter(Boolean);

  const spoken = segments.filter((s) => !s.startsWith('('));

  return {
    display: segments.join(` ${EN_DASH} `),
    speech: spoken.join(', '),
    actions: segments.length,
  };
}

export const TAGS = ['hands', 'kicks', 'elbows', 'body', 'defensive'];
export const DRILL_TAGS = ['jab', 'cross', 'hook', 'uppercut', 'kick', 'teep', 'knee'];

export function validateCustom({ display, sport, tier, frequency, tags }) {
  const errors = [];
  const derived = deriveFromDisplay(display);

  if (!derived.actions) errors.push('Enter at least one strike.');
  if (derived.actions > 12) errors.push('That is more than 12 actions — split it into two combos.');
  if (!derived.speech) errors.push('A combo cannot be only parentheticals — the voice would say nothing.');
  if (derived.display.length > 200) errors.push('Too long to read on the workout screen.');
  if (!SPORTS.includes(sport)) errors.push('Pick a sport.');
  if (!TIERS.includes(tier)) errors.push('Pick a difficulty.');
  if (!FREQUENCIES.includes(frequency)) errors.push('Pick how often it should come up.');

  const validTags = Array.isArray(tags)
    ? tags.filter((t) => typeof t === 'string' && (TAGS.includes(t) || DRILL_TAGS.includes(t)))
    : [];

  return { ok: errors.length === 0, errors, derived, tags: validTags };
}

const overrideSchema = {
  enabled: { type: 'boolean' },
  frequency: { oneOf: FREQUENCIES },
};

/** A stored custom combo, checked field by field on the way back in. */
function sanitiseCustom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const check = validateCustom({
    display: raw.display,
    sport: raw.sport,
    tier: raw.tier,
    frequency: raw.frequency,
    tags: raw.tags,
  });
  if (!check.ok) return null;
  return {
    id: raw.id,
    sport: raw.sport,
    tier: raw.tier,
    display: check.derived.display,
    speech: check.derived.speech,
    actions: check.derived.actions,
    frequency: raw.frequency,
    tags: check.tags,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    custom: true,
  };
}

function sanitiseStored(raw) {
  const out = { overrides: {}, customs: [] };
  if (!raw || typeof raw !== 'object') return out;

  if (raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides)) {
    for (const [id, value] of Object.entries(raw.overrides)) {
      if (typeof id !== 'string' || !value || typeof value !== 'object') continue;
      const clean = {};
      if (typeof value.enabled === 'boolean') clean.enabled = value.enabled;
      if (FREQUENCIES.includes(value.frequency)) clean.frequency = value.frequency;
      if (Object.keys(clean).length) out.overrides[id] = clean;
    }
  }

  if (Array.isArray(raw.customs)) {
    const seen = new Set();
    for (const c of raw.customs) {
      const clean = sanitiseCustom(c);
      if (clean && !seen.has(clean.id)) { seen.add(clean.id); out.customs.push(clean); }
    }
  }
  return out;
}

let idCounter = 0;
function newId() {
  // "cus-" cannot collide with shipped ids, which look like mt-beg-01.
  idCounter += 1;
  return `cus-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function createLibrary({ shipped, storage }) {
  const shippedList = Array.isArray(shipped) ? shipped : [];
  let user = storage.read(KEYS.library, { overrides: {}, customs: [] }, (raw) => sanitiseStored(raw));

  const persist = () => storage.write(KEYS.library, user);

  /** Shipped combo with any override applied. Never mutates the original. */
  function applyOverride(combo) {
    const o = user.overrides[combo.id];
    if (!o) return { ...combo };
    return {
      ...combo,
      enabled: o.enabled !== undefined ? o.enabled : combo.enabled,
      frequency: o.frequency !== undefined ? o.frequency : combo.frequency,
    };
  }

  function all() {
    return [...shippedList.map(applyOverride), ...user.customs.map((c) => ({ ...c }))];
  }

  function find(id) {
    return all().find((c) => c.id === id) ?? null;
  }

  const isCustom = (id) => user.customs.some((c) => c.id === id);

  return {
    all,
    find,
    isCustom,

    /** What the engine draws from: enabled combos only. */
    activePool() {
      return all().filter((c) => c.enabled);
    },

    bySport(query = '') {
      const q = query.trim().toLowerCase();
      const matches = (c) =>
        !q ||
        c.display.toLowerCase().includes(q) ||
        c.speech.toLowerCase().includes(q) ||
        c.tier.includes(q) ||
        c.frequency.includes(q);

      return SPORTS.map((sport) => ({
        sport,
        label: SPORT_LABEL[sport],
        combos: all()
          .filter((c) => c.sport === sport && matches(c))
          .sort((a, b) => {
            if (a.custom !== b.custom) return a.custom ? -1 : 1;   // customs first
            return TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)
              || a.display.localeCompare(b.display);
          }),
      })).filter((g) => g.combos.length > 0 || !q);
    },

    counts(sport) {
      const list = all().filter((c) => !sport || c.sport === sport);
      return { total: list.length, active: list.filter((c) => c.enabled).length };
    },

    setEnabled(id, enabled) {
      const custom = user.customs.find((c) => c.id === id);
      if (custom) custom.enabled = !!enabled;
      else user.overrides[id] = { ...user.overrides[id], enabled: !!enabled };
      persist();
      return find(id);
    },

    setFrequency(id, frequency) {
      if (!FREQUENCIES.includes(frequency)) return find(id);
      const custom = user.customs.find((c) => c.id === id);
      if (custom) custom.frequency = frequency;
      else user.overrides[id] = { ...user.overrides[id], frequency };
      persist();
      return find(id);
    },

    addCustom({ display, sport, tier, frequency, tags }) {
      const check = validateCustom({ display, sport, tier, frequency, tags });
      if (!check.ok) return { ok: false, errors: check.errors };
      const combo = {
        id: newId(),
        sport,
        tier,
        display: check.derived.display,
        speech: check.derived.speech,
        actions: check.derived.actions,
        frequency,
        tags: check.tags,
        enabled: true,
        custom: true,
      };
      user.customs.push(combo);
      persist();
      return { ok: true, combo };
    },

    updateCustom(id, { display, sport, tier, frequency, tags }) {
      const i = user.customs.findIndex((c) => c.id === id);
      if (i === -1) return { ok: false, errors: ['Shipped combos cannot be edited.'] };
      const check = validateCustom({ display, sport, tier, frequency, tags });
      if (!check.ok) return { ok: false, errors: check.errors };
      user.customs[i] = {
        ...user.customs[i],
        sport,
        tier,
        frequency,
        tags: check.tags,
        display: check.derived.display,
        speech: check.derived.speech,
        actions: check.derived.actions,
      };
      persist();
      return { ok: true, combo: { ...user.customs[i] } };
    },

    /** Shipped combos can be disabled but never deleted. */
    remove(id) {
      const i = user.customs.findIndex((c) => c.id === id);
      if (i === -1) return { ok: false, errors: ['Shipped combos cannot be deleted, only disabled.'] };
      user.customs.splice(i, 1);
      persist();
      return { ok: true };
    },

    reset() {
      user = { overrides: {}, customs: [] };
      persist();
    },
  };
}
