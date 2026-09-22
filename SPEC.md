# STRIKR — Personal Striking Combo Trainer

## 1. What this is

A single-user web app that calls out striking combinations on a timer so the user
can train bag work or shadow boxing without a coach. The user does not know which
combo is coming; they react to the call. It replaces a round timer plus a coach.

This is a personal-use clone. It has one user. There is no server, no account,
no sync, no analytics, and no monetisation.

## 2. Non-goals — do not build these

- No accounts, login, sign-up, profile, or subscription/paywall screens.
- No backend, database, or network calls of any kind at runtime.
- No onboarding flow or tutorial coachmarks.
- No "number notation" (1-2-3) mode. Named strikes only.
- No analytics, crash reporting, or third-party SDKs.
- No push notifications. (Settings shows daily reminder / streak alert toggles in
  the reference screenshots — omit them entirely.)
- No social, sharing, or export features.

## 3. Platform and hard constraints

- Target: **iPhone Safari, installed to the home screen via Share > Add to Home Screen.**
  Desktop Chrome is the development target; iPhone Safari is the acceptance target.
- **Vanilla JavaScript, ES modules, no framework, no build step, no npm runtime
  dependencies.** The finished app must run by serving the folder statically.
  Dev tooling (a test runner, a static server) is fine; runtime dependencies are not.
- Must work fully offline after first load (service worker, Phase 5).
- All colours, sizes, and engine constants come from config or CSS custom properties.
  No magic numbers scattered through logic.
- The combo engine must be **pure, deterministic, and testable**: given a seed and a
  pool, it returns the same sequence. No randomness reaches into DOM code.

## 4. Architecture

```
/
  index.html
  manifest.webmanifest        (Phase 5)
  sw.js                       (Phase 5)
  /data
    combos.json               default combo library — SHIPPED, treated as read-only
    config.json               engine + UI constants
  /src
    engine/
      selector.js             weighted combo selection, pure
      timing.js               gap and duration maths, pure
      session.js              round/rest state machine, pure (emits events, owns no timers)
    audio/
      speech.js               the ONLY file that touches SpeechSynthesis
      wakelock.js
    store/
      storage.js              localStorage read/write, schema-versioned
      settings.js
      history.js
      library.js              merges shipped combos.json with user overrides + customs
    ui/
      screens/                home.js, combos.js, history.js, settings.js, workout.js
      components/
      router.js
    main.js
  /styles
    tokens.css                colours, type scale, spacing — all custom properties
    app.css
  /test
    *.test.js                 node --test, engine only
  /reference
    *.png                     screenshots of the app being cloned
```

**`audio/speech.js` is a boundary.** Everything above it asks for "speak this string,
tell me when you're done". If we later swap device text-to-speech for pre-recorded
audio clips, only this file changes. Do not call `speechSynthesis` anywhere else.

**`engine/session.js` owns no timers.** It is a state machine that is *ticked* by the
UI layer. This makes it unit-testable by feeding it a fake clock.

## 5. Data model

### 5.1 combos.json (shipped default library — 90 combos)

```json
{
  "schemaVersion": 1,
  "combos": [
    {
      "id": "mt-beg-01",
      "sport": "muaythai",
      "tier": "beginner",
      "display": "Jab – Cross",
      "speech": "Jab, Cross",
      "actions": 2,
      "frequency": "common",
      "enabled": true,
      "custom": false
    }
  ]
}
```

- `sport`: `muaythai` | `boxing` | `kickboxing`
- `tier`: `beginner` | `intermediate` | `advanced`
- `display`: shown on screen. May contain parenthetical stage directions such as
  `(land switched)`.
- `speech`: passed to the voice. Parentheticals are already stripped. **Never speak
  the `display` string.**
- `actions`: number of segments including parentheticals — parentheticals consume
  real time on the bag, so they count for timing but not for speech.
- `frequency`: `occasional` | `common` | `constant` — a relative selection weight.
- `enabled`: false removes it from the pool without deleting it.

### 5.2 config.json

See the file. Key sections: `intensity` (gap formula constants), `frequencyWeights`,
`tierWeights`, `noRepeatWindow`, `defaults`, `voiceRateRange`, `pronunciation`.

### 5.3 localStorage

Namespaced, schema-versioned, each key independently readable so one corrupt key
cannot brick the app. Reads must be defensive — a missing or malformed key falls
back to defaults rather than throwing.

- `strikr.v1.settings` — user settings
- `strikr.v1.library` — user's custom combos and per-combo overrides (`enabled`,
  `frequency`) keyed by combo id. **Never write the shipped library back into
  storage**, so updating `combos.json` later does not clobber user data.
- `strikr.v1.history` — session records

History record:
```json
{
  "id": "uuid",
  "startedAt": "ISO-8601",
  "sport": "muaythai",
  "tier": "advanced",
  "intensity": "light",
  "rounds": 3,
  "roundLengthSec": 120,
  "restSec": 30,
  "durationSec": 360,
  "combosCalled": 42,
  "completed": true
}
```

## 6. The engine

### 6.1 Combo selection

Two-stage weighted draw.

1. Build the pool: combos where `sport` matches, `enabled` is true, and
   `tierRank(combo) <= tierRank(selected)`. Tier ranks: beginner 0, intermediate 1,
   advanced 2. (Advanced draws from all three; beginner draws from beginner only.)
2. **Pick a tier** using `tierWeights` — `selected` / `oneBelow` / `twoBelow` —
   renormalised over the tiers that actually have combos in the pool. Selecting
   beginner therefore yields 100% beginner.
3. **Pick a combo within that tier**, weighted by `frequencyWeights[combo.frequency]`.
4. If the drawn id appears in the last `noRepeatWindow` calls, redraw. After
   `maxRedraws` attempts, accept it anyway (a pool of two combos must still work).

Randomness comes from an injected seeded PRNG so tests are deterministic.

### 6.2 Timing

The gap between combos is **execution time, measured from the end of the spoken
callout to the start of the next one**:

```
gapMs = intensity.baseGapMs + (intensity.perActionMs * combo.actions)
```

A two-strike beginner combo therefore gets a short gap and a seven-action advanced
combo gets a long one, at every intensity level.

**Do not begin a new callout** if `estimatedSpeechMs + gapMs` would overrun the
remaining round time by more than `roundEndLookaheadMs`. Better to end a round with
two seconds of silence than to have the bell cut a combo in half.

### 6.3 Session state machine

```
IDLE
  -> PREPARING     acquire wake lock; warm up the voice (see 7.1)
  -> COUNTDOWN     config countdownSec, spoken/beeped down to "go"
  -> ROUND         call combos until the round timer expires; bell
  -> REST          restBetweenRoundsSec; announce "10 seconds" and a 3-2-1 lead-in
  -> ROUND ...     repeat for roundsPerWorkout
  -> COMPLETE      write history record, release wake lock
```

From any state the user can abort back to IDLE. Aborting mid-workout writes a
history record with `completed: false` only if at least one round finished.

Pausing: a pause control that suspends the round clock and cancels any in-flight
utterance. Resuming restarts from the top of the current gap, not mid-callout.

## 7. Audio and screen behaviour — the risky part

### 7.1 Voice warm-up
iOS Safari will not speak unless the first utterance is triggered inside a user
gesture, and the first utterance is often late. In the tap handler for START,
immediately speak a zero-length or near-silent utterance to prime the engine,
*then* begin the countdown. The countdown exists partly to hide this.

### 7.2 Wake lock
Request a `navigator.wakeLock` screen lock when the workout starts; release on
completion or abort. Re-acquire on `visibilitychange` back to visible, because iOS
drops the lock on backgrounding. If the API is unavailable, degrade gracefully and
show a one-line notice suggesting the user raise their auto-lock time.

### 7.3 Interruption
On `visibilitychange` to hidden, auto-pause the workout. Timers and speech are not
reliable in the background; pretending otherwise produces a workout that silently
desynchronises.

### 7.4 Voice selection
`voiceGender` male/female maps onto available `en-*` system voices by a configurable
name list, with a documented fallback to the default voice if no match exists. Voice
availability differs per device and per iOS version — **do not hard-code voice names
in logic**; put the candidate lists in config.

### 7.5 Pronunciation
Apply `config.pronunciation` as case-insensitive whole-word substitutions to the
`speech` string only.

## 8. Screens

Bottom tab bar, four tabs, matching the reference screenshots: HOME, COMBOS,
HISTORY, SETTINGS.

**HOME** — Sport (Boxing / Muay Thai / Kickboxing), Difficulty (Beginner /
Intermediate / Advanced), Intensity (Light / Medium / Hard / Custom), Round Length
(1/2/3/4/5/10 min), and a full-width red START ROUND button pinned above the tab bar.
Selecting Custom intensity reveals base-gap and per-action controls.

**WORKOUT** (full screen, no tab bar) — the current combo in large type, round
number, time remaining in the round, a progress indicator, pause and abort. Must be
legible from three metres away with sweat in your eyes: huge type, high contrast,
minimal chrome. Show the *next* combo nowhere — surprise is the point.

**COMBOS** — the user's library, grouped by sport, showing tier and frequency per
combo, with active toggle, edit, and delete. A `+` adds a custom combo (display
string, sport, tier, frequency). Search field filters by name. Custom combos are
deletable; shipped combos can be disabled and reweighted but not deleted.
When a custom combo is saved, derive `speech` and `actions` from the display string
using the same rule as the generator: split on the en dash, drop parentheticals for
speech, count all segments for actions.

**HISTORY** — period filter (This Week / This Month / All Time), summary tiles
(sessions, rounds, total time, day streak), and a reverse-chronological session list
grouped by day with a REPEAT SESSION action that loads those settings onto Home.
Day streak counts consecutive calendar days with at least one completed session,
in the device's local timezone.

**SETTINGS** — Appearance (dark mode), Workout (rounds per workout, rest between
rounds, countdown timer, voice male/female, voice speed slider), and About (version).
Include a clearly-marked destructive "Reset all data" that clears the three
localStorage keys behind a confirmation. Omit account, subscription, notification,
and support sections.

## 9. Visual design

Match the reference screenshots in `/reference`. Read them before writing CSS.

- Dark by default: background near-black, cards a shade lighter, hairline borders.
- One accent colour: a saturated red, used for the primary action, the active
  indicator dot, and destructive actions only.
- Headings: uppercase, heavy weight, tight leading, wide letter-spacing.
- Selection controls are full-width bars, not pills; the selected item inverts to a
  white background with black text.
- Every colour and type size is a CSS custom property in `tokens.css`. Light mode is
  a token override, not a second stylesheet.
- Tap targets minimum 44px. Respect `env(safe-area-inset-bottom)` for the tab bar.

## 10. Testing

**Engine tests (`node --test`), required before any phase is considered done:**
- Seeded selection produces a reproducible sequence.
- The no-repeat window is honoured, and a two-combo pool still terminates.
- Tier weighting: over 10,000 draws at Advanced, the observed tier split is within
  a few percent of 50/30/20; at Beginner it is 100% beginner.
- Frequency weighting: a `constant` combo is drawn roughly 3x as often as an
  `occasional` one in a matched pool.
- Gap maths for each intensity across action counts 2 through 7.
- The round-end lookahead never schedules a callout that overruns the round.
- Storage: a malformed or absent localStorage value falls back to defaults and does
  not throw.

**Browser smoke test, required at the end of every phase:** load the app in a real
browser, run a shortened workout (1 round, 1 minute), and confirm no console errors
and correct audio sequencing. Node tests cannot catch broken module loading, CSS
that hides a control, or a click handler that silently never binds.

**Device acceptance, by the user:** each phase ends with the app in a state that can
be loaded on an iPhone and tried.

## 11. Build phases

Complete one phase, run the tests, then **stop and report**. Do not begin the next
phase until the user has tested on their phone and said go.

### Phase 0 — Audio and timing spike (throwaway)
A single self-contained `spike.html`, disposable, deleted before Phase 1.
- A START button that acquires the wake lock and warms up the voice.
- Calls five hard-coded combos of varying length (2 to 7 actions) using the real gap
  formula, at a switchable Light / Medium / Hard.
- On-screen readout of the measured latency between requesting speech and its
  `onstart`, and between `onend` and the next request.
- Purpose: establish whether iOS Safari speech is crisp enough, whether the wake
  lock holds, and whether the gap constants feel right on a bag.
- **Deliverable: the spike plus a short written report of the measured latencies and
  a recommendation on the gap constants.** Do not proceed to Phase 1 without the
  user's verdict.

### Phase 1 — Engine and workout loop
Selector, timing, session state machine, speech boundary, wake lock. A deliberately
ugly single screen: pick sport/tier/intensity/round length, hit start, get a real
workout with countdown, rounds, rests, and a bell. Full engine test suite. No
persistence, no other screens.

### Phase 2 — Settings and persistence
Storage layer, settings screen, all settings honoured by the engine, defaults
restored correctly on a fresh load and on corrupt data.

### Phase 3 — Combo library
Merge layer over the shipped library, combos screen, enable/disable, frequency,
custom combo CRUD, search.

### Phase 4 — History
Session records written on completion, history screen, aggregates, streak logic,
repeat session.

### Phase 5 — Packaging and polish
Manifest, icons, service worker with offline caching and a cache-busting strategy,
standalone-mode styling, safe-area handling, and a full visual pass against the
reference screenshots.

## 12. Rules of engagement

- **Plan before you build.** At the start of each phase, present the plan and wait
  for approval. The user is an experienced engineer but not a software developer:
  explain trade-offs in plain terms, without assuming familiarity with JavaScript
  idioms or tooling.
- **Stop at phase boundaries.** Do not run phases together.
- **Do not add features that are not in this spec.** If something seems missing,
  say so and ask.
- **Do not invent combos.** `combos.json` is authored by the user and authoritative.
- **Externalise constants.** Anything a non-developer might want to tune belongs in
  `config.json` or `tokens.css`, not in a function body.
- **Say when you are unsure.** iOS Safari's speech, wake lock, and PWA behaviour vary
  by version. Where behaviour is uncertain, state the uncertainty and propose a test
  rather than asserting it works.
