# STRIKR — project summary

Last updated 19 September 2026.

---

## Where the project stands

| Phase | State |
|---|---|
| 0 — Audio and timing spike | **Done**, verdict: go. See `PHASE0-REPORT.md` |
| 1 — Engine and workout loop | **Done**, tested on the bag, constants tuned |
| 2 — Settings and persistence | **Done**, tested on device |
| 3 — Combo library | **Done**, tested on device |
| 4 — History | **Done**, tested on device |
| 5 — Packaging and polish | **Done**, tested on device |
| 6A — Per-combo tracking | **Done**, tested on device |
| 6B — Progressive training | **Done**, tested on device |
| 6C — Constraint rounds | **Done**, awaiting device test |

### Installing it on your phone

1. `python3 serve.py` on the Mac.
2. Open the printed `https://…/index.html` address in **Safari** on the phone,
   tapping past the certificate warning.
3. Share → **Add to Home Screen**.
4. Open it from the icon. It now runs offline — turn the Mac's server off and it
   still works.

### The one manual step, forever

There is no build step, so filenames never change and browsers have no way to
tell that `app.css` is new. **After editing any file in the app, bump
`CACHE_VERSION` at the top of `sw.js`.** Forget, and an installed phone may keep
serving the old version. This is written at the top of `sw.js` too.

**158 tests pass.** Run them with:

```bash
cd /Users/averylaptop/Desktop/Claude/strikr && node --test 'test/*.test.js'
```

Serve the app (https is needed for wake lock on the phone):

```bash
cd /Users/averylaptop/Desktop/Claude/strikr && python3 serve.py
```

If that reports the port is in use, a server is already running in another
terminal tab and is already serving the latest code — just open the URL.

---

## The finding that shaped the whole project

Phase 0 existed to test one assumption: is iOS Safari's speech synthesis good
enough for a workout app? The first measurements said **no** — 311 ms median
latency between asking for a callout and hearing it, with a 665 ms worst case.
That failed the thresholds set before measuring.

Digging into the distribution rather than the average showed the delay was not
noise. It was perfectly reproducible and depended entirely on **how long the gap
before it had been**:

| gap before the callout | cold | with keep-alive |
|---|---|---|
| 400–1600 ms | ~5 ms | ~5 ms |
| **2000 ms** | **631 ms** | 23 ms |
| 2400 ms+ | ~317 ms | ~15 ms |

iOS tears down the system audio session about two seconds after speech ends.
Restarting it costs ~317 ms; landing exactly on the boundary costs ~631 ms.

**Holding an inaudible tone open for the workout keeps the session alive**, which
drops latency to 15 ms and flattens it across every gap length. Measured not to
affect background music — YouTube and Spotify duck during a callout and recover,
identically with or without it.

This is why `src/audio/context.js` exists and why the keep-alive is a
requirement rather than an optimisation. Without it the delay is not merely
large, it is *uneven*, because whether a gap falls above or below the two-second
boundary depends on the combo's action count.

---

## The other significant discovery: intensity was modelled wrongly

After the first bag session the report was: 7-strike combos need more time,
especially on Hard; short combos feel right.

That turned out to be a real modelling error rather than a number being too
small. `perActionMs` was 700 / 600 / 500 across Light / Medium / Hard — so
**Hard gave you less time per individual strike**. But the time to physically
throw a rear body kick does not change because you selected Hard. The shortfall
multiplied by seven, which is why it only failed on long combos.

The fix: `perActionMs` is now identical (700 ms) at every intensity, and
`baseGapMs` alone carries the difference. Intensity now means *less recovery*,
not *less execution time*. There is a test asserting the three values stay equal
so this cannot quietly regress.

Confirmed on the bag: "this feels really smooth."

---

## What testing did and did not catch

Worth recording, because the pattern repeated.

**The unit tests were good at maths and rules.** Tier weighting over 10,000
draws, the no-repeat window, gap arithmetic, the round-end lookahead across
every intensity and seed, storage falling back on corrupt data, streak logic
across timezone and daylight-saving edges.

**Every single bug that reached the device was a wiring bug**, and none were
findable by unit test:

- **Voice and speed controls did nothing.** `main.js` passed the speech module a
  *copy* of the settings, so it read a snapshot frozen at page load. 58 tests
  passed while the controls were inert. Now `createSpeech` throws immediately if
  handed a copy, and `test/speech.test.js` covers it.
- **Every completed workout threw an uncaught error.** The final tick emits
  `finished`, which clears the session — and the next line dereferenced it. The
  record still saved, so it was invisible from outside.
- **The start path could hang forever.** `startWorkout` awaited
  `AudioContext.resume()`, which never settles in a backgrounded page. Capped at
  one second; the wake lock request is no longer awaited at all.
- **Layout bugs**: subtitles not stacking under titles, grid columns refusing to
  shrink below their content (`1fr` needs to be `minmax(0, 1fr)`), words breaking
  mid-syllable.

The lesson for the remaining work: a browser smoke test at the end of every
phase is not ceremony. It is the only thing that catches this class of problem.

---

## Decisions taken, and why

| Decision | Reasoning |
|---|---|
| `perActionMs` equal across intensities | Execution time is physical; intensity should only change recovery |
| `baseGapMs` +300 ms after Phase 0 | Compensates for audio latency that was silently padding every gap during the bag test |
| Keep-alive tone always on during a workout | See above — required, not optional |
| Custom combos have no name field | Spec defines them as display string, sport, tier, frequency. Screenshots show a name (`123LOW`); the spec wins |
| Shipped combos are visible in the library | The spec requires they be disableable, which means reachable |
| Steppers became pickers | Cycling through nine round counts takes eight taps and hides the options. Your call, and you were right |
| Intensity labels show a range | The gap widens with combo length, so the reference's "4s rest" was never the whole truth |
| Streak ignores the period filter | "Current streak" is a property of now, not of the month being viewed |
| Weeks start Monday | Not specified; one line to change in `src/store/history.js` |
| Streak banner omitted | Motivational chrome restating a number already on screen; not in spec §8 |
| No account / subscription / notification / support sections | Spec §2 rules them out, even though the screenshots show them |

---

## Phase 5, as built

**Visual pass.** Re-examined every reference screenshot, including two
(`IMG_4448`, `IMG_4452`) that had not been looked at closely earlier. Three
mismatches found and fixed:

- Sport heading is now "Select sport".
- Intensity is now Light / Medium / Hard as three side-by-side chips with a
  title over a sub-line, and Custom as a full-width bar beneath — matching the
  reference rather than four identical bars.
- Settings now puts **Appearance before Workout**, with the reference's wording
  ("Switch between light and dark theme") and a moon icon by the toggle.

**Icons.** `tools/make-icons.py` draws them with PIL and writes `icons/*.png`.
Dev tooling only — run once, commit the output; the app ships no build step and
no image dependencies. Design is the near-black field, heavy white "S" and red
accent dot, because the full wordmark is unreadable at 60px. Four sizes
including a padded maskable variant, since the platform crops to its own shape.

**Manifest.** `manifest.webmanifest`: standalone display, portrait, colours
taken from `tokens.css`.

**Service worker.** `sw.js` precaches all 28 app files. Two strategies:
`index.html` is network-first with a cache fallback, so a reload with signal
always gets the current app; everything else is stale-while-revalidate, so
start-up is instant and works with no signal, with updates landing on the next
launch. Registered after boot so a failure there can never stop the app
loading.

**Standalone polish.** No rubber-band scrolling, no text selection or iOS
callout menus on controls, and text inputs pinned to 16px so focusing the combo
search cannot zoom the page. Safe-area insets were already handled.

**Verified offline for real**: killed the server, reloaded, and the app came up
fully — all 90 combos, styling, every screen.

---

## Post-v1 fixes (September 2026)

- **Service worker loading speed.** The network-first strategy for `index.html`
  could hang for 30–60s at the gym (no server access). Added a 2-second timeout
  so it falls back to cache quickly. `sw.js` v1.0.4.
- **Voice volume.** iOS ducks background music during speech (system-level, no
  web API to prevent it). Added `speechVolume: 0.55` in `config.json` so the
  voice is quieter relative to background music. Adjustable.

## Phase 6A, as built

Per-combo tracking. The history record now includes `combosCalledIds` — the
full sequence of combo ids called during a workout. Three aggregation
functions (`comboFrequency`, `comboCoverage`, `leastPracticed`) power the UI.
A "Focus: Weak spots" toggle on Home biases the selector toward under-practiced
combos via a `1/(count+1)` weight multiplier. The Combos screen shows coverage
and per-combo call counts. 9 new tests (134 total). Backward-compatible with
old history records.

## Phase 6B, as built

Progressive training. A nullable `goal` object in settings holds `{ rounds,
intensity, roundLengthMin }`. `dailyVolume()` in `history.js` aggregates
completed sessions per calendar day (summing rounds, mode for intensity and
round length). `computeSuggestion()` in `engine/suggest.js` is a pure
function: given a goal, recent daily volumes, and current settings, it returns
the next step. The algorithm nudges one dimension at a time toward the goal:
+1 round first, then intensity up (with a 70% round reset), then round length
up (same reset). With no history it falls back to current settings. Goal
reached is detected when any day meets or exceeds all three dimensions.

Settings screen gets a "Training goal" section with three pickers (target
rounds, intensity, round length) and a "Clear goal" button (hidden when no
goal is set). Home screen shows a suggestion card above the sport selector
when a goal is set: "SUGGESTED WORKOUT / N rounds · Intensity · M min" with
Load and Dismiss buttons, or "GOAL REACHED" with a "Set new goal" button.
Load applies the suggested settings. Dismiss hides the card for the session.

15 new tests (149 total). Backward-compatible — no new storage keys, no
schema version change. `sw.js` bumped to v1.2.0.

## Phase 6C, as built

Constraint rounds / specialty rounds. Every combo in `combos.json` now carries
a `tags` array. Five category tags for regular combos (`hands`, `kicks`,
`elbows`, `body`, `defensive`) and seven drill tags for single-strike entries
(`jab`, `cross`, `hook`, `uppercut`, `kick`, `teep`, `knee`).

25 single-strike entries added (6 boxing, 10 Muay Thai, 9 kickboxing) with
`single: true`. Singles are excluded from the normal pool and only appear when
the user selects a drill-tag focus. `buildPool` in `selector.js` handles both
modes: a category-tag focus filters regular combos by tag; a drill-tag focus
returns only matching singles.

Home screen gains a dynamic Focus picker below the intensity row. Options are
computed per-sport from actual combo tags, so irrelevant options (e.g. "Elbows"
for boxing) never appear. Combo tags and drill tags are visually separated.
Sport switching resets the focus and re-renders the picker. The existing
weak-spots toggle stays independent — you can combine "Kicks" + "Weak spots".

Pool-size guard: if a focus yields an empty pool, the workout refuses to start
with a descriptive error; if the pool has fewer than 3 combos, a warning is
shown but the workout proceeds.

Combos screen shows tag chips on each combo card. The custom combo add/edit
form includes a multi-select tag picker. Tags are sanitised to known values
on save.

9 new tests (158 total). No new storage keys, no schema version change.
`sw.js` bumped to v1.3.0. Browser smoke-tested: focus picker renders per sport,
jab drill workout calls correct single strikes, console clean.

## Still open

- **6C needs a device test.**
- **Voice speed at its extremes.** 0% may be too slow to be useful and 100% too
  fast to parse mid-round. `voiceRateRange` in `data/config.json` is one line if
  the range wants narrowing.

---

## Architecture, for orientation

```
index.html            shell: five screen containers plus the tab bar
data/
  combos.json         90 combos + 25 singles — shipped, read-only, never written to storage
  config.json         every tunable constant: gaps, weights, voice, audio
src/
  engine/             pure and testable; no clock, no DOM, no global randomness
    selector.js         weighted two-stage draw with a seeded PRNG
    timing.js           gap maths, speech estimate, round-end lookahead
    session.js          the round/rest state machine — owns no timers
    suggest.js          progressive training suggestion algorithm
  audio/
    speech.js           the ONLY file touching SpeechSynthesis
    context.js          shared AudioContext: keep-alive tone and bell
    wakelock.js         screen stays on, re-acquires on return to foreground
  store/                localStorage, schema-versioned, every read defensive
    storage.js  settings.js  library.js  history.js
  ui/
    router.js  components/picker.js  screens/*.js
  main.js             wiring; the only file that owns a clock
styles/
  tokens.css          every colour and size; light mode is a token override
  app.css             components only, no raw colours
test/                 node --test, 158 tests
```

Three storage keys, independently readable so one corrupt value cannot brick the
app: `strikr.v1.settings`, `strikr.v1.library`, `strikr.v1.history`. The shipped
combo library is never written into storage, so regenerating `combos.json` later
will not clobber your data.
