---
status: accepted
date: 2026-11-26
---

# A Harness's doctor is given the Agents it runs

Amends ADR 0028's contract row and the frozen Harness contract (#23, `docs/interfaces/harness.md`), for grey-goo-ri
issue #484, part of epic #478. Slice 3's Q13' A refuses a shell command a plugin's hook rewrites, so an Agent that
lists such a plugin has its rewritten commands fail. ADR 0028's `doctor({ probe })` saw the CLI and the machine but no
Agent, so no check could warn of it. The owner decided Clarify's Q4 A and Q5 A on 2026-11-26.

1. **`doctor({ probe, agents })`.** `agents` holds each Agent the admitted Flows' Vertices run on that Harness, once,
   by the name the Vertices use, as declared (`DoctorOptions`, `lib/run-context.ts`). An Agent no admitted Flow runs is
   not given. `probe` keeps ADR 0028's meaning.
2. **Claude's doctor warns** once for each Agent and each plugin it lists that declares a hook able to rewrite a shell
   command before it runs: a `PreToolUse` or `PermissionRequest` hook, in the plugin's `hooks/hooks.json` or its
   `plugin.json`'s `hooks` field (a path, an inline map, or a list of either), whose tool filter matches the
   platform's shell as Claude matches one (Q5 A). gg judges only what a plugin declares, so the warning says the plugin
   "can rewrite" shell commands. It is a cheap check, with no model call.
3. **`FAKE_HARNESS_VERSION` goes to 7** under AGENTS.md's freeze rule, since the contract's `doctor` line changed. The
   fake's scripting keys are unchanged; its `doctor` still passes with no checks.

## Considered options

- `validate(agent)` returns warnings too (Q4 B). Rejected: the warning would repeat on each Vertex using the Agent,
  which ADR 0028 rejected, and validate sees the Agent's fields, not its name.
- Defer the warning to a follow-up (Q4 C). Rejected: a listed rewriting plugin's commands would be refused with no
  warning before a Run.
- Any hook event, or a `PreToolUse` hook in `hooks/hooks.json` naming the shell exactly (Q5 B and C). Rejected: an
  after-run hook such as a formatter changes no command, and plugin.json's hooks load beside hooks.json's.

## Consequences

A Harness's doctor can judge an Agent's declared fields at every `gg doctor` and `gg run` start-up check. Hooks a
marketplace entry adds are not read: they live in the marketplace's catalogue, not the installed plugin.
