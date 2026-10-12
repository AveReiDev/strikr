# STRIKR Phase 8 — new training modes (plan)

Drafted 11 October 2026. Planning only — nothing here is built yet. Open
questions answered the same day; see **Decisions** at the end.

Built from four research passes: Muay Thai/kickboxing technique (ranges,
levels, defense, footwork), S&C and warmup design, Apple Watch feasibility,
and a read-only audit of the engine and `data/combos.json`. Source links live
in those reports; the claims that matter are summarised here with their
confidence.

---

## The short version

| Idea | Verdict | Shape | New data needed |
|---|---|---|---|
| Change levels | **Yes, cheap** | Selector *weight*, not a mode | ~30 combos (mostly boxing + MT/KB beginner) |
| Distance / range | **Yes** — four named ranges; boxing gets inside/outside | Selector *weight* + optional range-change calls | ~30 combos (close range + clinch) |
| Defense after attack | **Yes, high value** | New `workoutMode`, selector wrapper | ~14 defense callouts, 0 combos |
| Footwork | **Yes** | New `workoutMode`, selector wrapper | ~16 footwork callouts, 0 combos |
| Guided warmup | **Yes** | Timed segments before round 1 | ~16 movements, 3 routines |
| Strength & conditioning | **Yes, biggest engine change** | Timed exercise rounds between bag rounds | ~30 exercises |
| Apple Watch HR | **Not live in a PWA.** Staged path below | Per-round timestamps + manual / imported HR | none |

**Does the combo list accommodate this?** Mostly yes, with targeted additions
rather than a rewrite. Every strike token in the 248 entries can be classified
by level and range from its name, so no combo needs hand-tagging. The gaps are
coverage, not structure:

- **Levels:** boxing has no leg level and only 10 of 96 boxing strikes are body
  shots. MT/KB beginner pools have almost no multi-level-change combos.
- **Range:** close range is thin everywhere except MT advanced; clinch has 4
  combos total; boxing is single-range under the default mapping.
- **Defense:** only 27 combos contain a defensive move, 17 of them *start*
  with it (counters) and just 1 *ends* with one — the opposite of the habit you
  want. Defense mode adds the defense at runtime instead, so no new combos.
- **Footwork:** 6 uses total, none in kickboxing or beginner. Also added at
  runtime.

Existing data bugs found along the way (worth fixing regardless):

- 14 combos tagged `kicks` contain no kick — only knees/elbows/clinch (e.g.
  `mt-beg-10` "Jab, Cross, Rear straight knee"). The Home "Kicks" focus serves
  them. **Decided:** add a `knees` category tag (today `knee` exists only as a
  drill tag for singles), put it on all 25 combos containing a knee, and
  remove `kicks` from the 14 that have no kick or teep. Home's focus list is
  derived from tags per sport, so "Knees" appears for Muay Thai and
  kickboxing automatically.
- `mt-int-09` (ends "Frame off") lacks `defensive`; `bx-adv-10` has it but
  contains no defensive move.
- "Switch kick" (11 uses) has no level; siblings say "Switch body/high/low kick".
- Singles use drill tag `kick`, combos use `kicks`; `body` means body-kick in
  68 combos and body-shot in 11.
- `PROJECT-STATUS.md` says "90 combos" (actual: 223 + 25 singles) and its
  version history stops at 1.8.0 (`sw.js` is at 1.10.0).

---

## Foundation (do first): a strike dictionary

Level, range and category should be **derived from strike tokens at load
time**, not hand-tagged per combo:

- Custom combos are free text; `sanitiseCustom` would strip hand-added fields
  anyway, and hand tags have already drifted (see `kicks` above).
- `balance.categoryOf` is already a regex classifier over display segments —
  this generalises it.

```json
// data/strikes.json — ordered rules, first match wins, defense tested first
{ "schemaVersion": 1,
  "rules": [
    { "match": "^(check|catch|slip|roll|parry|block|frame)", "kind": "defense" },
    { "match": "^(step|pivot|circle|angle|switch stance)",   "kind": "footwork" },
    { "match": "feint$",     "kind": "feint" },
    { "match": "^clinch|dump|sweep", "kind": "strike", "range": "clinch" },
    { "match": "elbow",      "kind": "strike", "level": "head", "range": "close" },
    { "match": "straight knee|step-up knee", "kind": "strike", "level": "body", "range": "punching" },
    { "match": "knee",       "kind": "strike", "level": "body", "range": "close" },
    { "match": "low kick",   "kind": "strike", "level": "leg",  "range": "kicking" },
    { "match": "high kick|question mark", "kind": "strike", "level": "head", "range": "kicking" },
    { "match": "teep|kick",  "kind": "strike", "level": "body", "range": "kicking" },
    { "match": "uppercut",   "kind": "strike", "level": "head", "range": "close" },
    { "match": "to body$",   "kind": "strike", "level": "body", "range": "punching" },
    { "match": "jab|cross|hook|back fist", "kind": "strike", "level": "head", "range": "punching" }
  ],
  "boxingRange": { "inside": "hook|uppercut|to body", "outside": "jab|cross" } }
```

- `src/engine/strikes.js`: pure `classifyStrike(token, rules)` and
  `profileOf(combo)` → `{ levels: [...], ranges: [...], levelChanges: n }`.
- `test/strikes.test.js`: walks `combos.json` and **fails on any token the
  dictionary can't classify** — this keeps the hand-maintained file honest.
- Refactor `balance.categoryOf` onto it, and extract a shared
  `composeWeights()` (the ladder selector currently duplicates the weak-spot
  weighting code).
- Unknown tokens in custom combos get a neutral weight; show the derived levels
  in the custom-combo form preview.

---

## Mode designs

### Change levels (emphasis)

Classic logic (high confidence): attacking one level pulls the guard, opening
another — low kick then high kick, body shot then head hook.

- **Metric:** level *changes between adjacent strikes*, not "levels touched" —
  78% of combos already touch 2+ levels, so that wouldn't discriminate.
- **Soft weight, not a filter.** A hard filter shrinks the pool, which shrinks
  the no-repeat window and starves boxing. Multiply the draw weight by
  `1 + k × levelChanges` via `composeWeights`.
- Watch the interaction with strike balance: an emphasis weight on top of the
  balance clamp will skew toward kicks. Probably acceptable; revisit on the bag.
- **New combos (~30):** boxing body/head alternations (~12, e.g. "Jab to body,
  Jab, Cross", "Lead hook to body, Lead hook to head"), MT/KB beginner and
  intermediate level-changers (~8 each, e.g. "Lead low kick, Rear high kick",
  "Teep, Cross, Lead hook, Rear low kick"). The research report has 15 sourced
  patterns to draw from.
- Optional later: a spoken "Drop" cue before body punches. Untested idea.

### Distance / range (emphasis + range calls)

**Decided:** the four named ranges from the research consensus (high
confidence, many sources agree), no numbers. The mapping lives in
`data/strikes.json`, so changing it later is a data edit.

| Range | Callout | Strikes |
|---|---|---|
| Kicking | "Kicking range" | Teeps, all kicks (low, body, high, switch, question mark, spinning back) |
| Punching | "Punching range" | Jab, long jab, cross, hooks, body shots, spinning back fist, straight and step-up knees (they reach from here) |
| Close | "Close" | Short knees, elbows, uppercuts |
| Clinch | "Clinch" | Clinch entries, clinch work, dumps, sweeps |

Boxing uses its own two ranges:

| Range | Callout | Strikes |
|---|---|---|
| Outside | "Outside" | Jab, long jab, cross |
| Inside | "Inside" | Hooks, uppercuts, body shots |

- **Weight:** share of a combo's strikes in the chosen range.
- **Range-change calls:** every 3–5 combos, announce a new range as a
  zero-action callout, then draw for that range.
- **Range-change drills worth seeding as combos** (sourced): teep to hold
  the gap then kick, teep–cross, and "kick, punch, then close" chains that
  walk all three ranges (e.g. "Lead teep, Cross, Lead hook, Rear knee, Lead
  elbow").
- **Coverage:** clinch has only 4 combos (all Muay Thai), and kickboxing has
  almost no close-range strikes. Clinch emphasis should be Muay Thai only;
  kickboxing gets kicking, punching and close.
- **New combos (~30):** MT close range and clinch (~15: knees, elbows, clinch
  entry chains), KB knees (~8), a few pure long-range teep/kick strings.

### Defense after attack (`workoutMode: 'defense'`)

- **How it plays:** combo is called → you throw it → defense is called
  ("Roll!", "Check!", "Back!") → recovery gap → next combo.
- **Decided: a separate call after a short delay**, not part of the combo
  string. The defense lands once the combo's execution time has passed
  (`perActionMs × actions`) plus a short configurable beat
  (`config.defense.delayMs`, start around 300 ms, tune on the bag), so it
  feels like the opponent's counter. No source compares this with
  defense-in-the-string, so the bag test is the real check.
- **Context-aware pairing** (standard technique, medium confidence):

  | After… | Natural defense |
  |---|---|
  | rear low/body kick | Check, Back |
  | lead hook | Roll |
  | jab / cross | Slip, Pivot, Parry |
  | combo ending close | Cover, Circle out |
  | body kick | Elbow in, Back |

- **Engine:** `createDefenseSelector(inner, defenses, rng)` emits
  `[combo, defense]` as two callouts, the defense tagged `kind: 'defense'`.
  Things that must skip non-combo callouts: `combosCalled`,
  `combosCalledIds` (per-combo stats), and `balance.record`.
- **Round end:** reserve the defense's time in the round-end lookahead, or a
  combo can start and its defense get refused, which teaches the wrong habit.
- Skip combos that already contain a defense token.
- Mutually exclusive with ladder/pyramid. Finishers stay plain combos.

### Footwork (`workoutMode: 'footwork'`)

- **Callouts:** In, Out, Pivot, Angle, Switch, Circle left/right, Slide, Hop.
- **Two flavours:** footwork alone (shadow/conditioning), or inserted into a
  drawn combo ("Pivot, Cross, Lead hook"; "Switch, Rear body kick"). The
  inserted version is a derived combo like a ladder rung, keeping `baseId` so
  history credits the real combo.
- Footwork items need more time than a punch: give each an `actions` weight or
  `extraMs`.
- "Pivot" and "Angle" overlap with defensive exits, so share one data list
  with a `kind` per use.
- TTS check: "In"/"Out" may be mushy next to "Elbow". Test on the device.

### Guided warmup (add-on: `warmupMin: 0 | 5 | 8 | 12`)

RAMP structure (raise → activate/mobilise → potentiate; practitioner-level
evidence), which lines up with traditional Muay Thai warmups:

- **Raise:** rope or bounce, jacks, high knees.
- **Mobilise:** ankles → hips (leg swings both planes, hip circles, deep
  squat) → thoracic → shoulders → neck.
- **Potentiate:** pogo hops, then shadowboxing light → moderate → sharp,
  which feeds into the existing ramp-up rounds.
- **No long static holds.** Holds under 30 s are fine (high-confidence
  evidence); over 60 s measurably costs power.
- Full 5/8/12-minute step tables with durations and one-line cues are in
  the research report. Start with the 5-minute version.
- Optional 2–3 minute cooldown later. The evidence says it settles you but
  doesn't help the next session.

### Strength & conditioning (add-on: exercise rounds between bag rounds)

- **Default preset:** 3:00 bag → 1:00 exercise → 30–60 s rest, × 4–6. Also
  offer "short bag" (2:00 / 1:00) and "strength bias" (3:00 / 3 × 40 s).
- **Inside an exercise round:**
  - 1-minute rounds: one exercise.
  - 2–3 minute rounds: three stations with a "switch" call.
  - Call time, not reps. Cues: the name, "halfway" or "switch sides", "ten
    seconds", and 3-2-1.
- **Equipment (decided): full gym.** A two-value setting,
  `conditioningEquipment: bodyweight | gym`, is enough. The bodyweight list
  stays as the fallback for travel or a crowded floor.
- **Library (~45):**
  - **Bodyweight (~30):** squats, reverse lunges, wall sit, push-ups, plank
    variants, dead bugs, side plank, mountain climbers, burpees, sprawls,
    high knees, jump squats.
  - **Gym (~15):**
    - Kettlebell: swings, goblet squats.
    - Dumbbell: thrusters, push press, renegade rows.
    - Ropes: jump rope; battle rope waves and slams.
    - Plates: plate halos, plate Russian twists, plate push (if the floor
      allows).
    - TRX suspension straps: TRX rows, TRX atomic push-ups, TRX pistol
      squats.
    - Med-ball slams.
- **Gym rules:**
  - The app never prescribes weights. Each exercise gets a one-line "pick
    a weight you can move fast for the whole round" cue.
  - Equipment is slow to switch, so a round should use one equipment item
    plus bodyweight moves, never three different stations.
  - Grip-heavy work (swings, farmer carries, rows) is flagged after bag
    rounds, since your hands and forearms are already tired from wraps
    and gloves.
- **Safety rules the generator must enforce:**
  - Never two plyometric exercises back to back.
  - No intensity-3 plyos in the last third of the session.
  - A low-impact toggle.
  - Grip-heavy work (KB) flagged after bag rounds.
  - One "stop if anything hurts sharply" line at the start.
- **Progression:** exercise duration, station count and rest scale with
  tier and intensity. Change one variable per step, the same rule the app
  already follows.

### Shared engine work for warmup + S&C: a round plan

Both need timed segments, not combo-calling:

- `src/engine/plan.js` (pure) builds
  `[{type: 'warmup' | 'bag' | 'timed' | 'rest', …}]`, and `session.js`
  walks the plan instead of counting rounds.
- A new `TIMED` state with precomputed cues `[{atMs, text}]`, spaced by
  `estimateSpeechMs`. `speak()` never cancels, so cues that overlap queue
  up late on iOS.
- **Golden test first:** the default plan must reproduce today's
  bag/rest/…/bag sequence exactly before anything else changes.
- **Risky interactions:**
  - `rounds`, ramp-up indexing, finishers and `startRound()` must count
    **bag rounds only**, or suggestions and weekly load get polluted.
  - **Weekly load (decided):** conditioning counts toward the +10% cap;
    warmup does not.
    - `sessionLoad` adds exercise minutes × intensity factor ×
      `config.load.conditioningFactor` (start at 1.0).
    - In conditioning mode, `applyWeekPlan`'s "how many rounds fit" must
      price a bag round *plus its exercise round*, or it will over-suggest.
    - Expected side effect: the first week you add exercise rounds is still
      capped at 110% of your last bag-only week. The cap will trim bag
      rounds or say the week is done. That is the cap working as designed,
      but the suggestion text should say why ("conditioning counts toward
      your weekly load").
  - **Pause:** cue bookkeeping keyed to elapsed time, as rest already is.

---

## Apple Watch heart rate

**A home-screen web app on iPhone cannot get live Watch HR.**

- Web Bluetooth is unsupported in every iOS browser, and WebKit has said it has
  no plans to add it.
- There is no web HealthKit API.
- Third-party "Watch as BLE heart-rate monitor" apps don't help, because the
  page still can't read Bluetooth.

The useful numbers for round training are post-round anyway:

- peak HR per round
- **HR recovery at 60 s** (peak minus HR one minute later)
- HR at the end of each rest, tracked across rounds and weeks

### Staged path

1. **Stage 1, ~1 day, no dependencies.**
   - Record per-round wall-clock timestamps:
     `rounds: [{i, type, startedAt, endedAt}]`. Wall clock comes from
     `main.js`, not session time, because pause drifts it.
   - Optional manual HR entry on the rest screen, like the feel rating.
   - A settable max HR for zones.
   - The new fields must be added to the `session.finish()` summary,
     `main.js finished()`, the `sanitiseHistory` whitelist, and repeat.
2. **Stage 2, ~1–2 days, no dependencies.**
   - Start a Kickboxing workout on the Watch alongside STRIKR. Outside a
     Watch workout, background HR is far too sparse.
   - Afterwards an Apple Shortcut ("Find Health Samples → Heart Rate") copies
     JSON to the clipboard. STRIKR's "Import HR" button reads it and aligns
     the samples to the stored round timestamps.
3. **Stage 3, only if Stage 2 is valuable but too clunky.**
   - A separate wrapper repo (Capacitor + HealthKit plugin), and for live HR
     a watchOS `HKWorkoutSession` app mirrored to the phone.
   - About 1–3 weeks of work and $99/yr.
   - It breaks "no build step" and "push = release" for the wrapped app.

**Accuracy caveat:** wrist optical HR is at its worst in combat sports
(gloves, wraps, wrist flexion, impacts), and recovery estimates can be off by
around 7 bpm. Treat the numbers as weekly trends, not exact readings.

---

## Settings shape

- **`workoutMode`** (structure of the call stream): add `defense` and
  `footwork`, alongside `random | ladder | pyramid`. They are mutually
  exclusive with each other and with ladder/pyramid.
- **`emphasis`**, composes with focus and weak spots:
  `off | levels | kicking | punching | close | clinch | inside | outside`.
  Home shows only the values that apply to the chosen sport: the four
  ranges for Muay Thai (kickboxing without clinch), inside/outside for
  boxing.
- **Add-ons**, like `rampUp` and `finisherSec`:
  - `warmupMin`: 0, 5, 8, 12
  - `conditioning`: off, between
  - `conditioningSec`: 20, 30, 40, 45, 60
  - `conditioningEquipment`: bodyweight, gym
- **Wiring:**
  - Each new setting goes in `defaultSettings`, `settingsSchema` and the
    allowed lists, or `settings.set` silently drops it.
  - `history.js` `MODES` and `main.js` `LADDER_MODES` must learn the new
    modes, or Repeat reverts to random.
  - Home's Mode grid is 3 columns, so 5 chips need wrapping.

---

## Build order

Each phase ships on its own: tests, then a browser smoke test, then
`CACHE_VERSION`, then a device test.

| Phase | Work | Why here |
|---|---|---|
| 8A | **Done, v1.11.0.** Strike dictionary, lint test, `composeWeights`, `knees` tag + retag, data-bug fixes, `PROJECT-STATUS` corrections | Everything else reads from it |
| 8B | Defense mode — **done, v1.13.0** | Highest training value; no new combos; small engine change |
| 8C | Levels emphasis + ~30 combos — **done, v1.14.0** | Cheapest new mode once 8A exists |
| 8D | Round plan + `TIMED` state + guided warmup — **done, v1.15.0** | Builds the timed-segment engine on the simpler use |
| 8E | S&C exercise rounds, bodyweight library (gym kit deferred, decision 8), load integration — **done, v1.17.0** | Reuses 8D |
| 8F | Footwork mode — **done, v1.18.0** | Reuses the 8B wrapper pattern |
| 8G | Range emphasis + range calls + ~30 combos — **done, v1.19.0** (live, awaiting bag test) | Most combo authoring; can move earlier if you want it sooner |
| 8H | HR Stage 1, then Stage 2 after on-device checks | Round timestamps fall out of 8D's plan |

## Decisions (11 October 2026)

1. **Distance:** drop the coach's numbering. Use the four named consensus
   ranges: kicking, punching, close, clinch.
2. **Defense:** a separate call after the combo, after a short delay.
3. **`kicks` tag:** add a `knees` category tag. Remove `kicks` from the 14
   knee/elbow/clinch combos that have no kick or teep.
4. **Boxing distance:** split into inside and outside.
5. **S&C equipment:** full gym — kettlebells, dumbbells, jump and battle
   ropes, plates, TRX. A bodyweight fallback remains.
6. **Weekly load:** conditioning counts toward the +10% cap. Warmup does
   not.

7. **TRX (12 October):** TRX means the suspension straps. Battle ropes stay
   in the gym list as their own equipment.
8. **Gloves (12 October):** gloves stay on between bag rounds, so 8E is
   bodyweight and glove-friendly moves only. The gym list (kettlebells,
   dumbbells, TRX straps, plates, battle ropes) waits; a gloves-off gym
   block at the end of a session is a possible later addition.

9. **Range calls (8G, 12 October):** the plan named no setting for the
   optional range-change calls, so they are a ninth Emphasis value,
   `ranges` ("Range calls"), rather than a separate toggle: a fixed range
   and rotating calls do not combine. Built in a cloud session; the move
   beat (800 ms) and the weight (8) want checking on the bag.

## Check on the phone before HR Stage 2

- In the installed PWA, does `navigator.clipboard.readText()` work from a
  button?
- During a Watch Kickboxing workout, does "Find Health Samples" return
  readings every few seconds, and does it filter by time of day or only by
  date?
- Can the PWA open a `shortcuts://run-shortcut?name=…` link? (Nice to have.)
