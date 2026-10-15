---
status: accepted
date: 2026-10-15
---

# Isolate Claude sessions with a launch profile, not bare mode

Claude Code's `--bare` flag is the documented way to start a session that loads no hooks, plugins, MCP servers, skills or repository instructions, but it refuses subscription credentials: verified on this machine, it fails with "Not logged in", and the issue tracker reports the OAuth environment token is ignored under it too. The owner runs on a subscription. We therefore start every headless Claude session with a launch profile that reaches the same isolation through flags the subscription honours: no setting sources, strict MCP config, a gg-owned settings file, plugins loaded only by directory, environment variables that disable CLAUDE.md and auto memory, and `--restricted` on read-only steps. Verified on claude 2.1.300: installed plugins, a project skill and a CLAUDE.md instruction were all absent.

## Considered options

- Bare mode with an API key. Rejected for now: it changes billing from the subscription to metered API use.
- Plain `-p` with deny rules. Rejected: a headless run without isolation executes the worktree's own hooks and MCP servers, so an implementer step could plant configuration the reviewer step then runs.

## Consequences

Repository `.claude/skills`, `.claude/commands` and `.claude/agents` content is potentially discoverable under this profile; it is hashed into the config hash and protected from agent edits rather than excluded. The doctor probes bare mode with the OAuth token on every run so the switch can happen the day it works. The launch profile is part of the config hash, so evaluations never mix the two.
