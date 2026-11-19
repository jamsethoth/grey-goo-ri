---
status: accepted
date: 2026-11-18
---

# The launch profile is a Harness contract member, pinned with the confinement in the Config Hash

Changes the frozen Harness contract (#23, `docs/interfaces/harness.md`) for grey-goo-ri issue #428, part of epic #421.
Request 3.2 and 3.7 put the launch profile in the Config Hash, and Trusted-Command Mode in the hash and on every
event. Since #423, `shipped(exec)` keeps only the contract's members of a Harness module, so the profile Claude declares
(`claude-headless`, version 1, ADR 0025) never reached gg run: the Pinned Configuration pinned `launchProfile: null`
and every Action Event named none. The owner decided Clarify's Q1 A and Q2 A on 2026-11-18.

1. **`launchProfile` joins the contract's Members and `HARNESS_METHODS`**, after `protectedPaths`: `{ name, version }`
   or `null` when the Harness declares none. Codex declares `null` until slice 3 builds its launch, and so does the
   fake. gg reads it from the Harness it runs, as it reads `protectedPaths`, so a Harness module loaded later against
   the contract is pinned with no further change (Q1 A).
2. **The Config Hash pins, per Harness the Flow's Agents use, the profile and the confinement.** The Pinned
   Configuration's `launchProfile` is `{ <harness>: { name, version, confinement } }`; a Harness with no profile pins
   `name` and `version` as `null` and still pins its `confinement` Capability, so a confinement change moves the hash
   even when no profile version is bumped. A Harness the Flow does not use never moves its hash (Q2 A).
3. **Every Action Event of an Agent's Vertex names the profile as `<name>@<version>`**, such as `claude-headless@1`,
   and the confinement, both strings, so the Event keeps schema 3.
4. **`FAKE_HARNESS_VERSION` bumps to 4**, the version `harness.md` names, since the fake gains the member. No saved row
   changes shape under a version: the Pinned Configuration is saved by its Config Hash, which moves once for every Flow,
   and gg is not yet in use (ADR 0024), so no saved Execution is re-hashed. `EVENT_SCHEMA_VERSION` and
   `RECORD_SCHEMA_VERSION` stay.

## Considered options

- A run option built from `HARNESSES` beside the Protected Files (Q1 B). Rejected: a second source of truth beside the
  Harness object, plumbed through five modules, and a Harness module loaded from outside `HARNESSES` would pin no
  profile until the contract gained it.
- `shipped()` keeping `launchProfile` beside the contract's members (Q1 C). Rejected: `harness.md` says a shipped
  Harness has the fake's contract.
- gg run importing `HARNESSES` (Q1 D). Rejected: the interpreter imports no Harness module.
- The profile alone in the hash (Q2 B). Rejected: Trusted-Command Mode in the hash would rest on a comment asking for a
  version bump, and a Harness with no profile would pin no confinement.
- One profile string for the whole Flow. Rejected: each Agent names its own Harness, so one Flow can run on two.
