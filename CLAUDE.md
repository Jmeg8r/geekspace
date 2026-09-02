# CLAUDE.md — geekspace

## Project Purpose

A Notion-style desktop app (macOS + Windows; Electron + React + Convex) with a block editor,
Notion-Projects-style databases (table/board/list/calendar/timeline views), and a
calendar that auto-schedules itself around task dependencies. Built on the ASTGL brand.

## Key Commands

```bash
npm run dev        # Convex + Vite + Electron together
npm run dev:web    # Convex + Vite (no Electron)
npm test           # vitest run
npm run build      # tsc -b && vite build
npm run package    # build + electron-builder --mac
npm run package:win  # build + electron-builder --win (NSIS installer)
```

## Review standards

Checked by the forge's local AI review gate (`.forgejo/workflows/ai-review.yml`) on every PR.
Advisory only for now — see `bin/review-pr.sh`. Draft list; expand as real patterns emerge.

- **Electron IPC and preload must not leak Node/OS access to the renderer.** `contextIsolation`
  stays on and `nodeIntegration` off; new `electron/preload.cjs` exposures need to be narrow,
  named APIs — not passthroughs of `ipcRenderer`/`fs`/`child_process`.
- **New type assertions need a `SAFETY:` comment stating the checked invariant.** The anti-slop
  oxlint rule (`require-safety-comment-for-type-assertion`) is warning-only, not build-blocking —
  this gate is where an unjustified `as` actually gets caught.
- **Errors are never swallowed silently.** A caught error either surfaces to the user, logs with
  enough context to debug, or is deliberately ignored with a one-line reason in the code — never
  a bare empty `catch`.
- **Convex mutations/queries validate untrusted input at the boundary**, not deep inside helper
  functions — `convex/*.ts` handlers are the trust boundary between the client and the database.
- **Cross-platform code (mac + win) accounts for both.** A change to `electron/`, `scripts/`, or
  platform-specific packaging that only makes sense on one OS needs an explicit reason, not an
  assumption.
- **No hardcoded secrets, tokens, or credentials** — even ones gitleaks' pattern list might miss
  (a user-specific auth cookie, an internal URL with an embedded key). Env vars or config files
  outside version control only.
- **Audio/recording code fails loud, never silent, on a missing or dead input device.** A
  recording path that can produce an empty file with no warning is the exact bug class already
  found and fixed once here (`src/lib/recorder.ts`'s silence detection, "never record a silent
  meeting without saying so"). New recording/transcription code needs the same discipline.
- **New `Record<string, unknown>` (or any other type-erased dictionary) needs a real reason, not
  convenience.** `no-unsafe-dictionary-type` is warn-only in oxlint with 8 known, deferred sites
  (dynamic property bags spread across `convex/rows.ts`, `scheduling.ts`, `seed.ts`, `templates.ts`,
  `meetings.ts` and two `src/components/` files — see `docs/anti-slop.md`); a PR adding a new one
  should name the real value union instead of erasing to `unknown`.
- **Ad hoc `typeof` checks on schemaless Convex data reuse the shared predicates**
  (`convex/lib/predicates.ts`'s `isNumber`/`isString`), not a new inline `typeof x === "..."`.
  19 sites were deliberately factored this way during the anti-slop adoption — a new inline
  check re-introduces the pattern that was removed.
- **New native-capability usage (mic, calendar, Mail, AppleEvents) needs a matching macOS
  entitlement, not just an `Info.plist` usage-description string.** Under Hardened Runtime the
  entitlement is what actually grants access — missing it fails silently on end-user machines
  while working on an unsigned dev build, which is exactly what happened once already on this
  repo (mic/AppleEvents entitlements). A renderer helper process must inherit them too.

<!-- COMPOUND:START -->
## Compound Engineering Setup

Learnings are captured by gstack into `~/.gstack/projects/<slug>/learnings.jsonl` and
auto-loaded into context at session start. This repo commits only the human-readable
digest below — the gstack store is the source of truth.

- **View learnings offline:** `./show-learnings.sh` (also `high`, or a type filter)
- **Record a constraint:** `/gstack-learn add` (write constraints, not observations)
- **Refresh the table below** after a session's Compound step: `./refresh-digest.sh`
- **Session logs:** copy `sessions/TEMPLATE.md` → `sessions/SESSION-NNN-<title>.md` and
  follow Brainstorm → Plan → Work → Review → Compound.

## Known Patterns

<!-- LEARNINGS:START -->
_No learnings yet. Run `/gstack-learn add` during a session, then `./refresh-digest.sh`._
<!-- LEARNINGS:END -->
<!-- COMPOUND:END -->
