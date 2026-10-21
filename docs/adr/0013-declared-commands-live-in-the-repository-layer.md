---
status: accepted
date: 2026-10-21
---

# Declared Commands live in the repository Layer, and no other Layer may set them

gg read a repository's Declared Commands from `- name: \`cmd\`` lines under `## Commands` in its AGENTS.md, a regex
ported unchanged from feature-flow. No decision chose that source, and it matters: Declared Commands are what the
Red and Green Checks and Quality Gates run, and under Trusted-Command Mode (ADR 0007) they are what an agent may run
without a sandbox. Prose Markdown made that list fragile. A duplicate name was a warning and the last one won, a
malformed line was skipped, nothing checked names or values, and AGENTS.md served two readers, the agents and gg.
Declared Commands now live in the repository Layer, `.agents/gg/gg.json`, as a `commands` object from name to
command line, and gg no longer reads AGENTS.md. A `commands` key in the defaults or user Layer is a load error naming
the file: a user Layer must not add to or replace another repository's unsandboxed commands. Because no other Layer
may set it, the repository's object arrives whole, never merged with another. A Layer file with a duplicate key is a
load error, and preflight rejects a name outside `[a-z][a-z0-9-]*`, a value that is not a non-empty single-line
string, and a missing `test`, each naming the repository Layer file.

## Considered options

- Keep AGENTS.md and parse it strictly. Rejected: "strict" still has to decide which Markdown lines are entries
  (bullet styles, nested lists, fences, prose after the command), and the agents' instruction file stays the list.
- The repository Layer first, with AGENTS.md as a fallback and a deprecation period. Rejected: two sources to
  explain, and the list can come from either without the reader knowing which. gg has no repositories to migrate
  but its own.
- Ignore a `commands` key in a user Layer with a warning. Rejected: nothing is silently dropped (ADR 0006).

## Consequences

- AGENTS.md may still describe commands for people and agents working outside gg; gg never reads it. The Brief
  carries the authoritative list (request 3.6).
- The Config Hash of an unchanged command set is unchanged: the pinned `commands` object has the same shape.
- `JSON.parse` keeps the last of two equal keys, so every Layer file, the shipped defaults included, is scanned for
  duplicate keys in one object. That also catches duplicates in `agents` and `flows`.
- Names are no longer lowercased: `Test` is rejected rather than read as `test`.
- The `TODO` placeholder that `ff init` wrote has no meaning in JSON. `gg init` scaffolds the repository Layer without
  a `test` command, so preflight asks for one; `gg doctor` reports what preflight reports.
- The commands are read from the main checkout's working tree, like the rest of the repository Layer, not from a
  commit. Agents cannot change them (`.agents/` is a Protected File), but a human edit takes effect at the next Run.
- What a command delegates to, such as `scripts.test` in `package.json`, is not protected; grey-goo-ri issue #96
  tracks that.
- This repository keeps its AGENTS.md `## Commands` line until the cutover, because feature-flow still builds it and
  reads that line. A test keeps the two equal; grey-goo-ri issue #97 removes both after the cutover.
