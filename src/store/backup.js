/**
 * Backup and restore of everything the user owns: settings, their combo
 * library changes, and workout history.
 *
 * Why this exists: localStorage belongs to one origin — protocol, host and
 * port. Served from the Mac's LAN IP, every IP change is a new origin and an
 * empty app. An exported file is the only way data survives that, or a
 * "Clear website data" in Safari.
 *
 * Works on the stored payloads directly. Nothing is trusted on the way in:
 * import only writes to storage, and the stores' own sanitisers filter it on
 * the next load, exactly as they would a corrupt value.
 */

import { KEYS } from './storage.js';

export const BACKUP_FORMAT = 1;

const raw = (storage, key) => storage.read(key, null, (data) => data);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function createBackup(storage, now = Date.now()) {
  return {
    app: 'strikr',
    format: BACKUP_FORMAT,
    exportedAt: new Date(now).toISOString(),
    settings: raw(storage, KEYS.settings),
    library: raw(storage, KEYS.library),
    history: raw(storage, KEYS.history),
  };
}

export function backupFilename(now = Date.now()) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `strikr-backup-${day}.json`;
}

/** Parse and check the envelope. Returns { ok, backup } or { ok: false, error }. */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!isObject(data) || data.app !== 'strikr') {
    return { ok: false, error: 'That file is not a STRIKR backup.' };
  }
  if (data.format !== BACKUP_FORMAT) {
    return { ok: false, error: `Unsupported backup format (${data.format}).` };
  }
  return { ok: true, backup: data };
}

/**
 * Restore a parsed backup, MERGING rather than replacing where it can, so
 * importing an old file on a device that has trained since loses nothing:
 *
 *   history   union by session id; the device's own copy wins a clash
 *   library   customs unioned by id, overrides merged key by key (backup wins)
 *   settings  replaced — there is no sensible merge of two sets of choices
 *
 * Returns counts for the confirmation message. The caller should reload so
 * the stores re-read, and re-sanitise, what was written.
 */
export function restoreBackup(storage, backup) {
  const result = { historyAdded: 0, customsAdded: 0, settings: false };

  if (Array.isArray(backup.history)) {
    const mine = raw(storage, KEYS.history);
    const current = Array.isArray(mine) ? mine : [];
    const ids = new Set(current.map((r) => r?.id));
    const incoming = backup.history.filter((r) => isObject(r) && typeof r.id === 'string' && !ids.has(r.id));
    result.historyAdded = incoming.length;
    storage.write(KEYS.history, [...current, ...incoming]);
  }

  if (isObject(backup.library)) {
    const mine = raw(storage, KEYS.library);
    const current = isObject(mine) ? mine : {};
    const customs = Array.isArray(current.customs) ? current.customs : [];
    const ids = new Set(customs.map((c) => c?.id));
    const incoming = (Array.isArray(backup.library.customs) ? backup.library.customs : [])
      .filter((c) => isObject(c) && typeof c.id === 'string' && !ids.has(c.id));
    result.customsAdded = incoming.length;
    storage.write(KEYS.library, {
      overrides: {
        ...(isObject(current.overrides) ? current.overrides : {}),
        ...(isObject(backup.library.overrides) ? backup.library.overrides : {}),
      },
      customs: [...customs, ...incoming],
    });
  }

  if (isObject(backup.settings)) {
    storage.write(KEYS.settings, backup.settings);
    result.settings = true;
  }

  return result;
}
