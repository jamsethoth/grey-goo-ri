---
status: accepted
date: 2026-11-20
---

# A Harness's doctor runs cheap checks on every run and its model probes only under gg doctor --probe

Replaces ADR 0002's "the doctor probes bare mode with the OAuth token on every run", and amends the frozen Harness
contract (#23, `docs/interfaces/harness.md`), for grey-goo-ri issue #427, part of epic #421. A bare-mode probe on every
run is a model call each time, and nothing checked that the Claude CLI was present, recent enough and logged in before
a Run spent a Ticket on it: a logged-out CLI showed only at the first Attempt, whose `auth` Failure Class stops the
Run. The owner decided planning's Q5 A, G10 and G15 on 2026-11-16 and Clarify's Q1 to Q5 A on 2026-11-19.

1. **No model call by default.** `gg doctor` and `gg run` preflight call `doctor({ probe: false })` on each Harness the
   admitted Flows' Agents use, once however many Vertices use it. Its cheap checks start the CLI only for commands
   that are no model call. For Claude: the executable starts (an npm `.cmd` shim followed); `claude --version` is at
   least 2.1.328, the version #425's recordings came from; `claude auth status --json` says `loggedIn`; on win32,
   PowerShell, the Agents' shell (ADR 0025), is on PATH; and `claude --help`'s `--bare` line still says OAuth and
   keychain are never read.
2. **Model probes only under `gg doctor --probe`**, which passes `doctor({ probe: true })`. For Claude: the launch
   profile's probe (its init lists only the built-in plugins, and a repository's CLAUDE.md does not reach the answer),
   and the `--bare` probe with `CLAUDE_CODE_OAUTH_TOKEN`, which tells the day bare mode takes a subscription (ADR
   0002's switch). With no token set, the bare probe is skipped with a warning naming `claude setup-token` (Q5 A).
3. **The contract's `doctor` row**: `doctor({ probe })` resolves `{ ok, checks }`, each check `{ name, ok, severity,
   message }` (`DoctorReport`, `lib/run-context.ts`). gg reports each failed check as one `harness-doctor-failed`
   Problem `{ harness, check, reason }` at no configuration path, an error or a warning as its `severity` says, so
   one fact about the machine prints once (Q1 A). A changed `--bare` help line is a warning naming
   `gg doctor --probe`, since it is a sign, not proof, that bare mode takes a subscription (Q4 A).
4. **`FAKE_HARNESS_VERSION` goes to 5** under AGENTS.md's freeze rule, since the contract's `doctor` line changed. The
   fake's scripting keys are unchanged; its `doctor` passes with no checks.

## Considered options

- The bare probe on every run, as ADR 0002 said. Rejected: a model call per run, for a switch that has not happened.
- `harness-preflight-failed` on each Vertex (Clarify Q1 B). Rejected: seven identical lines for one logged-out CLI in
  the shipped Flow.
- A Problem code per check (Q1 C). Rejected: each Codex check in slice 3 would add one.
- A changed help line as an error (Q4 B). Rejected: a help-text edit would stop every Run.

## Consequences

A Harness that builds no `doctor` (Codex until slice 3) runs no checks. A later Claude version that changes the
`auth status --json` keys or the `--bare` help is re-recorded by `node scripts/record-claude.ts cli-version
cli-auth-status cli-auth-status-logged-out cli-help`, which makes no model call.
