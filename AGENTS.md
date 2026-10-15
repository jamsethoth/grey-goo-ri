# grey-goo-ri

Node CLI (`gg`) orchestrating a configurable DAG of persona nodes on agentic harnesses. See
docs/requests/node-harness-dag.md for the design request; the layout section here grows with the code.

## Conventions

- Plain Node ESM (`.mjs`), Node 20+, no runtime dependencies. Prefer node built-ins.
- Must work on native Windows: spawn real executables without a shell, forward-slash-safe paths.
- Tests must not call the real `claude`, `codex` or `gh`, or touch GitHub; use the fake harness and temp repos.
- Codex output schemas are strict: every property required, `additionalProperties: false`.
- Comments only for the non-obvious why.

## Commands

- test: `npm test`
