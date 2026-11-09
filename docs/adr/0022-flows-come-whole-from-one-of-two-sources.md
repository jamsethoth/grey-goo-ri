---
status: accepted
date: 2026-11-09
---

# Flows come whole from one of two sources, and nothing merges

gg read three configuration Layers, defaults < user < repository, merged key by key (request 3.9). After gg stopped
shipping a Flow (#121), the defaults Layer held four constants and the example user Layers only an Agent's harness,
model and effort, yet the merge cost a rule for each key a Layer may not hold, a rule for file names declared by two Layers, and
surprises: a repository's codex reviewer ran with a person's Claude effort, a person's unused file moved a repository's
Config Hash, and a person's label prefix stranded every Ticket labelled before it (`docs/research/configuration-layers.md`,
issue #314). Configuration exists so that reusable Flows can be defined by a repository or by a user, and a user who
wants to change a repository's Flow can copy it.

gg therefore reads two sources and merges neither into the other:

- **The repository's `.agents/gg/`** and **the user's directory, `GG_HOME`** (default `~/.agents/gg/`). Each `gg.json`
  declares `flows`, `procedures` and `agents`, and the files they name sit beside it. A Flow resolves Procedures,
  Agents, Briefs, Personas and schemas only in its own source.
- **A user Flow is always named `user:<name>`**; an unqualified name is the repository's, so no Flow shadows another.
- **The repository contract** is `commands`, `testPaths`, `approvers`, `labelPrefix` and `baseBranch`: a Run takes
  them from the target repository whichever Flow runs, and no Flow sets them. A Flow names commands; admission refuses
  one the repository does not declare.
- **The user's `gg.json`** also holds the machine settings `maxParallel` and `worktreeRoot`. There are no shipped
  defaults: every setting is required, and its absence is a Problem in `gg doctor` and `gg run` preflight alike, as are
  an unknown key and a bad value.
- **A Run records its repository** (`owner/name`) and its Flow with its source. The Config Hash fingerprints the Flow's
  content, not its source: the Pinned Configuration takes only the files the selected Flow uses.

## Considered options

- Keep three Layers with an allow-list for the user Layer. Rejected: a defaults file for four constants, and a merge
  that still mixed a repository's harness with a person's effort.
- Two Layers, user < repository, over settings in code. Rejected for the same merge, and because the user Layer could
  not declare a Flow of its own.
- A repository Layer plus an untracked per-repository personal file. Rejected: it reverses the repository's authority
  over the keys it shares, every ticket worktree's agent can read it, and a person's settings stop following them.
- The repository Layer alone. Rejected: a person could not keep a Flow of their own for use in several repositories.
- A user Flow that shadows the repository's Flow of the same name. Rejected: the user's directory applies to every
  repository, so one copy named `default` would change every repository's process in silence.

## Consequences

- Supersedes in part ADR 0014 ("The repository owns its Flow": `flows` and `procedures` may now also be declared in the
  user's directory) and decision P2 of `docs/research/user-defined-procedures-decisions.md`. ADR 0014's reason for
  refusing layered Flows, that "a Flow merged from three Layers cannot be read in one place", is kept: a Flow is still
  read whole from one place. ADR 0013 stands: commands are the repository's alone.
- `defaults/gg.json`, the cross-Layer file-name rule and the list of keys a non-repository Layer may not hold go.
  `gg init` writes `labelPrefix` and `baseBranch` into the repository and creates the user's `gg.json` with the machine
  settings; `gg init --harness` writes a harness, model and effort into the example's Agents.
- An eval variant is a named Flow, in either source, picked with `--flow` (#122).
- gg targets the repository holding the current directory or the one `--repo <path>` names. Ticket worktrees move to
  `worktreeRoot/<owner>/<name>/ticket-<n>`; a resumed Execution keeps the path its record holds.
- The Execution Record schema gains `repository` and the Flow's source; a resume whose Flow is no longer declared in
  that source waits, its record kept, as #122 decided for repository Flows; a report already decided still finishes. These, and any new Problem code, land
  before grey-goo-ri issue #23 freezes them.
- A trust record for a repository's unsandboxed commands, and a command that copies a Flow with what it uses, are left
  for later.
