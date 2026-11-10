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
npm run verify     # oxlint + tsc -b --noEmit + vitest run (what CI runs)
npm run build      # tsc -b && vite build
npm run package    # build + prebake + build:gs-capture + electron-builder --mac
npm run package:win  # build + prebake + electron-builder --win (NSIS installer)
```

## Codex review

- **`codex review` runs one at a time, in the foreground.** Never start two in parallel and
  never background one; wait for each run to finish before starting the next.

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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **geekspace** (5461 symbols, 14099 relationships, 394 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/geekspace/context` | Codebase overview, check index freshness |
| `gitnexus://repo/geekspace/clusters` | All functional areas |
| `gitnexus://repo/geekspace/processes` | All execution flows |
| `gitnexus://repo/geekspace/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
