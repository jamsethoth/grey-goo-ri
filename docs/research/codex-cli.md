# What the Codex CLI does, recorded (#479)

Findings record of the Codex recording session (owner Q3 A), at **codex-cli 0.171.0** on native Windows, 2026-11-22.
Update it on each re-record. Every claim names the fixture under `test/fixtures/codex/` that shows it:
`<name>.jsonl` is a call's `--json` stream, `<name>.json` its command, line times, last message and evidence (files it
created, the hook and MCP logs, the Windows job's processes), `<name>.rollout.jsonl` its session file, trimmed and
redacted; a command that is no model call is `<name>.json` alone. `scripts/record-codex.ts` re-records them by hand.

Every call ran under gg's `CODEX_HOME` (`GG_HOME/codex`, owner Q5 A), on `gpt-6-luna` at low effort with
`approval_policy="never"`, `windows.sandbox="mxc"` and the project set untrusted unless a scenario says otherwise,
inside a Windows job started as `lib/containment.ts` starts a launch. 28 of the 30 authorised model calls were spent
(owner Q1 A), retries included.

## Findings that change a planned choice

These go to the owner as one decision batch before #481.

1. **The empty start needs three keys and leaves one leak** (decision 2, Q8 A). gg's `CODEX_HOME` holds the login
   (`cli-login-status`), but with no override three things from the user's side still reach the model
   (`prompt-input-default`): the user's `~/.agents/skills` (skill root r0, read from the profile, not from
   `CODEX_HOME`), the ChatGPT account's apps (`mcp__codex_apps__*`) and `<recommended_plugins>`. The keys
   `skills.include_instructions=false`, `features.apps=false` and `features.tool_suggest=false` remove all three
   (`prompt-input-profile`). One leak has no key yet: every shell command runs PowerShell without `-NoProfile`
   (`pwsh.exe -Command` in the stream; 0.163 passed `-NoProfile`), so the user's PowerShell profile is tried on each
   command and its "AuthorizationManager check failed" error lands in every command's output (`start.jsonl`,
   `mxc-workspace-write.json` last message).
2. **gg's `CODEX_HOME` holds ten remote plugins, installed and enabled** (`cli-plugin-list`: `github`, `superpowers`,
   `build-web-apps` and seven more from `openai-curated-remote`). Under the profile keys none of them shows in the
   prompt input, but `plugins` exact (decision 7) means gg disables every plugin an Agent does not list: by a
   `plugins={...}` table naming each installed one, or `--disable plugins` when none is listed. The table excludes a
   plugin its `CODEX_HOME` enables: the probe plugin, installed and enabled, reaches the prompt input with no `-c`
   (`prompt-input-plugin-enabled-default`: `SENTINEL-PLUGINSKILL`) and not under `{enabled=false}`
   (`prompt-input-plugin-excluded`: no sentinel).
3. **Repository `.agents/skills` loads with the project untrusted** (decision 3, Q18 A): `SENTINEL-REPOSKILL` in
   `prompt-input-sentinels-untrusted`. `skills.include_instructions=false` drops it (`prompt-input-sentinels-profile`).
4. **The `unelevated` fallback is not viable** (request 3.2's MXC fallback). Read-only: every shell start fails
   "CreateProcessAsUserW failed: 5 (Access is denied.)" (`unelevated-read-only`). Workspace-write: no command
   returned output, and the process did not exit after `turn.completed` until the recorder's 600 s limit
   (`unelevated-workspace-write`, exit 1, "call limit"). It isolates nothing usable on this machine.
5. **A config MCP server's tool is refused under `approval_policy="never"`** (decision 7, `mcp` exact): the server
   starts and lists its tools (`mcp-schema.json` evidence.mcpLog), but the call fails "MCP tool call requires
   approval, but approval policy is never" (`mcp-schema.jsonl`, `mcp_tool_call` status `failed`). `mcp` exact needs a
   per-server or per-tool approval key; none was found in this session.
6. **A fork without `-s` takes the thread's last sandbox**: forked with no `-s` after a `workspace-write` last turn,
   the fork ran `workspace-write`, where exec's default is read-only (`fork-unflagged`: one `turn_context`,
   `workspace-write`). Whether `-s` overrides a writable parent is unsettled: `fork` passed `-s read-only` after a
   read-only last turn (`resume-config-after` rollout line 53), so it shows nothing either way. #485's read-only fork
   still passes `-s read-only` before `fork`, harmless whether or not it overrides.

## The nine open questions of facts-codex-cli.md

1. **Schema with MCP, #19816**: the schema held with a config MCP server active: the message before the tool call
   was plain text and the final message was schema-valid JSON (`mcp-schema.jsonl`). #19816 did not reproduce on
   0.171. Not run with the owner's own MCP servers, plugins and multi-agent: gg never runs a call with them.
2. **Resume's sandbox and cwd**: settled. `exec -s workspace-write -C <repo> resume <id>` runs the resumed turn
   under them (`resume-flags-before`: rollout `turn_context` read-only, then workspace-write; `repo/resume-flags.txt`
   written). `exec resume <id> -c sandbox_mode="read-only"` takes effect too: a thread last run workspace-write
   resumed read-only and its write was refused (`resume-config-after`). The resumed turn runs in the invocation's
   cwd, not the thread's: started one directory up with no `-C`, its `turn_context.cwd` and `Get-Location` were that
   directory. Outside a git repository, `exec resume` refuses to start without `--skip-git-repo-check` ("Not inside a
   trusted directory", exit 1, before any request). So gg passes `-s` and `-C` before `resume` on every resume.
3. **What `--ignore-user-config` drops**: unsettled beyond its help text ("Do not load `$CODEX_HOME/config.toml`;
   auth still uses `CODEX_HOME`"), and moot: gg's own `CODEX_HOME` works (finding 1), so the fallback that needed it
   is not taken. `codex debug prompt-input` does not take the flag; `exec`, `resume` and
   `fork` do (`cli-exec-help`, `cli-exec-resume-help`, `cli-exec-fork-help`).
4. **Hooks under exec**: settled. `SessionStart` and `PostToolUse` hooks fire under `exec`, both inline
   (`-c hooks={...}` with `commandWindows`) and from `CODEX_HOME/hooks.json`, and their `additionalContext` reaches
   the model (`hooks-on`: the answer names all four sentinels; evidence.hookLog has each payload's keys).
   `features.hooks=false` stops them (`hooks-off`). Without `--dangerously-bypass-hook-trust` none fire, silently
   (`hooks-untrusted`); with it the stream carries an `error` item warning that the bypass is on (`hooks-on.jsonl`).
   `PreCompact` was not recorded.
5. **Failure events and exit codes**: a usage limit (a stand-in Responses API answering 429
   `usage_limit_reached`): `error` then `turn.failed` "You've hit your usage limit…", exit 1 (`usage-limit`). An
   invalid key and a missing login: `error` events "Reconnecting... n/5 (unexpected status 401 Unauthorized…)", an
   `error` item "Falling back from WebSockets to HTTPS transport", then `turn.failed` with the 401, exit 1
   (`auth-invalid`, `auth-missing`). A tree kill mid-command: the stream stops at the command's `item.started`, no
   `turn.failed`, the exit code is the job's, nothing is left running (`tree-kill`: `afterKill` lists no process),
   and the rollout stays resumable: the resumed turn named the command it was running (`tree-kill-resume`). A
   sandbox-blocked command (question 8) is no failure event. Unsettled: a schema violation (the API holds the strict
   schema, so a cheap call cannot provoke one) and an MXC setup failure (none could be provoked safely; the
   unelevated sandbox's "CreateProcessAsUserW failed" in `unelevated-read-only` is the nearest recorded).
6. **Fork and compaction in `--json`**: a fork emits `thread.started` with the new id, then the usual events;
   nothing fork-specific (`fork.jsonl`). With no `-s` a fork runs under the thread's last sandbox, not exec's
   read-only default (`fork-unflagged`, finding 6); whether `-s` overrides a writable parent is unsettled. Usage is cumulative over the original thread on a fork as on a resume
   (`fork`: 113,063 input tokens on a one-message turn, after the thread's 97,898). The fork writes a new rollout
   with `forked_from_id` and leaves the original's unchanged (`fork.json` evidence.forkedRollout.unchanged). A
   compaction emits nothing in `--json`: under `model_auto_compact_token_limit=16000` the rollout holds three
   `compacted` items and the stream only the usual events (`compaction`).
7. **0.171 against 0.163**: the stream's events are the same (`thread.started`, `turn.started`, `item.started` and
   `item.completed` of `command_execution`, `agent_message`, `mcp_tool_call` and `error`, `turn.completed`, `error`,
   `turn.failed`). Changed: commands run `pwsh.exe -Command` without `-NoProfile` (finding 1); the model's tool is
   code mode's `exec`, while the stream still reports `command_execution` items; `exec resume` outside a git
   repository needs `--skip-git-repo-check`; and beside 0.163's flags `exec` lists `--remote`,
   `--remote-auth-token-env`, `--trust` and `--cyber-access-program` (`cli-exec-help`).
8. **A blocked command under `never`**: not `declined`. Under MXC read-only a write the sandbox blocks shows only in
   the command's output: `node write.js` printed EPERM and completed with exit 0; `Set-Content` failed with exit 1,
   status `failed` (`mxc-read-only.jsonl`). The call itself completes.
9. **Token refresh racing `~/.codex/auth.json`**: moot. gg has its own login in its `CODEX_HOME` (Q5 A); nothing is
   copied.

## Decision 4's calls

| Call | Answer | Fixture |
| --- | --- | --- |
| Start and resume with `--json`, `--output-schema`, `-o` (F2) | the final message lands in `-o` as schema-valid JSON; a resume re-emits `thread.started` with the same id | `start`, `resume-flags-before` |
| Resume with flags before `resume`, and with `-c sandbox_mode` and another cwd | both take effect; the turn runs in the invocation's cwd | `resume-flags-before`, `resume-config-after` |
| Read-only and workspace-write under MXC (Q9), a blocked command (F1) | read-only blocks writes; workspace-write: a write, a file symlink, a node child and `node --test` work; a rename in TEMP, a hard link and a junction fail EPERM | `mxc-read-only`, `mxc-workspace-write` |
| An MXC setup failure; the tasks under `unelevated` | MXC failure not provoked (unsettled); `unelevated` not equivalent (finding 4) | `unelevated-read-only`, `unelevated-workspace-write` |
| Hooks under exec (Q10), `features.hooks` each way | fire and inject when on and bypassed; none when off or untrusted | `hooks-on`, `hooks-off`, `hooks-untrusted` |
| One config MCP server with the schema | the request 3.2 regression fixture; the tool refused under `never` (finding 5) | `mcp-schema` |
| Usage limit, auth error, mid-turn tree kill | question 5 above | `usage-limit`, `auth-invalid`, `auth-missing`, `tree-kill`, `tree-kill-resume` |
| Compaction and fork in `--json` | question 6 above | `compaction`, `fork`, `fork-unflagged` |
| Where the rollout lands, what it holds | `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`; a resume appends to the thread's file. It holds `turn_context` (cwd, `sandbox_policy`, approval, model, effort) per turn and `token_count` events with `total_token_usage`, `last_token_usage` and `rate_limits` (`primary` used percent, window minutes, reset time) | `start.json` rolloutPath, `compaction.rollout.jsonl` |
| The cheap commands #484 reads | `codex --version`; `login status` prints "Logged in using ChatGPT" (exit 0) or "Not logged in" (exit 1); `doctor --json` (schema 1, a status per check); `mcp list --json`; `plugin list --json` (the installed plugins; without `--json` it lists the whole remote catalog, over 1 MB); `features list` | `cli-*` |

## Planned choices

| Choice | Verdict | Evidence |
| --- | --- | --- |
| Empty start (Q8 A) | changed: gg's `CODEX_HOME` plus three keys; the PowerShell profile leaks with no key found (finding 1); remote plugins installed there (finding 2) | `prompt-input-default`, `prompt-input-profile`, `cli-plugin-list` |
| Repository content (Q18 A) | changed: `project_doc_max_bytes=0` keeps every instruction file out; `.agents/skills` needs `skills.include_instructions=false` (finding 3). Of the four names, only `AGENTS.override.md`, else `AGENTS.md`, loads by default; `TEAM_GUIDE.md` and `.agents.md` load only when configured as fallbacks. `.codex/config.toml` and project hooks load only when trusted; untrusted, a `.codex/rules` allow did not run its command outside the sandbox. gg also has `--ignore-rules` | `prompt-input-only-*`, `prompt-input-sentinels-*`, `repository-untrusted`, `repository-trusted` |
| Both access intents | confirmed: read-only and workspace-write under MXC behave as question 8 and Decision 4 say | `mxc-read-only`, `mxc-workspace-write` |
| Resume flags (request 3.2) | confirmed: `-s` and `-C` before `resume` hold; gg passes them on every resume, as the cwd is the invocation's | `resume-flags-before`, `resume-config-after` |
| MXC fallback to `unelevated` | changed: not viable (finding 4) | `unelevated-*` |
| Hooks (Q10) | confirmed, with `--dangerously-bypass-hook-trust` on every call that needs gg's hook (or trust persisted in gg's `CODEX_HOME`) | `hooks-*` |
| Capabilities (Q15 A) | `plugins` exact through a `-c` table: `{enabled=true}` adds a plugin its `CODEX_HOME` disables and `{enabled=false}` excludes one it enables (`plugins={"x@y"={enabled=true}}`; the dotted key is silently ignored; `--disable plugins` wins over the table). `mcp` exact: changed (finding 5). `skills` hint: `skills.config` can only disable a discovered skill, not add one, so a declared skill reaches Codex from a skill root, a plugin, or as text | `prompt-input-plugin-*`, `cli-plugin-list-installed`, `mcp-schema`, `prompt-input-skills-config-add` |
| Job containment (F7) | confirmed: while a command ran, the job held the MXC helper (`codex.exe --__codex-windows-mxc`), `powershell.exe`, the command's `node`, `codex-code-mode-host.exe` and a `node` MCP host; every process naming the marker was in the job; nothing was left after exit or after a tree kill | `mxc-workspace-write.json`, `tree-kill.json` evidence.job |
| Rewrite refusal (decision 6) | confirmed on Claude Code 2.1.330 (the Claude recorder, owner Q2 A): under `-p` with the launch profile on PowerShell, a listed plugin's PreToolUse hook that prefixes the Declared Command `node --version` with a wrapper, giving `updatedInput` and no permission decision, has the rewritten command refused against the allow list (`permission_denied`, its `permission_denials` entry holding the rewritten command); `git status`, not rewritten, ran under its rule | `test/fixtures/claude/rewrite-refusal` |

## Unsettled

- A schema violation's events and exit code, and an MXC setup failure (question 5): neither could be provoked safely.
- What `--ignore-user-config` drops (question 3): moot while gg's own `CODEX_HOME` holds.
- Whether a trusted project's `.codex/rules` allow runs its command outside the sandbox: in `repository-trusted` the
  model answered that it could not run commands, so the rule's effect was not seen. gg never trusts a project.
- Whether `-s` on `exec` before `fork` overrides a parent thread last run `workspace-write` (finding 6): the recorded
  `fork` followed a read-only last turn.
- An approval key that lets a config MCP server's tool run under `never` (finding 5).
- A key that stops PowerShell loading the user's profile (finding 1).
