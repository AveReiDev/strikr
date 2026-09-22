/**
 * Owns the shared AudioContext: the keep-alive tone and the bell.
 *
 * WHY THE KEEP-ALIVE EXISTS — this is not an optimisation.
 *
 * Phase 0 measured that iOS tears the system audio session down about two
 * seconds after speech ends. Restarting it costs ~317 ms before the voice is
 * heard, and a request landing exactly on the boundary costs ~631 ms. Because
 * the gap length depends on the combo's action count, some gaps fall above the
 * boundary and some below — so the delay was not merely large, it was uneven,
 * which is worse for a rhythm the user is trying to move to.
 *
 * Holding an inaudible tone open keeps the session alive: start latency drops
 * to ~15 ms and stays flat at every gap length. Measured not to affect
 * background music, which ducks and recovers exactly as it does without it.
 *
 * See PHASE0-REPORT.md sections 3 and 4.
 */

/** Longest we will wait for the audio context to wake before starting anyway. */
const RESUME_TIMEOUT_MS = 1000;

export function createAudio({ config }) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const supported = !!Ctx;
  const cfg = config.audio;
  let ctx = null;
  let keepAlive = null;

  return {
    supported,
    get state() { return ctx ? ctx.state : 'none'; },

    /**
     * Must be called from inside the user gesture that starts the workout.
     * `resume()` is asynchronous — Phase 0 saw the context still reporting
     * "suspended" immediately after calling it, so this awaits properly.
     */
    async prime() {
      if (!supported) return false;
      try {
        if (!ctx) ctx = new Ctx();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = cfg.keepAliveGain;
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.02);
        // resume() can also never settle: a browser that has suspended audio
        // for a backgrounded page leaves the promise pending indefinitely.
        // startWorkout awaits this, so an uncapped wait means the workout
        // silently never begins. Priming is an optimisation, not a
        // prerequisite — give up and carry on.
        await Promise.race([
          ctx.resume(),
          new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
        ]);
        return ctx.state === 'running';
      } catch (_) {
        return false;
      }
    },

    /** Hold the audio session open for the duration of the workout. */
    startKeepAlive() {
      if (!ctx || keepAlive) return;
      try {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = cfg.keepAliveHz;
        g.gain.value = cfg.keepAliveGain;   // inaudible, but must not be zero
        o.connect(g).connect(ctx.destination);
        o.start();
        keepAlive = { o, g };
      } catch (_) {}
    },

    stopKeepAlive() {
      if (!keepAlive) return;
      try { keepAlive.o.stop(); } catch (_) {}
      keepAlive = null;
    },

    bell() {
      if (!ctx) return;
      try {
        if (ctx.state !== 'running') ctx.resume();
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(cfg.bellHz, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(cfg.bellGain, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + cfg.bellDecaySec);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + cfg.bellDecaySec + 0.1);
      } catch (_) {}
    },
  };
}
