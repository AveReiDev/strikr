/**
 * localStorage access. Every read is defensive.
 *
 * The rule: a bad stored value must never stop the app from starting. Missing
 * key, unparseable JSON, wrong schema version, a string where a number belongs
 * — all fall back to defaults rather than throwing.
 *
 * The three keys are independent so one corrupt value cannot brick the others.
 * The shipped combo library is never written here; only the user's own data is.
 */

export const NAMESPACE = 'strikr.v1.';
export const SCHEMA_VERSION = 1;

export const KEYS = {
  settings: 'settings',
  library: 'library',
  history: 'history',
};

/**
 * The backend is injectable so tests can supply a fake — including ones that
 * throw, which is what Safari does in private browsing.
 */
export function createStorage({ backend, namespace = NAMESPACE } = {}) {
  const store = backend ?? safeLocalStorage();
  const full = (key) => namespace + key;

  function readRaw(key) {
    if (!store) return null;
    try {
      return store.getItem(full(key));
    } catch (_) {
      return null;   // access itself can throw in locked-down browsers
    }
  }

  return {
    available: !!store,

    /**
     * Read and validate. `sanitise(value, fallback)` is given whatever was
     * stored and must return something usable. It is never given a throw.
     */
    read(key, fallback, sanitise) {
      const raw = readRaw(key);
      if (raw === null || raw === undefined || raw === '') return clone(fallback);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        return clone(fallback);          // corrupt JSON
      }

      if (!isPlainObject(parsed)) return clone(fallback);
      if (parsed.schemaVersion !== SCHEMA_VERSION) return clone(fallback);
      if (!('data' in parsed)) return clone(fallback);

      try {
        return sanitise ? sanitise(parsed.data, clone(fallback)) : parsed.data;
      } catch (_) {
        return clone(fallback);          // a validator that itself blew up
      }
    },

    /** Returns false rather than throwing if storage is full or unavailable. */
    write(key, data) {
      if (!store) return false;
      try {
        store.setItem(full(key), JSON.stringify({ schemaVersion: SCHEMA_VERSION, data }));
        return true;
      } catch (_) {
        return false;   // quota exceeded, or private browsing
      }
    },

    remove(key) {
      if (!store) return;
      try { store.removeItem(full(key)); } catch (_) {}
    },

    /** Clears only this app's keys, never anything else in localStorage. */
    clearAll() {
      for (const k of Object.values(KEYS)) this.remove(k);
    },
  };
}

function safeLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    // Touching it is the only reliable way to know it works.
    const probe = `${NAMESPACE}__probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch (_) {
    return null;
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

/* ------------------------------------------------------------------ *
 * Field-level validation
 *
 * Each field falls back independently, so one bad value does not discard
 * a whole screen's worth of good settings.
 * ------------------------------------------------------------------ */

export function sanitiseFields(raw, defaults, schema) {
  const out = clone(defaults);
  if (!isPlainObject(raw)) return out;

  for (const [key, rule] of Object.entries(schema)) {
    if (!(key in raw)) continue;                 // absent: keep the default
    const value = raw[key];
    const ok = checkField(value, rule);
    if (ok !== undefined) out[key] = ok;
  }
  return out;
}

function checkField(value, rule) {
  if (rule.oneOf) {
    return rule.oneOf.includes(value) ? value : undefined;
  }
  if (rule.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    let v = rule.integer ? Math.round(value) : value;
    if (rule.min !== undefined) v = Math.max(rule.min, v);
    if (rule.max !== undefined) v = Math.min(rule.max, v);
    return v;
  }
  if (rule.type === 'object' && rule.schema) {
    if (!isPlainObject(value)) return undefined;
    return sanitiseFields(value, rule.defaults, rule.schema);
  }
  return undefined;
}
