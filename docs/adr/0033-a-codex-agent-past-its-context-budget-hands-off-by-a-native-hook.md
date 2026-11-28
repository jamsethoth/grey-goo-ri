---
status: accepted
date: 2026-11-27
---

# A Codex agent past its contextBudget hands off by a native hook, and its successor gets the note only

Amends ADR 0029 (its Codex line and point 6), ADR 0031 (points 2 and 5 and its Consequences) and request 3.2 (plugin
hook injection), for grey-goo-ri issue #485, part of epic #478. ADR 0029 left Codex's hand-off to slice 3, and ADR
0031 declared Codex's `contextBudget` unsupported until this ticket. Request 3.2 specified `harnesses.codex.injectHooks`
when Codex had no hooks. #479's recordings show hooks fire under `codex exec` (`docs/research/codex-cli.md` question 4:
`hooks-on`, `hooks-off`, `hooks-untrusted`), which decides the issue's branch 1. The owner decided Clarify's Q1 A, Q2 A
and Q3 A on 2026-11-27, and Q4 A the same day.

1. **Past its budget a Codex agent is asked to hand off by a PostToolUse hook, as a Claude agent is (ADR 0029 point
   1).** The launch of an Agent with a `contextBudget` passes `features.hooks=true`, the hand-off hook as an inline
   `-c hooks={PostToolUse=...}` table whose `commandWindows` is its `command` (request 3.2: "`commandWindows` required
   for any hook on win32"), and `--dangerously-bypass-hook-trust`, without which no hook fires, silently
   (`hooks-untrusted`). Every other launch keeps `features.hooks=false` and no bypass. Every launch keeps the project
   `untrusted`, so no project hook loads under the bypass (Q18 A, `repository-untrusted`). The hook reads the
   thread's rollout, where the latest request's context is its last `token_count` event's
   `last_token_usage.input_tokens`, cached tokens among them; past the budget it asks for the `handed-off` Claim and
   its note, again each further 40,000 tokens (`lib/harnesses/codex-handoff-hook.ts`). Codex's `contextBudget`
   Capability is `exact`. As Claude's `--autocompact` does, `model_auto_compact_token_limit` at 125% of the budget
   stays the backstop (request 3.1; `compaction` shows the key compacts).
2. **A hook file in gg's Codex home fails a budgeted Agent (Q3 A).** With hooks on, Codex also runs the hooks of
   `CODEX_HOME/hooks.json` (`hooks-on`'s `home` lines), against Q8 A's "no hook but gg's reaches a call". So while gg's
   Codex home holds `hooks.json`, or a `config.toml` that declares `hooks` (a `[hooks]` table, a `hooks.` dotted key
   or an inline `hooks` key, D1 A), Codex's `validate` fails an Agent with a `contextBudget` at preflight, naming the
   file, and `launchArgs` fails its call before spawn for a file added since. A `config.toml` holding only plugin or
   MCP server entries, which `codex plugin add` and MCP setup write, fails nothing. Every other Agent runs as before,
   its hooks off.
3. **A Codex successor gets the note only, with no `gg ask-session` line (Q1 A, which the probe resolved to B).**
   ADR 0029 point 6 has the fresh agent ask its handed-off Session through `gg ask-session`. A Codex agent's commands
   run inside Codex's sandbox. #485's probe started gg ask-session's fork of a kept thread by node from PowerShell
   inside `codex sandbox` under MXC, once with the `:read-only` permissions profile and once with `:workspace`: both
   nested forks exited 1 before any model call, with "failed to initialize in-process app-server client: Access is
   denied. (os error 5)" after failing to write `tmp\arg0-windows` in gg's Codex home, and `mkdtemp` in TEMP failed
   with ENOENT under both (`docs/research/codex-cli.md` question 10). So the rule, which names no Harness: an agent whose
   Harness runs its commands in a sandbox (its `sandbox` Capability is not `none`) is not offered `gg ask-session`,
   neither in its commands nor in the hand-off section's line (`lib/agent-handoff.ts`). The handed-off thread stays on
   the record (ADR 0029 point 5), and `gg ask-session` still asks it from outside the sandbox, for a person or a Claude
   agent.
4. **The Codex launch profile stays `codex-exec` at version 1 (Q4 A).** ADR 0031 point 2's last sentence, "A change to
   this argv bumps the version", is replaced by: "A change to the argv or environment of a call this version admits
   bumps the version; argv added for an Agent it refused at preflight does not." Version 1 refused every Agent with a
   `contextBudget`, so no call it ran changes: the Config Hash of every Codex Flow, the Action Event's profile string
   and the example's recordings still name the launch each call got.
5. **`harnesses.codex.injectHooks` is dropped.** Request 3.2's plugin hook injection was written for a Codex without
   hooks; Codex runs hooks under `exec` now, so a generic runner of a plugin's session-start command has no purpose.
   A listed plugin bringing hooks stays refused on Codex (ADR 0031 point 8) until a recording shows its hooks load:
   `codex features list` shows `plugin_hooks removed` (`cli-features.json`). No `harnesses` key is added.
6. **The tests stand in for a hand-off answer; the owner's `gg doctor --probe` checks the real hook (Q2 A, ADR 0029
   point 7).** The hook's firing is recorded (`hooks-on`); a Codex answer that hands off is not, so the cases replay
   recorded calls with a constructed `handed-off` final message. The Codex doctor's probes check the hook under the
   real CLI, and the owner runs them once before this merges.

## Considered options

- Bump the launch profile to version 2 and re-record the example's first-visit pass (Q4 B). Rejected: 3 model calls
  and fixture churn for argv no version 1 call ran.
- Bump to version 2 and gate the recordings on argv instead (Q4 C). Rejected: a test change and a review round for the
  same result as Q4 A.
- Give a Codex successor the `gg ask-session` line unprobed (Q1 C). Rejected: the probe shows the nested fork fails
  inside the sandbox, so every Codex successor would get a command that cannot work.
- Have the doctor only warn of a hook file in gg's Codex home (Q3 B). Rejected: a run started without `gg doctor`
  would still run the home's hook.
- Fail a budgeted Agent on any `config.toml` in gg's Codex home (#485 D1 B). Rejected: a plugin or an MCP server
  there writes one, so budget could not run beside the plugins and MCP servers ADR 0031 supports on Codex.
- Build `injectHooks` (the issue's branch 2). Rejected: the branch was for a Codex whose hooks do not fire under
  `exec`.

## Consequences

`lib/harnesses/codex.ts` declares `contextBudget` `exact` and builds the hook's launch keys; its hook lives in
`lib/harnesses/codex-handoff-hook.ts`. A Codex Agent setting `network` still fails preflight at its key. Asking a
handed-off thread from inside Codex's sandbox waits for a way out of it that a recording shows working.
