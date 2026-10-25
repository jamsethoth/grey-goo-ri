---
status: accepted
date: 2026-10-16
---

# Codex runs the test suite outside its sandbox through one allow-listed launcher

Codex reviews and QA runs on native Windows execute inside Codex's Windows sandbox (MXC). The suite needs things that
sandbox blocks: spawning git and MSYS `sh`, hard links, and renames inside `TEMP`. The limits are known upstream and
open in the Codex issue tracker, so a Codex review reports "suite unverified" instead of real counts. The Codex plugin
that runs those reviews hard-codes the approval policy `never`, so Codex cannot ask to escalate a blocked command;
only an execpolicy rule can let a command run outside the sandbox.

We commit one rule, `.codex/rules/test.rules`, that allows exactly `node scripts/run-suite.mjs`. The launcher spawns
`process.execPath` with `['--test']` in the repo root, resolved from its own location. It never forwards its
arguments and drops `NODE_OPTIONS`, `NODE_PATH` and every `npm_config_*` key, so the allowed prefix cannot be steered
into loading other code. Every other command, `npm test` included, stays sandboxed. Superseded in part by ADR 0016: the
launcher accepts a stage and boundary names from a closed set, and still forwards nothing.

## Considered options

- Allow `npm test`. Rejected: npm reads `npm_config_*`, `.npmrc` and lifecycle scripts, and passes extra arguments
  through, so the allowed prefix would run whatever the caller chose.
- Reviewer escalation, letting Codex ask to run the suite unsandboxed. Rejected: the plugin fixes approval at `never`,
  and editing the plugin or `~/.codex/config.toml` is outside this repo.
- Run Codex under WSL2, where its Linux sandbox allows the suite. Rejected: the project must work on native Windows
  and the owner works there.
- The elevated Windows sandbox. Rejected: it needs administrator setup on every machine and a change to
  `~/.codex/config.toml`, which is outside this repo.

## Consequences

- PR code runs outside the sandbox during Codex reviews, as it already does in the test gate.
- Rules load from the checked-out tree, so a PR that touches `.codex/` needs human review before Codex reviews it.
- The Codex plugin's broker must be restarted after the rule changes, because it reads rules at start.
