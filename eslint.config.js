// WHAT: Flat ESLint config for Geekspace's mixed layout — a Vite/React renderer
//       (src), Electron main + Convex backend + scripts + MCP server (Node), and
//       Vitest tests.
// WHY: Lets ESLint 9 — and CodeRabbit, which invokes `eslint` directly — lint
//      the project, which previously had no ESLint config at all. Uses the
//      non-type-checked typescript-eslint recommended set (fast, no tsconfig
//      project service needed, and CodeRabbit disables type-checked rules anyway).
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Build output and Convex-generated code are not linted.
  {
    ignores: [
      "dist/**",
      "build/**",
      "release/**",
      "out/**",
      "convex/_generated/**",
    ],
  },

  // Renderer: Vite + React, browser environment.
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // Main process, Convex backend, scripts, MCP server, tests, build config: Node.
  {
    files: [
      "electron/**/*.{ts,tsx,mjs,js}",
      "convex/**/*.{ts,tsx}",
      "scripts/**/*.{ts,mjs,js}",
      "mcp/**/*.{ts,mjs,js}",
      "tests/**/*.{ts,tsx}",
      "*.config.{ts,mjs,js}",
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
  },

  // TypeScript already flags undefined identifiers; the core no-undef rule
  // produces false positives on TS and is explicitly not recommended by
  // typescript-eslint, so turn it off project-wide.
  {
    files: ["**/*.{ts,tsx,mjs,js}"],
    rules: { "no-undef": "off" },
  },
);
