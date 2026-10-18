---
change: 2026-10-17-function-sync-no-downgrade
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: follow-up to forge PR #65 (function sync), whose intent left downgrades out of scope
---
# Intent: an older Geekspace build never replaces newer database functions

## Problem

Forge PR #65 made a packaged launch replay its bundled Convex functions whenever their
hash differs from the data dir's `functions.json` marker. "Differs" includes "older".
Run a build from another branch, or roll back to yesterday's `.app`, against a data dir a
newer build already deployed to, and startup silently replaces the newer functions with
the older ones. The newer renderer that comes back next will then run against old server
code, which is the exact failure PR #65 was written to end (a stale `pages:get` blanked
the window on 2026-10-17).

## What "done" looks like

- Each bundle knows how new its code is: prebake records an ordinal in
  `build/convex-functions/manifest.json`, and every deploy records it in `functions.json`.
- A launch whose bundle is **older** than what the data dir runs deploys nothing, keeps
  the newer functions live, and tells the user with a warning dialog (Continue / Quit),
  in the same style as the existing sync-failure dialog.
- A bundle the same age or newer deploys exactly as today when the hash differs.
- A developer can force the downgrade deliberately with an env var at launch
  (`GEEKSPACE_ALLOW_FUNCTION_DOWNGRADE=1`); there is no button for it.
- `npm run deploy:local` leaves a marker saying "functions of this checkout's age, hash
  unknown", so an older packaged build won't overwrite a dev push either.
- Data dirs written before this change (a marker with only a hash, or no marker) keep
  working: they redeploy as they do today.

## Decisions (interview with James, 2026-10-17)

1. **Ordinal = the committer timestamp of the commit prebake builds from** (`git log -1
   --format=%ct`). The same commit always yields the same number, a rollback or an old
   branch reads as older, and it needs no full history (works in a shallow clone). Known
   cost: rebasing a branch makes it "newer". Rejected: first-parent commit count (a
   branch off old main can outnumber newer main; shallow clones miscount), build
   wall-clock time (rebuilding an old commit today reads as newest, missing the main
   case), package.json version (not bumped per change).
2. **Dialog offers Continue (open on the newer functions) or Quit.** Forcing the older
   functions is env-var only, so no end user can do it by accident.
3. **`deploy:local` writes `{ hash: null, ordinal: <checkout HEAD commit time> }`**
   instead of deleting the marker.

## Constraints

- No Electron import in `electron/functionSync.mjs` (prebake and tests run it).
- mac + Windows both; `git` is already required by the build.
- Electron security rules: main-process only, nothing new exposed to the renderer.
- Dev mode (attached to `convex dev`) is unchanged: no sync runs there.

## Out of scope

- Telling which of two *different* bundles with the same ordinal is "right" (e.g. a dirty
  tree built on the same commit). Same age = deploy, as today.
- Data migrations, and protecting against a tampered manifest (single-owner app; the
  threat is owner accidents, not a hostile build).
