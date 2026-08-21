# anti-slop (Oxlint)

Geekspace vendors [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) — 15
Oxlint rules that reject compiler-silencing TypeScript patterns (`as X as Y`,
`unknown` laundering, widened literals, ad hoc `typeof`). This is the pilot repo for
the pattern; provenance and version pin live in
[`tools/oxlint/anti-slop/VERSION.md`](../tools/oxlint/anti-slop/VERSION.md).

Run it directly with `npm run lint`; it also runs first in `npm run verify` and in CI.

## Disposition

13 of the 15 rules run at `error` with no known violations at adoption time. Two are
deliberately `warn`, both because the fix is a judgment call rather than a mechanical
rewrite:

| rule | level | why |
|---|---|---|
| `require-safety-comment-for-type-assertion` | warn | Fires on every bare `as T` — **196 sites** at adoption time (2026-08-21). Writing 196 `SAFETY:` comments in one pass would produce rubber-stamp justifications, which is the exact failure mode this rule exists to catch. Burn-down policy below. |
| `no-unsafe-dictionary-type` | warn | Fires on `Record<string, unknown>` — **8 sites** remaining, all `rows`/`databases` dynamic property bags (`convex/lib/types.ts`'s `PropertyDef.options`-adjacent storage). Deferred to a follow-up PR that names the real value union (`PropertyBag`) instead of erasing it to `unknown`. 7 sites were already resolved in the adoption PR as a side effect of fixing other rules on the same bindings (e.g. `PageRow.tsx`'s drag-attributes prop got a real dnd-kit type instead of `Record<string, unknown>`, which cleared 2 sites for free). |

The other 13 rules (`no-chained-type-assertions`, `no-conditional-empty-object-spread`,
`no-known-value-widening`, `no-module-mocking`, `no-object-parameters`,
`no-reflect-apply`, `no-reflect-get`, `no-runtime-typeof`, `no-shape-in-symbol-names`,
`no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`,
`no-widen-then-assert`) run at `error`. The Effect rule group is not vendored —
Geekspace has no Effect usage.

`no-runtime-typeof` runs with `allowInTypeGuards: true`, but that option only exempts
`typeof` inside a function whose return type is a `TSTypePredicate` (`(x): x is T`) —
not inline `if (typeof x === ...)` guards. The 19 sites that hit this rule (mostly
reads out of the schemaless `rows.properties`/`databases.properties` columns) were
fixed by extracting two small, reusable predicates —
[`convex/lib/predicates.ts`](../convex/lib/predicates.ts)'s `isNumber`/`isString` — used
everywhere instead of ad hoc `typeof` checks. Their parameter type is `any`, not
`unknown`, because that's what Convex actually declares for these columns
(`v.any()`, see `convex/schema.ts`) — `unknown` would trip `no-unknown-parameters`
without being any more accurate.

## Scope

`electron/**`, `scripts/**`, and `mcp/**` are excluded — they're plain `.mjs`/`.cjs`,
not TypeScript, out of scope for this pilot. `convex/_generated/**` is excluded
(generated code).

## Burn-down policy for `require-safety-comment-for-type-assertion`

Add a real `SAFETY:` comment (stating the checked invariant, not a restatement of the
assertion) to any bare `as T` in a file you're already touching for other reasons.
Don't do a dedicated sweep. Re-run `npx oxlint` periodically to track the count; once
it's small enough to review in one sitting, promote the rule to `error` in
`oxlint.config.ts`.

## Pre-commit hook: not wired yet

`npm run verify` (and therefore `oxlint`) runs in CI on every PR. It is **not** yet
wired into a local pre-commit hook — this repo has no `lefthook.yml`/`.husky/` on
`main` today. A `chore/track-gate-kit` branch already carries a full `lefthook.yml`
(gitleaks, shell/YAML linting, etc.) that isn't merged yet; adding a fresh
`lefthook.yml` here would fork that file and conflict at merge time. Once
`chore/track-gate-kit` lands, add a staged-file-scoped `oxlint {staged_files}`
command to its pre-commit block instead of creating a second one.

## Fleet rollout

This is the pilot. Rollout to other repos is tracked separately — see the
`coderabbit-local-kit` fleet-apply scripts once they exist. Don't assume this repo's
per-rule disposition (especially the warn-bucket counts) transfers to another repo;
each repo needs its own real `oxlint` run before deciding.
