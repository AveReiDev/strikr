/**
 * Gap and duration maths. Pure functions, no clock of their own.
 */

/**
 * The gap is EXECUTION time: measured from the end of one spoken callout to the
 * start of the next. A longer combo takes longer to throw, so it gets a longer
 * gap, at every intensity.
 */
export function gapMsFor(combo, intensity) {
  return intensity.baseGapMs + intensity.perActionMs * combo.actions;
}

/** voiceSpeedPct (0-100) maps linearly onto the utterance rate. */
export function voiceRate(voiceSpeedPct, range) {
  const pct = Math.min(100, Math.max(0, voiceSpeedPct));
  return range.min + (pct / 100) * (range.max - range.min);
}

/**
 * How long a callout will take to say. Used only by the round-end lookahead —
 * the real timing always waits for the voice to report it has finished, never
 * for this estimate to elapse.
 *
 * Fitted to measured iOS Safari speech in Phase 0. See PHASE0-REPORT.md §6.
 */
export function estimateSpeechMs(text, rate, speechEstimate) {
  return (speechEstimate.fixedMs + speechEstimate.msPerChar * text.length) / rate;
}

/**
 * Should we start this callout, given how much of the round is left?
 *
 * Better to end a round with two seconds of silence than to have the bell cut a
 * combo in half. We allow an overrun of at most `lookaheadMs`.
 */
export function canStartCallout({ remainingMs, estSpeechMs, gapMs, lookaheadMs }) {
  return estSpeechMs + gapMs <= remainingMs + lookaheadMs;
}

/**
 * Case-insensitive whole-word substitutions, applied to the SPEECH string only.
 * The display string is never touched.
 */
export function applyPronunciation(text, pronunciation) {
  let out = text;
  for (const [from, to] of Object.entries(pronunciation || {})) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b does not fire next to a hyphen, so match on non-word boundaries too.
    out = out.replace(new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, 'gi'), (m, pre) => pre + to);
  }
  return out;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
