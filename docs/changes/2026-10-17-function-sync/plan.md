---
change: 2026-10-17-function-sync
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: sync bundled Convex functions at startup, and contain render errors

## Approach in one paragraph

At build time, prebake asks the Convex CLI for the exact deploy payload instead of pushing
it: `convex deploy --write-push-request <file> --push-all-modules` writes the
`/api/deploy2/start_push` request body (bundled modules, schema, config) and stops. Both
flags are hidden but present in convex 1.46.0 (`dist/esm/cli/lib/command.js:137-139`,
used in `lib/components.js:255` and `:297`). Prebake strips `adminKey` from that JSON,
hashes it, and ships it as `build/convex-functions/{push-request.json, manifest.json}`.
At startup the main process compares the manifest hash with a marker in the data dir
(`functions.json`). If they differ it replays the payload through the backend's own
three-step deploy API (`start_push` → poll `wait_for_schema` → `finish_push`), with the
admin key read from the data dir's `config.json`, then writes the marker. No esbuild, no
CLI, no repo at runtime. Prebake itself pushes through the same module, so every
`npm run package` exercises the runtime path against a real backend.

## Files that change

**Function sync (main process + build)**
- `electron/functionSync.mjs` (new): pure-ish module, no Electron import, injectable
  `fetch` and clock so it runs under vitest.
  - `readBundle(dir)` → `{ hash, request }`; throws if the request still holds an
    `adminKey` field (a build that leaked it must not ship).
  - `needsSync(dataDir, hash)` → reads `functions.json`; missing or different = true.
  - `pushFunctions({ url, adminKey, request, fetch, timeoutMs })`: POST `start_push` with
    `adminKey` injected into the body and `Authorization: Convex <key>`; poll
    `wait_for_schema` (`{ adminKey, schemaChange, timeoutMs, dryRun:false }`) until
    `complete`; `failed` / `raceDetected` / overall timeout / non-2xx → throw a typed
    `FunctionSyncError` carrying the backend's message (and `tableName` when given);
    then POST `finish_push` with `{ adminKey, startPush, dryRun:false }`.
  - `syncFunctions({ dataDir, bundleDir, url, adminKey, fetch, log })` → `{ status:
    "current" | "deployed" | "failed", error? }`. Writes `functions.json`
    (`{ hash, deployedAt }`) atomically (temp file + rename) **only after** `finish_push`
    succeeds.
- `electron/convexBackend.mjs`: after `waitHealthy()` in the managed path only (never
  when attaching to `convex dev`), call `syncFunctions` with `bundleDir` =
  `resources/convex-functions` (packaged) or `build/convex-functions` (dev, skipped with a
  log line if absent). Export the result (`getFunctionSyncResult()`).
- `electron/main.mjs`: after `startConvex()`, if the result is `failed`, show a warning
  dialog ("Geekspace updated, but couldn't update its database functions. Your data is
  unchanged and the previous version is still running. Details: <log path>") and continue
  opening the window. Each launch retries once; the dialog repeats until it succeeds.
- `scripts/prebake-seed.mjs`: replace the `convex deploy` push with
  1. `convex deploy --env-file … --typecheck disable --push-all-modules
     --write-push-request <WORK>/push-request` (writes `push-request.json`, pushes nothing);
  2. strip `adminKey`, write `build/convex-functions/push-request.json` + `manifest.json`
     (`{ hash: sha256(stripped JSON), convexVersion }`);
  3. `pushFunctions` against the throwaway backend (same code as runtime);
  4. existing seed + `pages:list` probe (unchanged, still authoritative);
  5. write `functions.json` into the seed so a fresh install doesn't redeploy.
  The F6 Windows teardown note moves to step 1 (its exit code is checked by the presence
  and parse of `push-request.json` instead of trusting status alone).
- `package.json`: `extraResources` += `{ "from": "build/convex-functions", "to":
  "convex-functions" }`.
- `scripts/deploy-local.mjs`: unchanged (still useful in dev); header note that the
  packaged app now does this itself.

**Render-error containment (renderer)**
- `src/components/common/ErrorBoundary.tsx` (new): small class boundary,
  `fallback(error, reset)` render prop + `onError` that `console.error`s with context.
- `src/main.tsx`: wrap `<App/>` in a top-level boundary whose fallback is a plain
  "Something went wrong" screen with **Reload** and **Go to Home** (sets `nav` to home in
  the store, which persists, then reloads). Catches failures in `App` itself (it runs
  `useQuery(api.settings.get)`).
- `src/App.tsx`: wrap the `<main>` contents in a boundary keyed by the nav target, so
  navigating away resets it. Fallback: for a `page` nav, navigate Home (log the error);
  for other views, an inline error panel with a **Go to Home** button.
- `src/state/ui.ts`: track a non-persisted `navRestored` flag, set in persist's
  `onRehydrateStorage` when the restored `nav` is a page, cleared by `navigate()`. Export
  a pure `fallbackNav(nav, navRestored, pageState)` helper.
- `src/components/page/PageView.tsx`: when the page is `null`/trashed **and** the nav was
  restored from storage, navigate Home instead of "This page is gone". A page you
  navigated to yourself keeps today's message.

**Tests**
- `tests/functionSync.test.ts` (fake fetch + temp dirs, written first, must fail first):
  marker matches → zero requests; missing/different marker → start → wait (inProgress,
  then complete) → finish, marker written with the bundle hash; admin key appears in
  body + header and comes from the argument, never the bundle; `failed` schema → no
  `finish_push`, no marker, error names the table; `raceDetected`, HTTP 500 on
  `start_push`, and overall timeout → `failed`, no marker; bundle containing `adminKey`
  → refused; marker write is atomic (no partial file on a throwing write).
- `tests/navFallback.test.ts`: `fallbackNav` table (restored page + null → home;
  navigated page + null → stay; restored page + error → home; non-page navs untouched)
  and rehydrate sets `navRestored`.
- `tests/errorBoundary.test.tsx` (`// @vitest-environment jsdom`): a child that throws
  renders the fallback, not an empty root; `reset` re-renders children. Needs the
  `jsdom` devDependency (vitest's documented environment); no other new deps.

## Order of work

1. **Spike, before any test:** run `convex deploy --write-push-request` against a
   throwaway backend and replay it with plain `fetch` (uncompressed JSON) to prove the
   backend accepts it without the CLI's brotli and headers. If it doesn't, stop and
   re-plan (see Risks). Record the result in Deviations either way.
2. Failing tests: `functionSync.test.ts`, `navFallback.test.ts`, `errorBoundary.test.tsx`
   → commit `test(sync): failing tests …` (confirm red).
3. `electron/functionSync.mjs` → function-sync tests green.
4. Prebake rewrite + `extraResources`; run `npm run prebake` to prove the end-to-end
   build path (seed probe still passes).
5. `convexBackend.mjs` + `main.mjs` wiring.
6. Renderer: `ErrorBoundary`, `main.tsx`, `App.tsx`, `ui.ts`, `PageView.tsx` → renderer
   tests green.
7. VERIFY (below), implementation notes / Deviations, PR, Codex.

## Risks

- **Hidden CLI flags can change.** `--write-push-request` / `--push-all-modules` are
  `hideHelp()` options. Mitigation: the spike proves them on 1.46.0; prebake fails loudly
  if `push-request.json` is missing or doesn't parse; `manifest.json` records the convex
  version. A convex bump that breaks them breaks the build, never a user's launch.
- **Payload/API drift between CLI and backend.** Both are pinned (convex 1.46.0,
  backend `electron/backendVersion.mjs`); prebake pushes the payload to the pinned
  backend on every package, so drift shows at build time.
- **Schema validation rejects existing user data.** `start_push` + `wait_for_schema`
  don't commit; only `finish_push` does. On `failed` we never call it, so the old
  functions stay live. The user gets the dialog every launch until a migration ships.
- **Startup latency.** Only on a hash change (an update), a few seconds for a small
  workspace. The window still waits for a healthy backend today; this extends that wait
  on the first launch after an update only. Timeout cap: 120 s, then fail loud.
- **Spurious redeploys.** Bundled source maps can embed build-machine paths, so builds on
  different machines may hash differently. Cost: one idempotent redeploy. Acceptable.
- **Admin key handling.** Never written to `build/`; `readBundle` refuses a bundle that
  has one; tests assert it.

## Proof

- `npm run verify` (oxlint, `tsc -b --noEmit`, vitest) green, with the three new test
  files passing after being committed red.
- `snyk test` (the `jsdom` addition).
- `npm run package`: prebake log shows push-request written, pushed via
  `functionSync`, seed probe passing; `ls` of the `.app`'s `Resources/convex-functions`.
- Live probe on the Mac Studio, on a **copy** of James's data dir first:
  1. Copy the data dir aside; edit its `functions.json` away (or start from a dir
     deployed by an older build). Launch the packaged app → `logs/convex.log` shows
     "deployed functions <hash>", `functions.json` updated, window renders.
  2. Relaunch → log shows "functions current", no push.
  3. Set `localStorage["geekspace-ui"].nav` to a bogus `pageId` → app opens on Home.
  4. Schema-failure path: covered by unit tests (forcing real data to violate the schema
     in James's workspace isn't worth the risk); the dialog wiring checked by reading the
     code path, stated as unproven live.
- Windows: `npm run package:win` not runnable here; the module has no platform branches
  besides paths already used. Stated as unverified on Windows.

## Options not taken

- **Run `convex deploy` at runtime** (ELECTRON_RUN_AS_NODE + unpacked CLI): needs
  esbuild to bundle at runtime, which the prebake header rules out inside the asar.
- **Reseed / copy the seed's function tables into the user's SQLite:** touches the
  backend's internal storage format; unsupported and risks data.
- **Compare `BACKEND_VERSION` or app version instead of a content hash:** misses
  function changes that don't bump either; a hash of the actual payload can't drift.
- **Keep `convex deploy` in prebake and only add the payload export:** works, but then
  the runtime push path is exercised only by unit tests. Pushing through `functionSync`
  at build time proves it against the real pinned backend on every package.
- **Renderer-only fix** (boundary + nav fallback without sync): stops the blank window
  but leaves every update running stale functions.

## Deviations

- **Spike result (step 1), 2026-10-17:** against a throwaway backend on :3290 (backend
  `precompiled-2026-10-10-72ce13c`, convex 1.46.0), `convex deploy --push-all-modules
  --write-push-request` wrote a 648 KB payload (39 modules, `adminKey` included) and pushed
  nothing: `pages:list` answered "Could not find public function" afterwards. The CLI still
  prints "Deployed Convex functions" in this mode, so prebake checks for the file, not the
  message. Replaying it as plain uncompressed JSON (no brotli) through `start_push` →
  `wait_for_schema` (`complete` on first poll) → `finish_push` took 541 ms, and
  `pages:list` then succeeded. Plan held; no re-plan.
- **Error class renamed `SyncError`** (plan: `FunctionSyncError`). A security hook treats
  the text `new Function…` as `eval` and blocked the write. Same behavior.
- **Added `skipped` status and `requireBundle`.** In dev, a missing `build/convex-functions`
  is skipped with a log line; in the packaged app it's `failed` (an incomplete build must
  not pass silently). Tested both ways.
- **Added a no-admin-key guard.** A `config.json` without `adminKey` fails with a clear
  message instead of a 401 from the backend. Tested.
- **Dropped the "atomic marker write" test.** Tested the invariant that matters instead: a
  failed push leaves an existing marker untouched, and no failure path writes one. The
  write itself is temp file + rename.
- **`readBundle` checks for a leaked admin key before checking the hash**, so a leaked key is
  reported as that, not as a hash mismatch.
- **Live probe runs on the real data dir after a full backup.** The packaged app's data dir
  path is fixed (`~/Library/Application Support/Geekspace/convex`), so "a copy first" became
  "back up first, then run the real upgrade path".
- **Lint baseline:** oxlint warnings 208 on `origin/main` and 208 on this branch (no new
  warnings; the existing `as` casts in `App.tsx`/`PageView.tsx` were moved, not added).
- **`snyk test --dev`:** 11 issues / 23 paths, none through `jsdom`; all rooted at
  existing dependencies (eslint, electron, electron-builder, MCP SDK, zod,
  eslint-plugin-react-hooks), tracked separately.
