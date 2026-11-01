# grey-goo-ri

Grey goo, regulated intelligence. A configurable bounded workflow graph of persona Agents, each a persona, model, effort and tool set
handed to an agentic harness (Claude Code or Codex CLI), that takes GitHub tickets from plan to reviewed pull request
with deterministic gates, full tracing and usage metrics. Successor to feature-flow.

Status: under construction, and not yet usable on a real ticket.

- `gg doctor` validates the configuration and prints each Resolved Flow.
- `gg run <ticket>` admits a Ticket and runs its Flow, but the Claude Code and Codex Harnesses are stubs, so its
  preflight fails with "not implemented" for every Vertex that has an Agent.
- `gg init`, `plan`, `publish`, `work`, `trace` and `stats` are not implemented.

Behaviour is decided by `docs/requests/node-harness-dag.md`; contributors and agents start at `AGENTS.md`.

License: AGPL-3.0-or-later.
