/**
 * Session history: records, aggregates, and the day streak.
 *
 * Everything here works in the DEVICE'S LOCAL TIMEZONE. Using UTC would put a
 * late-evening session on the wrong day for anyone west of Greenwich and break
 * their streak for no reason.
 */

import { KEYS } from './storage.js';

export const PERIODS = ['week', 'month', 'all'];
export const PERIOD_LABEL = { week: 'This Week', month: 'This Month', all: 'All Time' };

const SPORTS = ['boxing', 'muaythai', 'kickboxing'];
const TIERS = ['beginner', 'intermediate', 'advanced'];
const INTENSITIES = ['light', 'medium', 'hard', 'custom'];

export function newSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Older iOS Safari has no randomUUID. Uniqueness only has to hold within
  // one person's own history, so this is ample.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** YYYY-MM-DD in local time, which is what "a training day" means to a person. */
export function localDayKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Consecutive calendar days with at least one COMPLETED session.
 *
 * A streak stays alive if you trained today or yesterday — otherwise it is
 * broken. Counting only from today would show 0 all morning before training,
 * which is both wrong and dispiriting.
 */
export function computeStreak(records, now = Date.now()) {
  const days = new Set(
    records.filter((r) => r.completed).map((r) => localDayKey(r.startedAt)).filter(Boolean)
  );
  if (!days.size) return 0;

  // Noon rather than midnight, so stepping back a day cannot land on the wrong
  // side of a daylight-saving change.
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);

  if (!days.has(localDayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(localDayKey(cursor))) return 0;   // last session was too long ago
  }

  let streak = 0;
  while (days.has(localDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Start of the filter window. Weeks start on Monday. */
export function periodStart(period, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === 'week') {
    const mondayIndex = (d.getDay() + 6) % 7;    // Sunday(0) becomes 6
    d.setDate(d.getDate() - mondayIndex);
    return d.getTime();
  }
  if (period === 'month') {
    d.setDate(1);
    return d.getTime();
  }
  return -Infinity;
}

function isValidRecord(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.id !== 'string' || !r.id) return false;
  if (typeof r.startedAt !== 'string' || Number.isNaN(Date.parse(r.startedAt))) return false;
  if (!SPORTS.includes(r.sport)) return false;
  if (!TIERS.includes(r.tier)) return false;
  if (!INTENSITIES.includes(r.intensity)) return false;
  for (const k of ['rounds', 'roundLengthSec', 'restSec', 'durationSec', 'combosCalled']) {
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0) return false;
  }
  if (typeof r.completed !== 'boolean') return false;
  return true;
}

function sanitiseCombosCalledIds(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((id) => typeof id === 'string' && id);
  return out.length ? out : undefined;
}

function sanitiseHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (!isValidRecord(r) || seen.has(r.id)) continue;
    seen.add(r.id);
    const rec = {
      id: r.id,
      startedAt: r.startedAt,
      sport: r.sport,
      tier: r.tier,
      intensity: r.intensity,
      rounds: Math.round(r.rounds),
      roundLengthSec: Math.round(r.roundLengthSec),
      restSec: Math.round(r.restSec),
      durationSec: Math.round(r.durationSec),
      combosCalled: Math.round(r.combosCalled),
      completed: r.completed,
    };
    const ids = sanitiseCombosCalledIds(r.combosCalledIds);
    if (ids) rec.combosCalledIds = ids;
    out.push(rec);
  }
  return out;
}

export function createHistory({ storage }) {
  let records = storage.read(KEYS.history, [], (raw) => sanitiseHistory(raw));
  const persist = () => storage.write(KEYS.history, records);

  const newest = (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt);

  return {
    all() {
      return [...records].sort(newest);
    },

    /**
     * Spec 6.3: an abandoned workout is only worth recording if at least one
     * round actually finished. Returns the record, or null if it was discarded.
     */
    add(record) {
      if (!record.completed && record.rounds < 1) return null;
      if (!isValidRecord(record)) return null;
      records.push(record);
      persist();
      return record;
    },

    inPeriod(period, now = Date.now()) {
      const from = periodStart(period, now);
      return this.all().filter((r) => Date.parse(r.startedAt) >= from);
    },

    /**
     * The streak is deliberately NOT filtered by period — "current streak" is a
     * property of now, not of the month you happen to be looking at.
     */
    summary(period, now = Date.now()) {
      const list = this.inPeriod(period, now);
      return {
        sessions: list.length,
        rounds: list.reduce((n, r) => n + r.rounds, 0),
        totalSec: list.reduce((n, r) => n + r.durationSec, 0),
        combosCalled: list.reduce((n, r) => n + r.combosCalled, 0),
        streak: computeStreak(records, now),
      };
    },

    /** Reverse-chronological, grouped into days. */
    groupedByDay(period, now = Date.now()) {
      const groups = new Map();
      for (const r of this.inPeriod(period, now)) {
        const key = localDayKey(r.startedAt);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      return [...groups.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([day, list]) => ({ day, records: list.sort(newest) }));
    },

    clear() {
      records = [];
      persist();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Compact form for the summary tiles: 45s, 12m, 1h 24m. */
export function formatTotal(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/* ------------------------------------------------------------------ *
 * Per-combo aggregation (Phase 6A)
 * ------------------------------------------------------------------ */

/**
 * Count how many times each combo id was called across records.
 * Old records without combosCalledIds are silently skipped.
 */
export function comboFrequency(records, { sport, since } = {}) {
  const counts = new Map();
  for (const r of records) {
    if (!r.combosCalledIds) continue;
    if (sport && r.sport !== sport) continue;
    if (since && Date.parse(r.startedAt) < since) continue;
    for (const id of r.combosCalledIds) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/**
 * How many combos in `pool` have been practiced at least once.
 * Returns { practiced, total, practicedIds }.
 */
export function comboCoverage(records, pool, { since } = {}) {
  const freq = comboFrequency(records, { since });
  const practicedIds = new Set();
  for (const c of pool) {
    if (freq.has(c.id)) practicedIds.add(c.id);
  }
  return { practiced: practicedIds.size, total: pool.length, practicedIds };
}

/**
 * Combo ids from `pool` sorted by ascending frequency (least practiced first).
 * Combos with zero appearances come before any with calls.
 */
export function leastPracticed(records, pool, { since, limit } = {}) {
  const freq = comboFrequency(records, { since });
  const sorted = pool
    .map((c) => ({ id: c.id, count: freq.get(c.id) || 0 }))
    .sort((a, b) => a.count - b.count);
  const ids = sorted.map((e) => e.id);
  return limit ? ids.slice(0, limit) : ids;
}

/* ------------------------------------------------------------------ *
 * Daily volume aggregation (Phase 6B)
 * ------------------------------------------------------------------ */

const INTENSITY_ORDER = ['light', 'medium', 'hard'];

function mode(arr) {
  if (!arr.length) return arr[0];
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = arr[0], bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

/**
 * Aggregate completed sessions into per-day summaries.
 * Multiple sessions on the same calendar day are collapsed into one entry.
 */
export function dailyVolume(records, { sport, since } = {}) {
  const days = new Map();
  for (const r of records) {
    if (!r.completed) continue;
    if (sport && r.sport !== sport) continue;
    if (since && Date.parse(r.startedAt) < since) continue;
    const key = localDayKey(r.startedAt);
    if (!key) continue;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(r);
  }
  const out = [];
  for (const [day, recs] of days) {
    out.push({
      day,
      rounds: recs.reduce((n, r) => n + r.rounds, 0),
      intensity: mode(recs.map((r) => r.intensity).filter((i) => INTENSITY_ORDER.includes(i))),
      roundLengthMin: mode(recs.map((r) => Math.round(r.roundLengthSec / 60))),
      sessions: recs.length,
    });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** "Today", "Yesterday", otherwise a written date. */
export function formatDayHeading(dayKey, now = Date.now()) {
  const today = localDayKey(now);
  if (dayKey === today) return 'Today';
  const y = new Date(now);
  y.setHours(12, 0, 0, 0);
  y.setDate(y.getDate() - 1);
  if (dayKey === localDayKey(y)) return 'Yesterday';

  const [year, month, day] = dayKey.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
