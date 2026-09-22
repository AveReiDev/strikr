# Phase 0 report — audio and timing spike

**Verdict: go.** iOS Safari is a sound foundation for this app, on one condition
(§4). Do not proceed to native.

Measured on iPhone, Safari 26.5.2, 393×852 @3x. 81 callouts across five runs.

---

## 1. What was at risk

Every phase after this one assumes iOS Safari can speak a combo at a predictable
moment, repeatedly, for ten minutes, with the screen on. If it couldn't, the
right answer was to change platform before building five more phases.

## 2. Results against the thresholds set before measuring

| Measure | Threshold | Measured | |
|---|---|---|---|
| Median start latency | < 150 ms | **15 ms** | pass |
| 95th pct start latency | < 300 ms | **24 ms** | pass |
| Missing `onend` (watchdog) | 0 | **0 of 81** | pass |
| Speech errors | 0 | **0 of 81** | pass |
| Gap error (`onend` → next `speak()`) | < 100 ms | **3 ms** median, 7 ms worst | pass |
| Wake lock holds a session | 10 min | **6:30+ continuous, no drops** | pass |

The latency figures are the warm-audio condition. See §3 — without it the same
device measures 311 ms median with a 665 ms worst case, which fails.

## 3. The main finding: a two-second audio session teardown

The first run showed a strange, perfectly reproducible pattern — most callouts
started ~320 ms after being requested, but a few started in 6 ms and a few took
640 ms, the same combos every cycle. A gap sweep isolated the cause. Start
latency depends almost entirely on **how long the gap before it was**:

| gap before utterance | cold | warm |
|---|---|---|
| 400 ms | 6 ms | 5 ms |
| 800 ms | 5 ms | 5 ms |
| 1200 ms | 5 ms | 6 ms |
| 1600 ms | 5 ms | 5 ms |
| **2000 ms** | **631 ms** | **23 ms** |
| 2400 ms | 311 ms | 17 ms |
| 2800 ms | 317 ms | 15 ms |
| 3200 ms | 317 ms | 16 ms |
| 4000 ms | 318 ms | 17 ms |

iOS tears the system audio session down about **two seconds** after speech ends.
Below that the session is still open and speech starts almost instantly. Above
it we pay ~317 ms to restart the session. Land exactly on the boundary and
teardown collides with startup, costing ~631 ms.

The ~320 ms is therefore **audio session startup, not speech synthesis**.

### The fix

Holding an inaudible WebAudio tone open for the duration of the workout keeps
the session alive. Latency collapses to **15 ms median, 24 ms worst, across all
gap lengths**, and the 631 ms boundary spike disappears entirely.

This also answers a question flagged as uncertain in the plan: on iOS, WebAudio
and speech synthesis **do** share an audio session.

### Background audio

Tested with a YouTube video playing, in both conditions. The video ducks
slightly during a callout and returns immediately afterwards. **Continuously
holding the session warm does not change this** — no permanent ducking, no
interruption. Background music is unaffected either way.

## 4. Requirement arising from this phase

**The audio session must be held warm for the duration of a workout.** This is
not an optimisation; without it, start latency is 20× worse and — critically —
*uneven*, because whether a gap falls above or below the two-second boundary
depends on the combo's action count.

Implementation note: the bell also needs WebAudio, so a single shared
`AudioContext` should own the context, the keep-alive tone, and the bell.

## 5. Recommendation on the gap constants

The bag test was run **cold**, so every gap felt on the bag was longer than
`config.json` claimed:

| intensity | formula said | actually delivered |
|---|---|---|
| Light | 3900–7400 ms | +317 ms on every one |
| Medium | 2700–5700 ms | +317 ms on every one |
| Hard | 1500–4000 ms | +5 / **+631** / +317 ms — uneven |

The user reported this felt good and comparable to the app being cloned. To
preserve that validated feel now that warm audio removes the latency:

```
light   baseGapMs 2500 -> 2800
medium  baseGapMs 1500 -> 1800
hard    baseGapMs  500 ->  800
```

`perActionMs` unchanged at 700 / 600 / 500.

Hard benefits most. Its delivered gaps were 1505, 2631, 2817, 3817, 4317 ms —
irregular, because the 2-action gap fell below the teardown boundary and the
3-action gap landed on it. With warm audio and the corrected base they become
1815, 2315, 2815, 3815, 4315 ms: even for the first time. Expect Hard to feel
better than what was tested, not merely equivalent.

**These constants need one confirming bag session in Phase 1.**

## 6. Speech duration model

The round-end lookahead (spec §6.2) needs an estimate of how long a callout will
take. No such model existed. Fitted against measured iOS durations:

```
estimatedMs = (430 + 45 * characters) / rate
```

Predicts 1019 ms against a measured 1022 ms for the reference combo, and fits
all five test combos within ~5%. Fitted at rate 1.35 (the default 75% voice
speed); worth re-checking if the voice speed setting is moved far from default.

The initial character-only model overestimated by 50–90%, which would have
caused several seconds of dead air at the end of every round.

## 7. Voice

25 English voices available. The candidate-list approach from spec §7.4 worked —
`Daniel [en-GB]` was selected for male without hard-coding. Note these are all
**compact** system voices; iOS offers higher-quality "enhanced" voices as an
optional download under Settings → Accessibility → Spoken Content → Voices. That
is a user-side quality lever, not something the app can install.

## 8. Known-unresolved

- **Ten-minute wake lock** verified to 6:30 rather than the full 10:00. No drops
  and no screen dimming to that point. Note that a 3-round workout with rests is
  a continuous ~10 minutes, so session length rather than round length is the
  constraint.
- **Silent switch, locked screen, and interrupting call** were not tested.
  Auto-pause on `visibilitychange` (spec §7.3) covers the last two by design.
- Instrumentation flaw, for the record: the sweep table grouped samples by gap
  without separating warm from cold runs, so the second export's summary table
  mixed both conditions. Results above were recovered from the raw samples.

## 9. Disposal

`spike.html`, `serve.py`, `PHASE0-PROTOCOL.md`, and the generated
`spike-cert.pem` / `spike-key.pem` are throwaway and are deleted at the start of
Phase 1, per spec §11.
