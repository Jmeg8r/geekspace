---
change: 2026-10-16-backend-pin
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: one pinned, hash-verified Convex backend for packaging

Assumes option A (pin) from the intent.

## Files that change

- `electron/backendVersion.mjs` (new, with `.d.mts`), the single source of truth:
  - `BACKEND_VERSION = "precompiled-2026-10-10-72ce13c"`;
  - `BACKEND_ASSETS`: per `${platform}-${arch}` (`darwin-arm64`, `darwin-x64`,
    `win32-x64`), the release asset name, byte size and SHA-256 of the **unzipped
    binary**;
  - `backendCachePath(version, env)`: the CLI's cache path (`%LOCALAPPDATA%\convex\binaries`
    on Windows, `~/.cache/convex/binaries` elsewhere). Replaces the copies in both files.
  - `missingBinaryMessage(path)`: the prebake error text, naming `npm run fetch-backend`.
  - Lives in `electron/` because `electron/**` is what ships in the asar; scripts can
    import from it, but the runtime can't import from `scripts/`.
- `electron/convexBackend.mjs`: imports the version and path helper; drops
  `BUNDLED_BACKEND_VERSION` and its inline path logic.
- `scripts/prebake-seed.mjs`: imports the same. Its missing-binary `die` uses
  `missingBinaryMessage`. It checks the binary's size + SHA-256 with `verifiedFile`
  before bundling, and dies with the expected vs. actual values on a mismatch.
- `scripts/fetch-backend.mjs` (new) + `"fetch-backend"` npm script:
  - downloads the release zip for this platform with `downloadVerifiedFile` (zip size +
    SHA-256 pinned too);
  - unzips with the OS tool (`ditto -xk` on macOS, `tar -xf` on Windows, which ships
    bsdtar);
  - verifies the binary, sets `+x` on POSIX, and moves it into the cache path;
  - is a no-op when the verified binary is already there.
- `tests/backendVersion.test.ts` (new).
- `docs/changes/2026-10-16-backend-pin/` (this folder).

## Order of work

1. **Failing test first, committed alone.** It asserts that:
   - neither `scripts/prebake-seed.mjs` nor `electron/convexBackend.mjs` contains a
     `precompiled-` literal;
   - the version matches `precompiled-YYYY-MM-DD-<hex>`;
   - every asset entry has a 64-hex SHA and a positive size;
   - `backendCachePath` builds the right path for darwin and win32;
   - `missingBinaryMessage` contains `npm run fetch-backend` and the version.
2. Compute sizes and hashes from the GitHub release assets (download to scratch, not the
   cache) for darwin-arm64, darwin-x64 and win32-x64.
3. Add `electron/backendVersion.mjs`, then switch `convexBackend.mjs` and
   `prebake-seed.mjs` to it. The test goes green.
4. Add `scripts/fetch-backend.mjs` + the npm script.
5. VERIFY (below), then a forge PR with the Codex review posted.

## Risks

- **One-way data migration** on existing installs (125/128 → 133). Tested on a copy of
  the real packaged data: clean, with identical pages. Users can't downgrade after the
  bump; acceptable for a single-user app, and recorded in the intent.
- **The port 3210 collision during VERIFY.** Another session's `convex dev` (the
  `geekspace-reassess` worktree) is listening on :3210, and prebake refuses to run while
  anything is there. Packaging needs it stopped; I won't kill another session's process.
  I'll ask first.
- **The worktree has no `.convex/local/default/config.json`.** Prebake reads it for the
  deployment identity. Packaging runs from the main checkout (which has it), or the file
  is copied into this worktree's gitignored `.convex/`.
- The Windows path is not exercised on this Mac. The hash comes from the real release
  asset, and the unzip uses `tar -xf`. Flagged for a check on the Alienware.

## Proof

- `npx vitest run tests/backendVersion.test.ts`: fails before step 3, passes after.
- `npm run verify` (oxlint + tsc + vitest) green; `snyk test`.
- `npm run fetch-backend` against an empty `CONVEX` cache override, then again (no-op),
  then with a corrupted file (rejected).
- Prebake with the binary absent prints the `npm run fetch-backend` hint.
- `npm run package` completes; the packaged `Geekspace.app` starts, and its backend log
  shows the 2026-10-10 binary healthy on :3210.

## Options not taken

- **B. Derive from "latest" at build time.** Not reproducible; silently migrates user data
  on any rebuild (see the intent's table).
- **Re-pin both strings by hand.** Fixes today, recreates the drift.
- **Use `convex dev --local-backend-version <v>` to fetch.** A hidden, undocumented flag
  that also starts a dev deployment. Too heavy, and too fragile to build on.
