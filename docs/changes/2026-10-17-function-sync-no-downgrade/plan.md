---
change: 2026-10-17-function-sync-no-downgrade
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: refuse to downgrade bundled Convex functions at startup

## Approach in one paragraph

Prebake reads the committer timestamp of `HEAD` (Unix seconds) and writes it as `ordinal`
into `build/convex-functions/manifest.json`. Every marker write records the ordinal next
to the hash. At startup `syncFunctions` keeps its first check (same hash = current), then
asks one new question before deploying: does the data dir run functions with a known
ordinal greater than this bundle's? If so it returns a new status, `"downgrade"`, deploys
nothing and leaves the marker alone; `main.mjs` shows a Continue / Quit warning. The env
var `GEEKSPACE_ALLOW_FUNCTION_DOWNGRADE=1` turns the refusal into a logged deploy.
`deploy:local` stops deleting the marker and writes `{ hash: null, ordinal }` for its
checkout instead. A marker without an ordinal means "unknown age" and deploys, as today.

## Decision table (bundle B vs live marker M)

| M | B.ordinal | Result |
|---|---|---|
| missing / unparseable | any | deploy (today's behaviour) |
| `{hash}` only (pre-change) | any | same hash → current, else deploy |
| `{hash, ordinal}` | same hash | current (ordinal not consulted) |
| `{hash, ordinal}` | ≥ M.ordinal | deploy, marker gets B's hash + ordinal |
| `{hash, ordinal}` | < M.ordinal | **downgrade**: no deploy, marker untouched, dialog |
| `{hash, ordinal}` | missing (pre-change manifest) | **downgrade** (a manifest without an ordinal predates any marker that has one) |
| `{hash: null, ordinal}` (deploy:local) | compared as above; hash never matches | |
| any downgrade row + env var | | deploy, marker gets B's (older) ordinal, log says forced |

## Files that change

- `electron/functionSync.mjs`
  - `writeBundle(dir, request, { convexVersion, ordinal })`: throws unless `ordinal` is a
    positive integer; writes it into the manifest.
  - `readBundle(dir)` → `{ hash, request, ordinal }` (`ordinal` null when absent or not a
    positive integer).
  - `readMarker(dataDir)` → `{ hash, ordinal } | null` (was: hash string). A field of the
    wrong type reads as null, same "unknown = out of date" rule as today.
  - `writeMarker(dataDir, { hash, ordinal }, { now })`.
  - `invalidateMarker` is replaced by `recordExternalDeploy(dataDir, ordinal)`, which
    writes `{ hash: null, ordinal }` through the same atomic temp-file + rename.
  - `syncFunctions({ …, allowDowngrade = false })`: new status
    `{ status: "downgrade", hash, bundleOrdinal, liveOrdinal }`.
- `electron/functionSync.d.mts`: types for the above.
- `scripts/lib/commitOrdinal.mjs` (new): `commitOrdinal(cwd)` runs
  `git log -1 --format=%ct` (spawnSync, no shell, works on Windows) and throws with the
  git output unless it gets a positive integer. Shared by prebake and deploy:local.
- `scripts/prebake-seed.mjs`: pass `ordinal: commitOrdinal(ROOT)` to `writeBundle`; log it
  with the hash. A failure stops the build (a packaged bundle must carry an ordinal).
- `scripts/deploy-local.mjs`: when the config it uses is the packaged app's, call
  `recordExternalDeploy(packagedConvexDir(), commitOrdinal(ROOT))` before deploying
  (same "before, so a half-done deploy leaves no false hash" reasoning). When it fell back
  to the dev config, it no longer touches the packaged data dir at all.
- `electron/convexBackend.mjs`: pass
  `allowDowngrade: process.env.GEEKSPACE_ALLOW_FUNCTION_DOWNGRADE === "1"`.
- `electron/main.mjs`: on `status === "downgrade"`, a warning dialog: "This copy of
  Geekspace is older than the one that last updated your database." Detail names both
  code dates (`toLocaleString` of the ordinals), says the newer functions stay and some
  features may not work, and gives the log path. Buttons Continue (default) / Quit.

## Order of work → verify

1. Commit intent.md + plan.md → James accepts (`docs(intent): accept …`).
2. Failing tests in `tests/functionSync.test.ts`, one per table row above, plus
   `writeBundle` rejecting a missing ordinal and `recordExternalDeploy`'s marker; and
   `tests/commitOrdinal.test.ts` (an integer for this repo; throws outside a git repo).
   → verify: `npx vitest run tests/functionSync.test.ts tests/commitOrdinal.test.ts`
   fails on the new cases only. Commit as `test:`.
3. Implement `functionSync.mjs` + types + `commitOrdinal.mjs` → verify: those tests pass.
4. Wire prebake, deploy:local, convexBackend, main.mjs → verify: `npm run verify`
   (oxlint, tsc, vitest), `snyk test`.
5. `npm run package` → verify: manifest in the `.app` holds `ordinal` = `git log -1
   --format=%ct`; the seed's `functions.json` holds the same ordinal.
6. **Live probe** on the Mac Studio. The packaged app's data dir is fixed
   (`~/Library/Application Support/Geekspace/convex`, James's real data), so the probe
   only edits the marker, never the database: quit Geekspace, back up `functions.json`,
   rewrite it with this build's hash replaced by a dummy and `ordinal` = bundle + 1 day,
   launch the packaged app → expect the downgrade dialog and the log line "skipping…",
   and the marker byte-identical afterwards (no deploy). Then relaunch with
   `GEEKSPACE_ALLOW_FUNCTION_DOWNGRADE=1` → expect a deploy and a marker with the bundle's
   ordinal. Restore the backup (then one normal launch re-deploys to the same functions
   main already runs). Screenshot the dialog.
7. Forge PR, Codex review posted verbatim as a PR comment, James approves the merge.

## Risks

- **Rebased branches read as newer.** Accepted in the intent; same-commit and rollback
  cases, the ones that bite, are caught.
- **Clock skew between machines.** Commit times come from whichever machine committed;
  a few minutes of skew only matters for builds of commits minutes apart.
- **A refused downgrade runs an older renderer on newer functions.** The dialog says so;
  Quit is offered. Strictly better than silently replacing the functions, which would
  break the newer build the next time it ran.
- **A `deploy:local` that fails** still leaves its ordinal in the marker, so a packaged
  build older than that checkout refuses to deploy until a newer build runs. This errs
  toward refusing a downgrade (conservative); the env var gets past it.
