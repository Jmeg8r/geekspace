import { defineConfig } from "oxlint";

// anti-slop: vendored Oxlint rules that reject compiler-silencing TypeScript
// patterns. Vendored copy + provenance: tools/oxlint/anti-slop/VERSION.md.
// Rule disposition rationale: docs/anti-slop.md.
export default defineConfig({
  ignorePatterns: [
    ".claude/**",
    "tools/oxlint/anti-slop/**",
    "convex/_generated/**",
    "electron/**", // plain .mjs/.cjs, not TypeScript — out of scope for this pilot
    "scripts/**", // plain .mjs/.cjs build/release tooling — out of scope for this pilot
    "mcp/**", // plain .mjs, not TypeScript — out of scope for this pilot
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    // TODO(james): deferred to the PR-2 PropertyBag refactor (convex/lib/types.ts) —
    // promote to "error" once the remaining 8 Record<string, unknown> sites are
    // replaced with a real domain type. See docs/anti-slop.md.
    "anti-slop/no-unsafe-dictionary-type": "warn",
    "anti-slop/no-widen-then-assert": "error",
    // Warn, not error: fires on every pre-existing bare `as T` (196 sites at
    // adoption time). Retrofitting all of them in one pass would produce
    // rubber-stamp comments, not real safety documentation. Burn-down policy
    // and the measured count: docs/anti-slop.md.
    "anti-slop/require-safety-comment-for-type-assertion": "warn",
  },
});
