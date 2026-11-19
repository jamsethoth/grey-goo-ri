---
status: accepted
date: 2026-11-18
---

# The validator refuses what the Capability matrix says; a Harness's `validate` checks the rest

Amends the frozen Harness contract (#23, `docs/interfaces/harness.md`) for the validator's Capability checks
(grey-goo-ri issue #429, part of epic #421). The contract said `validate(agent)` "checks an Agent against the matrix",
so the Claude Harness refused an Agent listing a field it declares unsupported, such as `mcp`. `gg run` preflight runs
`validate` once per Vertex, so one mistake in a declared Agent was reported once for each Vertex that used it, as
`harness-preflight-failed`, with no key to point at. The owner decided Clarify's Q2 on 2026-11-18.

1. **The validator owns the matrix's rules** (Q2 A). An Agent listing a field its Harness declares `unsupported` is one
   `unsupported-agent-field` error, at the key that lists it, from gg's configuration check, which `gg doctor` and
   `gg run` preflight share. The same check refuses a Permission Intent the Harness declares `hint` or `unsupported`
   (`unenforceable-permission-intent`) and a recovering Vertex on a Harness that cannot resume a Session
   (`session-resume-unsupported`).
2. **`validate(agent)` checks what the matrix cannot say about an Agent**, such as a field's own shape (Claude's
   `plugins` names, its `contextBudget`). A Harness no longer repeats a matrix rule, so one mistake is one error.
3. **`FAKE_HARNESS_VERSION` goes to 3** under AGENTS.md's freeze rule, since the contract's `validate` line changed.
   The fake's scripting keys are unchanged, and its default `validate` refuses nothing.

## Considered options

- Claude's `validate` keeps refusing an unsupported field beside the validator's error (Q2 B). Rejected: one mistake
  would still be reported once per Vertex, besides once at its key.
- A rewording with no ADR, as #411 and #423 reworded Member lines. Rejected: the line moves a duty from every Harness
  to gg, which a later Harness's author (#425, Codex) needs recorded.

## Consequences

A new Harness declares its Capabilities and leaves their refusal to gg; its `validate` checks only its own fields'
shapes. A Harness that declares no Capabilities is refused by the contract check before any of these run.
