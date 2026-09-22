# Phase 6 — Smart Training

Three features, built in order. Each sub-phase is testable and shippable on
its own.

---

## 6A: Per-Combo Tracking

**Problem:** The app knows how many combos it called but not which ones.
There is no way to see what you've drilled heavily vs. what you've neglected.

### Data changes

**History record** gains a new field:

```json
{
  "combosCalledIds": ["mt-beg-01", "mt-int-03", "mt-beg-01", ...]
}
```

The full sequence, including repeats. Old records without this field are valid
— they simply contribute nothing to combo-level stats. Schema version stays
at 1; the field is additive and optional on read.

**Session state machine** (`session.js`): already emits `{ type: 'combo',
combo }` on every callout. The wiring layer (`main.js`) collects these ids
into an array and includes it in the summary passed to `history.add()`.

### Aggregation (new functions in `history.js`)

- `comboFrequency(records, { sport?, since? })` → `Map<comboId, count>`.
  Counts how many times each combo id appears across all
  `combosCalledIds` arrays. Optional filters by sport and date.

- `comboCoverage(records, pool, { since? })` → `{ practiced, total, ids }`.
  How many of the combos in `pool` appear at least once. `ids` is the set
  of practiced combo ids.

- `leastPracticed(records, pool, { since?, limit? })` → combo ids sorted
  ascending by frequency (ties broken by pool order). Combos with zero
  appearances come first.

### Selector enhancement

`createSelector` accepts an optional `focusMode: 'weak'` flag. When set, an
extra weight multiplier is applied: combos with fewer historical calls get
higher weight. The formula:

```
weakWeight(combo) = 1 / (comboCount + 1)
```

This is multiplied into the existing frequency weight. A combo called 0 times
gets weight 1, called 9 times gets weight 0.1 — a 10x bias toward the
untouched one. The existing frequency and tier weighting still apply on top,
so it biases gently rather than overriding everything.

The combo frequency map is passed in at session creation time (computed once,
not updated mid-workout).

### UI changes

**Combos screen:** A summary line at the top: "42 / 90 combos practiced this
month". Each combo row gets a small count or dot indicator showing how often
it's been called (e.g., a heat indicator: none / low / medium / high based on
quartiles).

**Home screen:** A toggle or chip: "Focus: All" / "Focus: Weak spots". When
"Weak spots" is selected, the selector runs in focus mode.

### Tests

- Collecting combo ids through a simulated session produces the expected array.
- `comboFrequency` counts correctly across multiple records, including records
  with no `combosCalledIds` field.
- `comboCoverage` correctly identifies practiced vs. unpracticed combos.
- `leastPracticed` returns unpracticed combos first, then least-practiced.
- The weak-spot weighting measurably biases selection (over N draws, a
  combo with count 0 is drawn significantly more often than one with count 20).
- Old history records without `combosCalledIds` do not break any function.

---

## 6B: Progressive Training

**Problem:** The user has a conditioning goal (e.g., 10 intense 2-min rounds)
but the app does not help them get there. They have to decide each session's
settings from scratch.

### The goal

Stored in `strikr.v1.settings` as a new key:

```json
"goal": {
  "rounds": 10,
  "intensity": "hard",
  "roundLengthMin": 2
}
```

Nullable — no goal set by default. Sport and tier are inherited from the
current selection (the goal is about conditioning, not about which combos).

### Day-level aggregation

The user often runs multiple short workouts in one gym session. The
suggestion algorithm works at the **day level**, not the workout level.

New function in `history.js`:

`dailyVolume(records, { sport, since? })` → array of
`{ day, rounds, intensity, roundLengthMin, sessions }` sorted by date.

For each calendar day, sum the completed rounds across all completed sessions
for that sport. The day's intensity is the **mode** (most common) intensity
across those sessions. Round length is similarly the mode. This gives a
single "what did Tuesday look like" summary even if Tuesday was five separate
3-round workouts.

### The suggestion algorithm

Look at the last 14 days of daily volumes. Find the best day — the one
closest to the goal by a simple score:

```
score = rounds * intensityMultiplier * roundLengthMin
```

Where `intensityMultiplier` is: light = 1, medium = 1.5, hard = 2.

The suggestion nudges one dimension from the user's recent best toward the
goal, in this priority order:

1. **Rounds** — if below the goal's round count, suggest +1 round (keeping
   intensity and round length the same).
2. **Intensity** — if rounds are at goal but intensity is below, suggest the
   next intensity up (light → medium → hard), resetting rounds to ~70% of
   the goal (rounding to the nearest allowed value) to give the body room to
   adapt.
3. **Round length** — if rounds and intensity match but round length is below,
   suggest the next round length up, with the same 70% round-count reset.

If there is no recent history, suggest the user's current settings (no
opinion without data).

If the user has already met or exceeded the goal, say so: "Goal reached!"
with an option to set a new goal.

### UI changes

**Settings screen:** A "Training goal" section. Three pickers: target rounds,
target intensity, target round length. A "Clear goal" button.

**Home screen:** When a goal is set and a suggestion is available, a card
appears above the sport selector:

```
┌──────────────────────────────────────┐
│  SUGGESTED WORKOUT                   │
│  6 rounds · Medium · 2 min           │
│  You did 5 rounds medium on Tuesday  │
│                                      │
│  [Load]                   [Dismiss]  │
└──────────────────────────────────────┘
```

"Load" sets sport/tier/intensity/rounds/roundLength to the suggestion.
"Dismiss" hides the card for this session (not permanently).

When the goal is reached:

```
┌──────────────────────────────────────┐
│  ✓  GOAL REACHED                     │
│  You hit 10 hard 2-min rounds        │
│                                      │
│  [Set new goal]                      │
└──────────────────────────────────────┘
```

### Tests

- `dailyVolume` correctly aggregates multiple sessions on the same day.
- `dailyVolume` ignores incomplete sessions.
- The suggestion algorithm returns +1 round when below the goal.
- The suggestion resets rounds to ~70% when stepping up intensity.
- With no history, the suggestion falls back to current settings.
- A day that meets or exceeds the goal is detected as "goal reached."
- Goal storage round-trips through settings correctly.
- A missing/null goal produces no suggestion (no crash).

---

## 6C: Constraint Rounds

**Problem:** Every round draws from the full pool. There is no way to focus a
round on a specific type of work (kicks, lead hand, body shots).

### Combo tagging

Each combo in `combos.json` gains a `tags` array:

```json
{ "id": "mt-beg-01", "tags": ["hands", "lead"], ... }
```

Tag vocabulary (kept small and concrete):

| Tag | Meaning |
|---|---|
| `lead` | Only lead-side strikes (jab, lead hook, lead uppercut, lead kick) |
| `rear` | Only rear-side strikes |
| `hands` | Punches only, no kicks/knees/elbows |
| `kicks` | Contains at least one kick or knee |
| `elbows` | Contains at least one elbow |
| `body` | Targets the body |
| `head` | Targets the head |
| `defensive` | Contains a defensive action (slip, roll, check, etc.) |

A combo can have multiple tags. Tags are authored by the user (you) — the app
does not guess them. Custom combos get a tag picker when created/edited.

### Constraint (focus filter)

A new setting: `focus`, defaulting to `null` (no filter). When set to a tag
value, `buildPool` adds a filter: only combos whose `tags` array includes that
value enter the pool.

If the filtered pool is empty or below 3 combos, the home screen shows a
warning before starting: "Only N combos match — add more or change the
filter."

### UI changes

**Home screen:** A "Focus" picker between Intensity and Round Length:

```
Focus
[All] [Lead hand] [Kicks] [Body] [Hands only]
```

The available options come from the tags that actually appear in the current
sport's combos, so a sport with no elbow combos does not show "Elbows."

**Combos screen:** Tags shown as small chips on each combo row. The tag
picker is part of the custom combo create/edit form.

### Tests

- `buildPool` with a focus tag filters correctly.
- A tag not present in any combo yields an empty pool.
- Custom combos preserve tags through storage round-trip.
- The UI only shows tags that exist in the current sport's pool.

---

## Build order

| Sub-phase | Depends on | Deliverable |
|---|---|---|
| 6A | nothing | Combo tracking, coverage stats, weak-spot mode |
| 6B | 6A (uses daily volume, benefits from combo data) | Goal, suggestions, progress card |
| 6C | nothing (but comes last for priority) | Tags, focus filter |

Each sub-phase: implement, test, browser smoke test, report. The user tests
on their phone before moving to the next.

---

## What does NOT change

- No new localStorage keys. Goal lives in settings; combo ids live in history
  records. The three existing keys (`settings`, `library`, `history`) are
  sufficient.
- No new screens. Everything fits into existing screens (Home, Combos,
  Settings).
- No build step. No new runtime dependencies.
- The engine stays pure and testable. Focus mode and constraint filtering are
  inputs to the selector, not side effects inside it.
