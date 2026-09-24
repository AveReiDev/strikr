/**
 * Service worker: makes the app work with no network at all.
 *
 * ── CACHE BUSTING, AND THE ONE MANUAL STEP ──────────────────────────────────
 *
 * There is no build step, so filenames never change — app.css is always
 * app.css. That removes the usual way of forcing browsers to fetch new files,
 * so the version below does that job instead.
 *
 *   ****  IF YOU EDIT ANY FILE IN THE APP, BUMP CACHE_VERSION.  ****
 *
 * Changing it makes the worker install a fresh cache and bin the old one.
 * Forget, and the phone may keep serving the previous version indefinitely.
 *
 * Two strategies, chosen per request type:
 *
 *   index.html          network first, cache as fallback. The page is small,
 *                       and this means a reload with signal always gets the
 *                       current app rather than a stale shell.
 *
 *   everything else     stale-while-revalidate: answer instantly from cache,
 *                       fetch a fresh copy in the background for next time.
 *                       Start-up stays instant and works in a gym with no
 *                       signal; updates land on the following launch.
 */

const CACHE_VERSION = 'strikr-v1.4.1';

/** Everything needed to run with no network. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/app.css',
  './data/config.json',
  './data/combos.json',
  './src/main.js',
  './src/engine/selector.js',
  './src/engine/timing.js',
  './src/engine/session.js',
  './src/engine/suggest.js',
  './src/audio/speech.js',
  './src/audio/context.js',
  './src/audio/wakelock.js',
  './src/store/storage.js',
  './src/store/settings.js',
  './src/store/library.js',
  './src/store/history.js',
  './src/store/backup.js',
  './src/ui/router.js',
  './src/ui/components/picker.js',
  './src/ui/screens/home.js',
  './src/ui/screens/workout.js',
  './src/ui/screens/settings.js',
  './src/ui/screens/combos.js',
  './src/ui/screens/history.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    let ok = 0;
    let failed = 0;
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) { await cache.put(url, res); ok++; }
        else { failed++; }
      } catch (_) { failed++; }
    }));
    console.log(`[SW] install: cached ${ok}/${SHELL.length}, failed ${failed}`);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    );
    await self.clients.claim();

    // After claiming, ask the page to verify it can find cached files.
    // This catches the case where install ran but fetch()es failed silently
    // (e.g. self-signed cert not trusted in the worker context on iOS).
    const cache = await caches.open(CACHE_VERSION);
    const cachedKeys = await cache.keys();
    if (cachedKeys.length < SHELL.length) {
      console.log(`[SW] activate: cache has ${cachedKeys.length}/${SHELL.length} — repopulating from page context`);
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'cache-status') {
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const keys = await cache.keys();
      event.source.postMessage({
        type: 'cache-status',
        version: CACHE_VERSION,
        count: keys.length,
        expected: SHELL.length,
      });
    })();
  }

  if (event.data === 'prime-cache') {
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      let added = 0;
      await Promise.all(SHELL.map(async (url) => {
        const existing = await cache.match(url);
        if (existing) return;
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) { await cache.put(url, res); added++; }
        } catch (_) {}
      }));
      event.source.postMessage({
        type: 'prime-result',
        added,
        total: (await cache.keys()).length,
        expected: SHELL.length,
      });
    })();
  }
});

const isHtml = (request) =>
  request.mode === 'navigate' ||
  (request.headers.get('accept') || '').includes('text/html');

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch anything that is not ours, and never cache a non-GET.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/install-cert') return;

  if (isHtml(request)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request)
        ?? await cache.match('./index.html');
      try {
        // Race the network against a short timeout so the app opens fast
        // at the gym (no server). If the network wins, update the cache
        // for next time; if it loses or fails, serve the cached copy.
        const fresh = await Promise.race([
          fetch(request),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 2000)
          ),
        ]);
        // Never let an error page (a 404 from a misconfigured server, say)
        // replace the good cached shell.
        if (fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (_) {
        return cached ?? Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);

    const network = fetch(request)
      .then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
      .catch(() => null);

    // Cache first when we have it; the background fetch refreshes for next time.
    return cached ?? (await network) ?? Response.error();
  })());
});
