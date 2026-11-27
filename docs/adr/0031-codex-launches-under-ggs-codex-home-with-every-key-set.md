---
status: accepted
date: 2026-11-25
---

# Codex launches under gg's own Codex home with every harness-owned key set, and is judged per surface

For grey-goo-ri issue #481, part of epic #478, from #479's recordings (`test/fixtures/codex/`,
`docs/research/codex-cli.md`, codex-cli 0.171.0). The Codex Harness was a stub: no Capabilities, no `validate`,
`resolveTools` or launch argv, and a null launch profile. The owner decided the issue's decisions 1 to 7 on 2026-11-21
and Clarify's Q1 to Q3 on 2026-11-23. Codex stays refused at preflight until #482 builds its `run`.

1. **gg's own Codex home.** Every launch and every listing sets `CODEX_HOME` to `codex` under `GG_HOME` (Q8 A), never
   the user's `~/.codex`, so the login, plugins and sessions a call sees are gg's.
2. **The launch profile `codex-exec`, version 1.** `codex exec -s <access> -C <cwd>`, then every harness-owned key as a
   `-c` override, since CLI overrides rank above project and user config: `approval_policy="never"` (F1);
   `windows.sandbox="mxc"`; the project set `untrusted` by a `projects` table, so its `.codex/config.toml` and hooks do
   not load; `features.hooks=false` on every call, set explicitly, since #479 recorded no plugin hook under `exec`,
   until #485's budget hook turns it on for an Agent it serves; `features.apps=false`, `features.tool_suggest=false`,
   `skills.include_instructions=false` and `allow_login_shell=false`, which #479 found an empty start needs (D10 A);
   `project_doc_max_bytes=0`, which keeps every repository instruction file out, `AGENTS.override.md` among them, as
   `CLAUDE_CODE_DISABLE_CLAUDE_MDS` keeps `CLAUDE.md` out of a Claude call (Q18 A); `check_for_update_on_startup=false`;
   and the Agent's model and effort when it sets them. The call ends `--json --output-schema <file> -o <file> -`: the
   strict schema from a file in the Run directory, the Brief on stdin, and the final message read from the `-o` file
   (F2), one per call. A change to this argv bumps the version (replaced by ADR 0033 point 4, #485 Q4 A: a change to
   the argv or environment of a call this version admits bumps the version; argv added for an Agent it refused at
   preflight does not).
3. **A resume keeps its sandbox and cwd** by passing `-s` and `-C` before `resume <id>` on every resume: a resumed turn
   runs under the invocation's flags and in its cwd, not the thread's (codex-cli.md question 2).
4. **Both access intents hold under MXC, with no unelevated fallback.** `-s` is the Agent's `access`; on win32
   `mxc-workspace-write` showed a write, a file symlink, a node child and `node --test` work, and a rename in TEMP, a
   hard link and a junction fail EPERM. `unelevated` isolates nothing usable (finding 4, D12 A), so an MXC error ends
   the call as a typed failure, and request 3.2's fallback line is amended.
5. **Capabilities as #479 showed them (Q15 A).** A field not shown `exact` is `unsupported`: `access`, `plugins` and
   `mcp` are `exact`; `skills` is `hint`, since a declared skill reaches Codex as text only; `network` is
   `unsupported`, since no recording shows a network call blocked or allowed; `contextBudget` is `unsupported` until
   #485 (`exact` since ADR 0033). A listed MCP server runs outside the sandbox under `default_tools_approval_mode="approve"`, passed after its
   table, and the Agent's listing is the owner's consent for it (D17 A). The confinement is Codex's sandbox, not
   Trusted-Command Mode, and the Config Hash pins it with `codex-exec` at its version (ADR 0027).
6. **The per-surface rules live in Codex's `validate`** (ADR 0026 point 2): the shell and file tools, MCP, plugins and
   hooks, and network each enforce `access` and `network`, or the Agent fails preflight. The frozen Capability shape is
   unchanged. Claude's accepted Trusted-Command Mode limits stay as ADRs 0007 and 0025 record them, so its Agents stay
   admissible; a stronger Claude rule needs its own decision.
7. **`validate` lists what Codex has installed (Q2 A).** Codex's `validate` is built from `exec` in `createCli`, and
   lists the installed plugins and configured MCP servers once per preflight, only for an Agent that lists one; `run`
   (#482) lists again before each spawn. A failed listing, or one of an unexpected shape, is an error naming its
   command; a listed plugin or server Codex lacks fails before spawn. `docs/interfaces/harness.md`'s `createCli`
   sentence names `validate`, and `FAKE_HARNESS_VERSION` goes to 6 under AGENTS.md's freeze rule.
8. **A listed plugin is switched by one `plugins` table and brings only its skills (Q3, reading 1 with the folder
   check).** Every installed plugin is named in one inline `plugins` table, `{enabled=true}` when the Agent lists it
   and `{enabled=false}` otherwise, or `--disable plugins` when it lists none (D11 A). The table opens with
   `_default={enabled=false}`: without it a catalog plugin's own `enabled=true` outranks its `{enabled=false}` entry
   (openai/codex #28443), and #481's empty-start call still carried openai-developers' two tool servers; with it, only
   an entry saying `true` turns a plugin on, a plugin installed after the listing included (D6 A, Round 2c). A manifest's `apps` stay off
   under `features.apps=false` and are noted on the Action. A plugin is refused at preflight, naming the part, when its
   manifest declares `mcpServers`, `hooks` or any working key beyond `skills`, `apps` and the descriptive keys, or when
   its folder holds a `.mcp.json` or a hooks file whatever its manifest says. The remote plugin catalog stays on
   (D1 A): every installed plugin gg admits is a catalog plugin, and the table alone decides which load, where
   feature-flow's `features.remote_plugin=false`, unrecorded on 0.171, would drop them all. Since
   `skills.include_instructions=false` removes Codex's whole skills list, its bundled skills with it, gg writes the list
   itself into the prompt (D2 A), each skill by name, description and `SKILL.md` path as Codex's own list gives it:
   Codex's bundled skills (`skills/.system` in gg's Codex home), each skill the Agent declares, found by name in the
   user's `~/.agents/skills`, and each listed plugin's skills under its name; nothing else of the user's or the
   repository's. A bundled skill whose `agents/openai.yaml` sets `policy.allow_implicit_invocation: false` is left
   out, as Codex's own list leaves out the two bundled skills that set it (D7 A); a listed plugin's is listed, its
   description ending "(use only when the task names this skill)", since the Agent names its plugin (D8 C). A
   declared skill not found there fails preflight. `launchArgs` returns the list as `Launch.skills`, and #482's `run` writes it on stdin
   before the Brief (D5 A). Q1's call showed the read-only sandbox lets the model open a listed plugin's skill file
   outside its working folder.
9. **Plugin acceptance is one rule across Harnesses, in time.** The check finds a plugin's parts by manifest key or
   folder file from a layout the Codex Harness passes in, and refuses any part outside an admitted set it also passes
   in, naming no Harness. It lives in `lib/harnesses/codex-plugins.ts` while Codex is its one caller, and moves
   unchanged into a shared module when Claude becomes its second (#535, under its own ADR).
10. **ADR 0025 point 5 is replaced** (decision 6, Q13' A): no prefixed twins of the permission rules; a command a hook
    rewrites fails closed under the default-deny rules, as #479 showed. #488 keeps declared prefixes in the backlog.

## Considered options

- The user's `~/.codex` as the Codex home, as feature-flow ran. Rejected (Q8 A): the user's plugins, skills, hooks and
  instructions would reach every call.
- The call alone lists plugins and servers, before spawn (Q2 B). Rejected: a missing plugin would fail mid-Run, not at
  preflight.
- Admit any listed plugin, the listing as consent (Q3 B). Rejected: a plugin's MCP servers and hooks would run outside
  the sandbox and the `features.hooks` rule unseen.
- An unelevated retry on an MXC error. Rejected (D12 A): it isolates nothing usable on Windows.

## Consequences

`lib/harnesses/codex.ts` declares the profile, Capabilities, `validate`, `resolveTools` and `launchArgs`; `run` and
`doctor` arrive with #482 and #484. A Codex Agent setting `network` or `contextBudget` fails preflight at its key
(`contextBudget` runs since ADR 0033).
