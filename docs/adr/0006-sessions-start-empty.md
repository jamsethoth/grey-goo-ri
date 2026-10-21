---
status: accepted
date: 2026-10-15
---

# Every agent session starts empty; the shipped defaults add nothing

feature-flow's defaults named a specific plugin in its stage tools and injected it into Codex sessions in code, so the framework carried an opinion about how agents should work. gg's shipped defaults declare agents with no skills, no plugins, no MCP servers, no hooks and no repository instructions. Everything an agent receives is declared in user or repository configuration and applied generically by the harness. No plugin name appears in code.

## Considered options

- Ship an opinionated default toolset. Rejected: it hides a variable from every evaluation, and it couples the framework to tools the owner may swap.

## Consequences

The launch profile must be able to produce a truly empty session, which was verified on this machine. Harnesses declare each tool field as exact, hint or unsupported: an agent that lists an unsupported field fails preflight, a hinted field runs with its declared semantics and is recorded as hinted, and a permission intent must be enforceable on every surface the agent uses or preflight fails. Nothing is silently dropped. The one stated exception is repository `.claude` content under the Claude launch profile, which is hashed and protected rather than excluded.
