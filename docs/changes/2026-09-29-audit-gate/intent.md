---
change: 2026-09-29-audit-gate
status: draft
track: T1
author: james
accepted_by:
linear: pending
source: conversation
---
# Intent: clear geekspace's dependency advisories and gate CI on a full-tree audit

## Problem

This is part of the fleet dependency-gate campaign (sovereign-forge
`tasks/dependency-gate-campaign.md`), decided by James on 2026-09-20: fix the
advisories first, then gate on the same PR.

On `main` (`e5bfbb8`, measured 2026-09-29), geekspace's full-tree `npm audit` reports
**14 high and 3 critical** advisories across 759 packages. The criticals are in
`concurrently` (direct), `shell-quote` and `tar`; the highs include `convex` (direct),
`ws`, `@tiptap/core`, `undici`, `axios` and `fast-uri`.

CI (`.forgejo/workflows/ci.yml`) runs lint, typecheck and tests but no audit, so
nothing fails when an advisory lands.

## Proposed outcome

- `main` has no high or critical advisories across the full dependency tree.
- CI fails any PR or push to `main` that introduces a high or critical advisory, and
  reports how many packages it examined.

## Affected users and systems

- geekspace on the forge and its GitHub mirror. geekspace is one of the deliberate
  forge-private, GitHub-public repos (sovereign-forge CLAUDE.md §1), so every commit
  here is published on GitHub when it syncs.
- Open PR #28 (`fix/coding-principles-geekspace`, 2026-09-12) also edits
  `package.json`, `package-lock.json` and `ci.yml`. It will need its lockfile
  re-resolved after this lands.

## Constraints

- The gate lands on the same PR as the fix (campaign rule).
- **The audit covers the full tree** (James, 2026-09-27): geekspace is an Electron app,
  and `electron` sits in devDependencies but ships inside the app.
- The gate reports how many packages it examined, and fails closed on zero.
- Actions stay SHA-pinned. No new secrets.

## Out of scope

- The rest of #28: its coding-principles refactor, its `convex-test` addition, and its
  build step.
- The Windows CI leg the workflow header describes as retired.

## Success signals

- On the branch, `npm audit --audit-level=high` exits 0. On `main`'s lockfile it exits 1.
- CI's audit log on the PR head prints a non-zero examined count.
- `npm run verify` and `npm run build` pass, as they do on `main` today (44/44 tests).
- `main` after merge carries the new audit context, green.

## Open questions

None.
