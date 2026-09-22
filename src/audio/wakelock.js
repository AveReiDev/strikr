/**
 * Keeps the screen on during a workout.
 *
 * iOS drops the lock when the app goes to the background, so it is re-acquired
 * on return. Requires a secure context (https or localhost) — over plain http
 * the API is simply absent, which is why the dev server serves https.
 */

export function createWakeLock({ onChange } = {}) {
  const supported = 'wakeLock' in navigator;
  let lock = null;
  let wanted = false;

  const notify = () => onChange?.({ supported, held: !!lock, wanted });

  async function acquire() {
    if (!supported || lock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; notify(); });
      notify();
    } catch (_) {
      lock = null;
      notify();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted && !lock) acquire();
  });

  return {
    supported,
    get held() { return !!lock; },

    async request() { wanted = true; await acquire(); },

    async release() {
      wanted = false;
      try { if (lock) await lock.release(); } catch (_) {}
      lock = null;
      notify();
    },
  };
}
