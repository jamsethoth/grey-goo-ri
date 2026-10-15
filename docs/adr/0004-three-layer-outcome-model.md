---
status: accepted
date: 2026-10-15
---

# Outcomes are derived in one module from three separate inputs

feature-flow let each harness adapter decide what a failure meant, by throwing, and let the orchestrator read the agent's own status as the result. The same malformed response could retry under one adapter and end the ticket under another, and an agent could claim success past a failing test. gg separates three inputs that never mix: the agent's claim (one enum token in structured output), the harness result (completed, failed with a typed class, timed out, killed) and the orchestrator's deterministic checks. One transition table, in exactly one interpreter module, derives the outcome and its direction. Harnesses and procedures never decide outcomes.

## Considered options

- Per-adapter failure handling with shared conventions. Rejected: conventions drift, and the drift is invisible until two harnesses disagree on the same input.
- Treat the agent's claim as the result and check afterwards. Rejected: wrongly advancing is the costly error in every phase, because it surfaces late and poisons everything after it.

## Consequences

Advance requires a completed harness result, a valid claim and every declared check passing; integrity violations always stop; both rules are fixed. Which checks a procedure declares is configuration, and the ordering among non-advance outcomes is a per-node resolution policy with a shipped default. An agent's blocked claim stops the ticket even when tests pass.
