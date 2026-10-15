---
status: accepted
date: 2026-10-14
---

# Build the workflow engine; do not adopt one

Twenty-three open-source agent-workflow frameworks were scored against six requirements: nothing to install beyond Node and the harness CLIs (no second execution environment such as Bun or Deno, no database or service, no WSL2 or container), native Windows, Claude Code and Codex CLI as harnesses, GitHub issues as the work source, bounded loops over persona nodes, and usage tracing per attempt. None met all six; the closest, Archon, requires Bun, a database and WSL2. We build a small interpreter in plain Node and align node field names and the harness capability matrix with Archon's provider contract so results stay comparable.

## Considered options

- Adopt Archon, LangGraph, Mastra or a similar engine and wrap the harnesses. Rejected: each needs Bun, a database or WSL2, which breaks the stock-Node, native-Windows constraint.
- Keep extending feature-flow. Rejected: its topology lived in code behind four fixed stage names, and the owner allowed a ground-up rewrite.

## Consequences

Topology is data and work is code. Parallelism inside a ticket, fan-out and a general scheduler are deliberately out of scope until a real flow needs them.
