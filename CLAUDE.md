# STRIKR — notes for Claude

Combat-sports combo-caller PWA. Plain static files, **no build step, no
dependencies**. Read `PROJECT-STATUS.md` for history and design decisions before
changing behaviour.

## Hosting

Live at https://avereidev.github.io/strikr/ (GitHub Pages, `main` branch, repo
root). **`git push` to `main` publishes to the phone** — only push work that has
passed tests and a browser smoke test, and confirm with the user first. The repo
is public: never commit personal data, keys, or `reference/` (third-party
screenshots, gitignored). Commits use the GitHub noreply email.

## Commands

- Tests: `npm test` (runs `node --test 'test/*.test.js'`; it is node:test, not vitest/jest)
- Test on the phone before pushing: `python3 serve.py` → https on 8443. **Never tell the user to
  use `python3 -m http.server` for the phone** — plain http on a LAN IP has no
  service worker and no wake lock, and is a different origin from the installed
  app, so updates never reach it.
- Browser smoke test (built-in browser rejects the self-signed cert):
  `python3 -m http.server 8444`, then open http://localhost:8444. If modules look
  stale, use a different port — the pane caches ES modules per origin.

## Rules

- **After changing any shipped file, bump `CACHE_VERSION` in `sw.js`.** New files
  under `src/` must also be added to its `SHELL` list. The pre-commit hook in
  `.githooks/` enforces both (enable with `git config core.hooksPath .githooks`).
- Smoke-test in the browser after every change set — every device bug so far has
  been a wiring bug that unit tests could not see. Check the console.
- `src/engine/` stays pure: no DOM, no clock, no `Math.random`. `main.js` owns the clock.
- Settings values must be members of the allowed lists in `src/store/settings.js`;
  `settings.set` silently ignores anything else.
- `data/combos.json` is hand-maintained now. `gen.py` predates tags and single
  strikes — running it would destroy them.
- localStorage keys: `strikr.v1.settings`, `strikr.v1.library`, `strikr.v1.history`.
  Data is per-origin, so a changed host/IP/port means an empty app.
- Delegate well-bounded pieces to Sonnet subagents with a full brief: test
  suites against a finished API, ~30-combo batches, data lint. Tell them not to
  touch `src/` when writing tests and to report suspected bugs. Keep engine and
  timing changes and final verification yourself; re-run `npm test` on what
  they hand back.

## Cloud sessions

When `CLAUDE_CODE_REMOTE=true` you are in a cloud session: a fresh clone, no
browser pane, no phone, no local notes.

- **Never push to or merge into `main`** — that publishes to the phone. Work on
  the session's own branch and open a PR; the user merges after testing.
- The SessionStart hook in `.claude/settings.json` enables the pre-commit hook.
  Never commit with `--no-verify`.
- You cannot run the browser smoke test. Run `npm test`, then end the PR body
  with **"Smoke test: pending"** and the exact screens and taps to check, so
  nothing is merged untested.
- `PROJECT-STATUS.md` and `PHASE8-PLAN.md` are the record of where the project
  stands; update them in the same PR.
