---
status: accepted
date: 2026-10-15
---

# Claude on native Windows runs in a trusted-command mode, accepted as weaker than a sandbox

Codex has a native Windows sandbox; Claude Code has none, and the owner's machine is native Windows. Refusing
workspace-write on Claude Windows would mean Claude cannot implement here. We instead run Claude implementation
steps in a named trusted-command mode: only declared commands and gg's allow list may run, git write and gh commands
are denied, network tools are denied unless the node allows network, and integrity assertions after every attempt
detect changes to the checked surfaces (the worktree's HEAD, index and tree, other idle worktrees, protected files,
committed tests). A command that writes elsewhere on the machine or reaches the network through its own means is
neither prevented nor observed. The owner accepts this knowingly.

## Considered options

- Reject workspace-write on Claude Windows. Rejected: it removes Claude as an implementer on the owner's platform.
- Describe the assertions as sandbox-equivalent. Rejected by review: it promised detection the mode cannot provide.

## Consequences

The mode is declared in the harness capability matrix as its confinement, recorded on every event and in the
config hash, and never described as equivalent to a sandbox. Read-only steps use the restricted mode instead, which
removes shell access. If Claude Code ships a Windows sandbox, this decision is revisited.
