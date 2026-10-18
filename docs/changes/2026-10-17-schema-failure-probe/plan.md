---
change: 2026-10-17-schema-failure-probe
status: draft
track: T1
intent: ./intent.md
linear: pending
---
# Plan: integration probe for a real schema-validation failure in function sync

## Decision: a script under `scripts/`, not a gated vitest suite

`npm run probe:schema-failure` → `scripts/probe-schema-failure.mjs`, plain Node with
`node:assert/strict`. Run by hand (or by a future packaging checklist), not by
`npm run verify`.

Why this is the conservative option:

- **A gated suite would be green on zero input.** Forge CI (`.forgejo/workflows/ci.yml`)
  runs `npm ci && npm run verify` with no pinned backend binary, so a suite that skips when
  the binary is missing would skip on every PR and still show green. A skip reads like
  coverage. The script instead **fails** when the binary or config is missing.
- **`npm run verify` stays hermetic and fast.** The probe spawns a 170 MB backend, runs the
  convex CLI (esbuild bundling) twice and binds ports. In verify that adds tens of seconds,
  a port-collision flake mode, and a child process that can outlive a crashed test run.
- **It needs the admin key from `.convex/local/default/config.json`.** A test suite that
  reads a developer's local secret by default is a worse habit than an opt-in script.

Cost: nobody runs it unless told to. Mitigation: the README's "Other scripts" list and
`docs/changes/2026-10-17-function-sync/plan.md` (Proof → "Not proven live") point at it.

## Files that change

- `scripts/probe-schema-failure.mjs` (new). Steps:
  1. **Preconditions:** pinned binary at `backendCachePath()` passes `verifiedFile`
     (size + SHA-256 from `electron/backendVersion.mjs`); config at
     `.convex/local/default/config.json` (override: `--config <path>`, needed in worktrees,
     which have no `.convex/`) has `adminKey`/`instanceSecret`/`deploymentName`; nothing
     answers on `127.0.0.1:3290`. Any miss → exit 1 with the reason.
  2. **Throwaway backend:** temp dir from `fs.mkdtempSync`; spawn the binary on
     `--port 3290 --site-proxy-port 3291 --interface 127.0.0.1 --disable-beacon` with a
     temp SQLite file and storage dir, output to a log file in the temp dir (same reasons as
     prebake). Wait for `/version`.
  3. **Bundle A (current functions):** `convex deploy --env-file <temp>/selfhosted.env
     --typecheck disable --push-all-modules --write-push-request <temp>/a/push-request`
     from the repo root, then `writeBundle(stripAdminKey(...))` into `<temp>/bundle-a`, then
     `syncFunctions` → assert `deployed`; marker hash = bundle A's hash.
  4. **Data the current schema accepts:** `seed:seedWorkspace` mutation; `pages:list`
     returns ≥ 1 page (record the count).
  5. **Bundle B (schema rejects that data):** temp project dir holding a copy of `convex/`
     plus symlinks to the repo's `package.json`, `tsconfig.json` and `node_modules`. In its
     `schema.ts`, add a required field to `pages` (`probeRequired: v.string()` after the
     `pages` table's `title: v.string(),` — the edit asserts that anchor occurs exactly
     once). No seeded page has that field, so validation must fail on `pages`. Deploy-payload
     it the same way into `<temp>/bundle-b`.
  6. **Replay B** with `syncFunctions`, passing a `fetch` wrapper that records each
     endpoint and delegates to the real `fetch`.
  7. **Assertions:** `status === "failed"`; `error.message` and `error.tableName` name
     `pages`; recorded endpoints include `start_push` and `wait_for_schema` and **not**
     `finish_push`; `readMarker(temp)` equals bundle A's hash; `pages:list` still returns
     the step-4 count (old functions serving).
  8. **Teardown (always, in `finally`):** SIGTERM then SIGKILL after 5 s, close the log fd,
     remove the temp dir (it holds `selfhosted.env` with the admin key). On failure, print
     the last lines of the backend log before removing it.
- **Secret handling:** the admin key goes only into the temp `selfhosted.env` and request
  bodies. The script never logs config contents, request bodies or the env file; error
  output carries the backend's response message only (functionSync already truncates it).
- `package.json`: `"probe:schema-failure": "node scripts/probe-schema-failure.mjs"`.
- `README.md`: one line under "Other scripts".
- `docs/changes/2026-10-17-function-sync/plan.md`: under "Not proven live", point to this
  change once it has run.

## Order of work

1. **Spike** (scratchpad, not committed): run steps 2–7 by hand to confirm the real
   backend returns `wait_for_schema` `{ type: "failed", tableName: "pages" }` for an added
   required field. If it reports the failure differently (an HTTP error from `start_push`,
   a different shape), stop and record it under Deviations before writing assertions —
   that would itself be a finding about `functionSync`.
2. **Failing first:** commit the script; then show it goes **red** against a deliberately
   broken `functionSync` (local, uncommitted edit: treat `failed` as `complete`, so
   `finish_push` runs and the marker moves). Capture the exit code and failing assertion,
   revert the edit, confirm `git diff --stat electron/` is empty.
3. Run green against the real module; record output.
4. README + package.json + function-sync plan pointer; `npm run verify`; `snyk test`.
5. Forge PR, Codex review posted verbatim as a PR comment.

## Risks

- **Schema validation may be off or async in a way the probe misreads.** The spike settles
  this before any assertion is written.
- **Port 3290 in use** (another session's spike): precondition check fails loudly; never
  falls back to 3210.
- **The admin key leaks into output.** Only via a bug in this script; mitigated by never
  printing config/env/bodies and by removing the temp dir in `finally`. Verified by grepping
  the captured run output for the key's value (by value, not by name; the value itself is
  never echoed).
- **Orphaned backend** if the script is killed hard: it binds only 127.0.0.1:3290/3291 and a
  temp dir; documented in the script header with how to find and stop it.
- **CLI drift** (hidden flags): same exposure as prebake, which already fails on it.

## Proof

- Spike output (step 1) recorded in Deviations.
- Red run: non-zero exit, the failing assertion named (`finish_push was called` / marker
  moved), against the broken module.
- Green run: exit 0, each assertion's observed value printed (status, tableName, endpoints
  called, marker hash prefix, page count before/after).
- `npm run verify` exit 0 (unchanged test count; the probe is not in vitest).
- `snyk test` (no dependency changes expected).

## Options not taken

- **vitest suite gated on the binary** — see the decision above.
- **Hand-edit the bundled schema module inside payload A** instead of re-running the CLI on
  a temp `convex/` copy: avoids a second CLI run, but string-patching bundled JS is brittle
  and isn't how a real update's payload is produced.
- **Narrow an existing field** (e.g. `favorite: v.boolean()` → `v.literal(true)`): depends
  on what the seed happens to write; an added required field fails on every seeded page,
  deterministically.
- **Run it against a copy of James's data dir:** more realistic data, but the probe would
  then depend on (and copy around) personal data; a seeded throwaway is enough to prove the
  mechanism.
