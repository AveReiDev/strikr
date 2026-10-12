/**
 * The strike dictionary. Pure — no clock, no DOM, no global randomness.
 *
 * Level, range and balance category are derived from a strike's name using the
 * ordered rules in data/strikes.json, never hand-tagged per combo. Custom
 * combos are free text, and hand tags drift: fourteen combos once carried
 * `kicks` while containing no kick.
 *
 * Callers pass the parsed strikes.json in (main.js keeps it on config.strikes).
 */

const SEP = ' – ';

const compiled = new WeakMap();

/** Regexes built once per dictionary object. */
function compile(dict) {
  if (!dict || typeof dict !== 'object') return { rules: [], inside: null, outside: null };
  let c = compiled.get(dict);
  if (c) return c;
  c = {
    rules: (dict.rules ?? []).map(({ match, ...fields }) => ({ re: new RegExp(match, 'i'), fields })),
    inside: dict.boxingRange?.inside ? new RegExp(dict.boxingRange.inside, 'i') : null,
    outside: dict.boxingRange?.outside ? new RegExp(dict.boxingRange.outside, 'i') : null,
  };
  compiled.set(dict, c);
  return c;
}

/**
 * Classify one spoken strike. Returns null for stage directions such as
 * "(land switched)" and for empty text, `kind: 'unknown'` when no rule
 * matches. Boxing swaps the four ranges for inside / outside.
 */
export function classifyStrike(token, dict, sport) {
  const name = String(token ?? '').trim();
  if (!name || name.startsWith('(')) return null;
  const { rules, inside, outside } = compile(dict);
  const lower = name.toLowerCase();
  const hit = rules.find((r) => r.re.test(lower));
  if (!hit) return { name, kind: 'unknown' };

  const out = { name, ...hit.fields };
  if (out.kind === 'feint') {
    // A jab feint still draws the eye to the jab; balance counts it as one.
    out.category = classifyStrike(lower.replace(/\s*feint$/, ''), dict, sport)?.category;
  }
  if (sport === 'boxing' && out.kind === 'strike') {
    out.range = inside?.test(lower) ? 'inside' : outside?.test(lower) ? 'outside' : undefined;
  }
  return out;
}

/** The segments of a combo's display, stage directions included. */
export function segmentsOf(combo) {
  return String(combo?.display ?? '').split(SEP).map((s) => s.trim()).filter(Boolean);
}

/** Every classified segment of a combo, in order, stage directions dropped. */
export function classifyCombo(combo, dict) {
  return segmentsOf(combo).map((s) => classifyStrike(s, dict, combo?.sport)).filter(Boolean);
}

/**
 * What a combo works.
 *   levels / ranges   distinct values, in the order first reached
 *   levelChanges      adjacent strikes that switch level; defence, footwork and
 *                     feints in between are skipped over, not counted as breaks
 *   weapons           distinct weapons (punch, kick, knee, elbow, clinch)
 *   unknown           names no rule matched
 */
export function profileOf(combo, dict) {
  const parts = classifyCombo(combo, dict);
  const strikes = parts.filter((p) => p.kind === 'strike');
  const distinct = (key) => [...new Set(strikes.map((s) => s[key]).filter(Boolean))];

  let levelChanges = 0;
  let prev = null;
  for (const s of strikes) {
    if (!s.level) continue;
    if (prev && s.level !== prev) levelChanges += 1;
    prev = s.level;
  }

  return {
    levels: distinct('level'),
    ranges: distinct('range'),
    weapons: distinct('weapon'),
    levelChanges,
    defense: parts.some((p) => p.kind === 'defense'),
    unknown: parts.filter((p) => p.kind === 'unknown').map((p) => p.name),
  };
}
