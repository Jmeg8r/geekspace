---
change: 2026-10-16-backend-pin
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: `npm run package` builds the same backend every time, and says how to get it

## Problem

`npm run package` stops at the prebake step:

```
✖ prebake: backend binary missing at ~/.cache/convex/binaries/precompiled-2026-07-21-82d5e9f/convex-local-backend
  Run `npm run dev` once so the convex CLI downloads it.
```

Found while live-testing PR #59 (Home Mail widget); the failure predates that PR.

1. **Two hand-synced pins.** `scripts/prebake-seed.mjs` (`BACKEND_VERSION`) and
   `electron/convexBackend.mjs` (`BUNDLED_BACKEND_VERSION`) both hardcode
   `precompiled-2026-07-21-82d5e9f`, with a comment asking humans to keep them equal.
2. **The hint can't work.** The Convex CLI pins no backend version. On every
   `convex dev` it asks `https://version.convex.dev/v1/local_backend_version` for the
   latest one (today `precompiled-2026-10-10-72ce13c`) and downloads that. So
   `npm run dev` fetches whatever is newest, never the July build the pin names. The cache
   now holds only 2026-09-28, 2026-10-06 and 2026-10-10.
3. **The binary isn't verified.** Prebake copies whatever file sits at the cache path into
   the app bundle, with no size or hash check.

## Findings that shape the fix

- The July release is still downloadable from GitHub
  (`get-convex/convex-backend/releases/download/<version>/<asset>.zip`, HTTP 200), so a
  pinned version stays reproducible as long as we fetch it ourselves instead of relying
  on the CLI.
- **Old data opens on the new backend.** Tested on a *copy* of the packaged app's data dir
  (`~/Library/Application Support/Geekspace/convex`; original SHA-256 unchanged
  afterwards). That data is at internal migration 125, so it was last opened by a build
  older than July. The 2026-10-10 binary migrates it 125 → 133, and `pages:list` returns
  the same 30 pages with an identical content digest to the July binary's result. No
  panics in the log. A restart on 2026-10-10 is clean.
- **Migration is one-way.** The July binary reopening the migrated copy logs
  `persisted db metadata version is ahead at 133, this binary is at 128`. It served the
  data in this test, but a downgrade is not supported. A backend bump is therefore a
  forward-only change to every user's data. That argues for pinning, so a version only
  changes when someone decides it should.
- The `backendVersion` stamp in a data dir's `config.json` is written once, by the seed,
  and never updated. The packaged data says `2026-06-09` even though the July build has
  been the shipped binary. `startOrAttach`'s version warning therefore compares
  against a stale stamp. Noted here and out of scope; see Non-goals.

## Proposed outcome

- **One source of truth** for the backend version: a small module both the build script
  and the Electron runtime import. No string is duplicated, and no comment asks humans
  to keep two in sync.
- The version is **re-pinned to `precompiled-2026-10-10-72ce13c`** (today's latest, and
  already in James's cache), along with each platform asset's size and SHA-256.
- **`npm run fetch-backend`** downloads the pinned asset for this platform from the Convex
  GitHub release, verifies size + SHA-256 with the existing `verifiedDownload` helper,
  and installs it at the cache path the CLI and the runtime already use.
- **Prebake's missing-binary error names that command** (and the version it wants).
  Prebake also verifies the binary's hash before bundling it.
- `npm run package` completes on James's Mac Studio and the packaged app starts.

## Decision for James: pin, or derive?

| | **A. Pin in one module (recommended)** | **B. Derive at build time** |
|---|---|---|
| What | One module holds version + per-platform SHA-256; bumping is a one-line PR | Prebake asks version.convex.dev (or takes the newest cached binary) and writes the version into the build |
| Reproducible | Yes: same inputs → same backend | No: two packages a week apart can ship different backends |
| User data | Migrates only when a bump PR is merged | Any rebuild can migrate every install forward, one-way |
| Supply chain | Hash-verified | Trust-on-first-use; nothing to verify against |
| Upkeep | Manual bump when we want a newer backend | None |

## Non-goals

- Fixing the stale `backendVersion` stamp / making the version guard meaningful
  (follow-up).
- Auto-download inside `npm run package` (prebake fails fast with the exact command
  instead; no surprise network fetch mid-package).
- Linux packaging.
