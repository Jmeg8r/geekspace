---
change: 2026-10-17-schema-failure-probe
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: side session from the function-sync follow-up (forge PR #65)
---
# Intent: prove a real schema-validation failure leaves the old functions running

## Problem

Forge PR #65 made the packaged app replay its bundled Convex deploy payload into an
existing data dir at startup (`electron/functionSync.mjs`: `start_push` →
`wait_for_schema` → `finish_push`, marker `functions.json` written only on success).

Its riskiest path is the one users hit after an update whose schema no longer accepts
their data: `wait_for_schema` reports `failed`, and the module must stop before
`finish_push`, keep the old marker, and leave the old functions serving. Today that path
is proven only by `tests/functionSync.test.ts` against a **fake** backend that returns a
hand-written `{ type: "failed", tableName }`. Nothing shows that the real pinned backend
answers that way, or that the old functions really keep serving afterwards. PR #65's live
probe skipped it on purpose (it would have meant breaking James's data).

## What "done" looks like

A repeatable probe, runnable on the Mac Studio, that against a **throwaway** backend
(pinned binary, temp data dir, ports 3290/3291, never 3210 or a real data dir):

1. deploys the current functions through the same bundle path the app uses
   (`convex deploy --push-all-modules --write-push-request`, then `syncFunctions`);
2. inserts data the current schema accepts;
3. builds a second payload from a temp copy of `convex/` whose schema rejects that data,
   and replays it with `syncFunctions`;
4. asserts: status `failed`; the error names the table; `finish_push` was never called;
   `functions.json` still holds the first hash; a query served by the old functions
   still answers.

It fails loudly (non-zero exit, clear message) when any assertion or precondition fails,
and it is shown to go red when `functionSync` is deliberately broken.

## Out of scope

- Changing `functionSync.mjs` or the startup dialog (the probe may find a bug; that
  would be a separate fix).
- Windows (the probe uses the same code; running it there is a follow-up).
- Running the probe in forge CI (the runner has no pinned backend binary).
