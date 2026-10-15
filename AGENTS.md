# grey-goo-ri

Node CLI (`gg`) that carries GitHub tickets through a configurable bounded workflow graph of persona nodes on
agentic harnesses (Claude Code, Codex) to reviewed pull requests. The layout section here grows with the code.

## Documents and their authority

- `docs/requests/node-harness-dag.md` decides behaviour. Read it before any ticket.
- `docs/adr/` records why the hard-to-reverse decisions were made. Do not reverse one without a new ADR.
- `GLOSSARY.md` decides what things are called, in code, tickets, records, events and labels. Its avoid lists ban
  competing names for a defined concept, not words in their ordinary technical sense.
- Behaviours marked "ported" in the request document have their source in `C:\dev\projects\feature-flow` at
  commit 89e1d67, with line references in `C:\dev\ff-review-work\design-vetting-code.md` section 1. A port ticket
  names its source lines; "port unchanged" without a source is not a complete ticket.

## Conventions

- Plain Node ESM (`.mjs`), Node 20+, no runtime dependencies. Prefer node built-ins.
- Must work on native Windows: spawn real executables without a shell, forward-slash-safe paths.
- Tests must not call the real `claude`, `codex` or `gh`, or touch GitHub; use the fake harness and temp repos.
- Codex output schemas are strict: every property required, `additionalProperties: false`.
- Comments only for the non-obvious why.

## Commands

- test: `npm test`
