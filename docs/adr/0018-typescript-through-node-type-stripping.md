---
status: accepted
date: 2026-10-31
---

# TypeScript through Node's type stripping, checked by tsc and ESLint in every suite stage

gg is written almost entirely by agents, and its data shapes (the Execution Record, the Harness contract, Usage, the
Resolved Flow, Brief context) are defined nowhere but in the code that builds them, kept in step only by runtime
contract suites. A shape mistake surfaces as a failing test, a review finding or a runtime error, when a type error at
the exact line is cheaper feedback than any of them. Prose rules in AGENTS.md are not guaranteed to be followed, so the
readability rules of grey-goo-ri epic #193 belong in tools whose failures an agent sees. grey-goo-ri issue #190 asked
for type checking; this ADR settles it and the epic closes it.

We write gg in TypeScript that Node runs directly. Node 26.13 strips erasable type syntax from `.ts` files with no flag
and no warning, so there is no build step: `node bin/gg.mjs` and `node --test` run the sources as they are. Modules
convert from `.mjs` to `.ts` one at a time, in the epic's dependency order, starting with `lib/paths.ts`; no new `.mjs`
file may be added (`test/unit/layout.test.ts` holds the list of converted files, which only grows, and the list of
legacy `.mjs` files, which only shrinks).

`tsconfig.json` sets:

- `strict`, and `noEmit`, since tsc only checks.
- `module` and `moduleResolution` `nodenext`, matching how Node resolves ESM.
- `allowImportingTsExtensions`, because Node needs the real file name: `import * as paths from './paths.ts'`.
- `verbatimModuleSyntax`, so a type-only import is written `import type` and stripping leaves no dangling import.
- `erasableSyntaxOnly`: Node strips types but does not transform code, so enums, namespaces and parameter properties
  are errors. A string-literal union or an `as const` object takes an enum's place.
- `types: ["node"]`: TypeScript 6 loads no `@types` package unless it is listed, and without `@types/node` (major 26,
  matching the Node floor of ADR 0020) tsc cannot resolve `node:test` or any built-in module.
- `allowJs` with `checkJs: false`, until the last module converts: a `.ts` module can import an `.mjs` one, and the
  legacy files are parsed but not checked. Leaving `checkJs` unset cost 9 to 13 s of check time on 23,000 lines of
  JavaScript, against under 1 s with it set to `false`, though neither reports an error in a `.mjs` file.
- `skipLibCheck`, which skips checking the `.d.ts` files of `@types/node` and the TypeScript library: 3 s of the
  remaining 4. gg writes no `.d.ts` file of its own.

ESLint, through typescript-eslint's parser and `@stylistic/eslint-plugin`, enforces the epic's rules on `.ts` files only:
a module meets them when it converts, and an unconverted `.mjs` file is legacy until its ticket. There is no
suppressions file. Where a rule takes a message (`no-restricted-syntax`), the message says how to fix, since agents
read it. Prettier is installed and configured for code files only (never templates, Personas, schemas, fixtures or
JSON, whose bytes are hashed or rendered); grey-goo-ri issue #196 formats every code file and turns its check on.

Every stage of `scripts/run-suite.mjs` runs `prettier --check` (from #196), then ESLint, then `tsc`, then the tests,
and the first failure stops it, so CI (which runs the full stage) enforces the rules as well as the fast stage. The
launcher spawns each as `process.execPath` plus the package's own bin script (`node_modules/prettier/bin/prettier.cjs`,
`node_modules/eslint/bin/eslint.js`, `node_modules/typescript/bin/tsc`), never through a shell or an npm `.cmd` shim, in
the same cleaned environment as the tests (ADR 0010). They load only the repository's own configuration and the
packages `package-lock.json` pins. The launcher's arguments are unchanged, so
ADR 0016's closed set stands. The fast stage's patterns become `*.test.{mjs,ts}`; the full stage's `node --test` with
no pattern already finds `.ts` tests.

## Considered options

- JSDoc types with `// @ts-check` on `.mjs` files (issue #190's first step). Rejected: the epic converts every module
  anyway, and JSDoc types are harder for agents to read and write than inline ones; an interface in JSDoc is a comment.
- `.mts` files. Rejected: `package.json` keeps `"type": "module"`, so `.ts` is already ESM, and `.ts` is what agents and
  editors expect.
- A build step (tsc emitting JavaScript, or a bundler). Rejected: it breaks running the sources directly, which the
  suite and every spawned support script rely on, and adds a stale-output failure mode.
- Running the strict rules on every file with ESLint's bulk suppressions. Rejected by the owner (2026-10-31): a probe on
  ESLint 10.14 showed suppressions list every violation of a rule in a file once its count is exceeded, fail on
  unpruned entries, and key entries by path, which a rename to `.ts` drops.
- Lint and type check in the fast stage only. Rejected: CI runs the full stage, and the owner's intent is that the
  suite enforces the rules.
- TypeScript 7. Rejected for now: typescript-eslint 8.72 supports TypeScript below 6.1, so `typescript` is pinned to
  `~6.0.3`. Revisit when typescript-eslint supports 7.

## Consequences

- `package.json` has its first dependencies, all dev: `typescript`, `eslint`, `typescript-eslint`,
  `@stylistic/eslint-plugin`, `prettier` and `@types/node`. A checkout needs `npm ci` before the suite; the launcher
  says so if a bin script is missing, and CI runs `npm ci` on both legs. Rows in `docs/library-survey.md`.
- Node refuses to strip types in a file under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so gg
  runs from a checkout. Publishing gg as an npm
  package would need a build step and a new ADR.
- Amended 2026-11-02 (grey-goo-ri issue #242): the supported install is a clone, `npm ci` in it, then
  `npm install -g <clone>` or `npm link` in the clone. Either links the global `node_modules` to the clone, so Node loads
  every file from its real path there (README, "Install"). `package.json` is `private`, so `npm publish` refuses
  (`EPRIVATE`), though npm 11.20's `npm publish --dry-run` skips that check and reports success; `npm pack` still packs a
  copy, which cannot start. Publishing gg is grey-goo-ri issue #243.
- The "Plain Node ESM (`.mjs`)" convention in AGENTS.md is amended: `.ts` for new and converted modules and tests.
- The fast stage gains the time Prettier, ESLint and tsc take (a few seconds each on an idle machine).
- Amended 2026-11-04 (grey-goo-ri issue #207): no `.mjs` file is left under `lib/`, `bin/` or `scripts/`. The entry
  point is `bin/gg.ts`, which `package.json`'s `bin` names and `node bin/gg.ts` runs, and the suite launcher is
  `scripts/run-suite.ts`.
