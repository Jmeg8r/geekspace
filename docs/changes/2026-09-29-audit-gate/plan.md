---
change: 2026-09-29-audit-gate
status: draft
track: T1
intent: ./intent.md
linear: pending
---
# Plan: clear geekspace's dependency advisories and gate CI on a full-tree audit

## Files that change

- `package-lock.json` (and `package.json` only if a declared range must move): run
  `npm audit fix` without `--force`. Every high and critical advisory reports a fix
  (`fixAvailable: true`), and none needs a major:
  - `convex` ^1.41.0 already allows the fixed 1.4x versions (latest 1.46.0);
  - `concurrently` ^9.0.0 allows its fixed 9.x.
  - Verify afterwards that nothing is left.
- `.forgejo/workflows/ci.yml`: add an `audit` job, named **Dependency Audit**, beside
  `verify`:
  - no install: `npm audit` reads `package-lock.json` directly;
  - a count step: `npm audit --json` → `.metadata.dependencies.total`, with non-numeric
    counted as 0, failing closed on 0 (the same step as content-repurposer and jdex);
  - `npm audit --audit-level=high` over the full tree;
  - SHA-pinned `actions/checkout` as the existing job uses, and a header comment on
    scope (Electron ships).

## Order of work

1. `npm audit fix` → verify: full-tree `npm audit --audit-level=high` exits 0 and lists
   0 high/critical. If any advisory survives, re-resolve it inside its range, the way
   brace-expansion was in jdex; use an override only with the reason recorded.
2. `npm run verify`, `npm run build` → verify: both pass, 44/44 tests.
3. **Live probe:** start the Electron app locally (`npm run electron:dev`, or the
   project's equivalent) → verify: the window opens and loads the workspace. `convex`
   and `ws` are runtime dependencies of the desktop app.
4. Add the audit job, parse the YAML, and prove the job's exact `run:` scripts locally →
   verify: exit 0 on the branch, exit 1 on `main`'s lockfile, exit 1 with no lockfile.
5. Commit (fix, then gate), push to the forge, and open the PR → verify: every CI job
   green; the audit log shows a non-zero examined count; the ai-review gate reviews the
   lockfile through `package.json`. geekspace's kit is current (blob `1d7b7e36`).
6. Codex review, posted verbatim → merge on James's approval → check that `main`
   carries the new context, and that the mirror is in sync.
7. Comment on #28 that its lockfile needs re-resolving on top of the new `main`.

## Risks

- **The fix moves runtime packages** (`convex`, `ws`, `@tiptap/*`) within their ranges.
  Mitigation: verify, build, and the live Electron probe.
- **The repo is public on GitHub:** nothing sensitive goes in commit messages or docs.
  These are dependency and CI changes only.
- **#28 conflicts** on `package.json`, `package-lock.json` and `ci.yml`. #28 has been
  idle and unreviewed since 2026-09-12. Its own audit step would overlap this job; its
  author reconciles that when rebasing.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| audit, branch | `npm audit --audit-level=high` | exit 0 |
| audit, pre-fix | the same command on `main`'s lockfile | exit 1 (14 high, 3 critical) |
| gate fails closed | the count step with no lockfile | exit 1 |
| verify / build | `npm run verify`, `npm run build` | pass, 44/44 tests |
| live app | Electron dev launch | window opens, the workspace loads |
| CI | PR head statuses | Typecheck & tests, Dependency Audit, secret-scan and ai-review green |
| after merge | `main` statuses | Dependency Audit present and green |

## Options not taken

- **Land #28 instead:** it is a broader refactor that no one has reviewed, and its
  `convex` pin (exactly 1.41.0) is still inside the vulnerable range.
- **`--omit=dev`:** it would skip `electron`, which ships inside the app.

## Deviations

None yet.
