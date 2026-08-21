# Vendored anti-slop

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)@`6d538555cb151d4121ed51a27db81890eacf8ae` (2026-08-18).

- Generic rule set only (`src/index.ts`, `src/rules/`, `src/shared/`), test files stripped.
- The Effect rule group (`src/effect/`) is intentionally **not** vendored or registered — Geekspace has no Effect usage.
- Local disposition (which rules are `error` vs `warn`, and why): see `oxlint.config.ts` at the repo root and [docs/anti-slop.md](../../../docs/anti-slop.md).
- Peer dependency pins: `oxlint@1.78.0`, `@oxlint/plugins@1.78.0` (matches anti-slop's own `package.json` at the pinned commit — do not float `^latest`).

This directory is vendored, not a live dependency. To pick up upstream changes, re-run this same copy process against a newer commit SHA, re-diff the rule files, and update this stamp.
