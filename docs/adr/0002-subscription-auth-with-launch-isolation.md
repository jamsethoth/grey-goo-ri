---
status: accepted
date: 2026-10-15
---

# Headless Claude runs on the owner's subscription, isolated by a launch profile rather than bare mode

Claude Code's bare mode is the documented way to start a session that loads nothing from the machine or the
repository, but it refuses subscription credentials: verified on this machine, it fails with "Not logged in", and
reporters say the OAuth environment token is ignored under it too. The owner runs on a subscription and does not
want metered API billing. We therefore keep subscription authentication and obtain isolation through a launch
profile built from flags the subscription honours. The profile's exact flags live in the request document and may
change with Claude Code versions; what this decision fixes is the order of priorities: subscription first, isolation
second, bare mode adopted the day it works on a subscription.

## Considered options

- Bare mode with an API key. Rejected: it moves spend from the subscription to metered API use.
- Plain headless runs with deny rules. Rejected: a headless run without isolation executes the worktree's own hooks
  and MCP servers, so an implementer step could plant configuration the reviewer step then runs.

## Consequences

Repository `.claude/skills`, `.claude/commands` and `.claude/agents` content is potentially discoverable under the
profile; it is fingerprinted per attempt and protected from agent edits rather than excluded. The doctor probes bare
mode with the OAuth token on every run. The launch profile is part of the config hash, so evaluations never mix the
two.
