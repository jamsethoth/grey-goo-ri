# Configuration: from three Layers to two sources

Research note for issue #314, 2026-11-08 to 2026-11-09, against main at 0f74178. Every `file:line` is 0f74178's. #122
merged after the evidence was gathered (3b458d9, PR #316): it moved `admitConfiguration` and preflight from
`lib/run.ts` into `lib/run-flows.ts` and changed `bin/gg.ts` and `lib/admission.ts`, so lines cited in those files
have moved on main; the follow-up cites main's lines as they then stand. The probes ran on Node 26.13.0 in temp directories with a temp home; none read or
wrote the owner's `~/.agents/gg/`. Their scripts and output are in the appendix, and each finding names the probe line it
rests on (`P-A` and so on).

The note first records the owner's decision, then the evidence: how the Layers work today (the issue's questions 1 to
6), a survey of how other tools split shared and personal configuration, and the designs considered on the way.

## Decision (owner, 2026-11-09)

The owner set the purpose: configuration exists so that reusable Flows can be defined at the repository level or at the
user level. Layering is not needed, since a user can copy a Flow into their own directory. The decisions below came
out of a grilling session; the numbers are its question numbers.

**Two sources, no merge** (Q16, Q19, Q28, D5)

- gg reads two sources: the repository's `.agents/gg/` and the user's directory, `GG_HOME` (default `~/.agents/gg/`).
  Nothing merges between them. `GG_HOME` also holds, later, `gg work`'s registry of repositories, so one variable moves
  a person's whole setup, as `CLAUDE_CONFIG_DIR` and `CODEX_HOME` do.
- Each source is self-contained: its `gg.json` declares `flows`, `procedures` and `agents`, and the files they name sit
  beside it. A Flow resolves Procedures, Agents, Briefs, Personas and schemas only in its own source. A user adapts a
  repository Flow by copying it, with what it uses, into their directory, by hand for now (Q27).
- `defaults/gg.json` goes, and no default replaces it in code: every setting is required, and its absence fails loudly.

**The repository contract** (Q17, Q30)

- A Run always takes `commands`, `testPaths`, `approvers`, `labelPrefix` and `baseBranch` from the target repository,
  whichever Flow runs, and no Flow can set them. Commands run unsandboxed (ADR 0013), test paths decide Test
  Immutability, approvers decide whose Decision counts, and the labels and the branch are state on the repository's
  GitHub.
- A Flow reaches commands only by name; admission refuses a Flow that names a command the repository does not declare
  (`undeclared-command`).
- `gg init` writes `labelPrefix: "gg"` and `baseBranch`, taken from the repository's default branch; both are required.

**The user's directory** (Q19, Q23)

- Its `gg.json` holds the user's Flows, Procedures and Agents, and the machine settings `maxParallel` and
  `worktreeRoot`, both required; `gg init` creates the file with them when it is missing.
- An Agent's harness, model and effort are declared in the Flow's own source. A user picks their own by copying the
  Flow, or the repository commits them; `gg init --harness claude|codex` writes them into the example.

**Naming and targeting** (Q18, Q20, Q26)

- An unqualified Flow name is the repository's; a user Flow is always `user:<name>`. No name can shadow another.
- gg targets the repository holding the current directory, or the one `--repo <path>` names. `--repo <owner/name>`,
  looked up in the registry, arrives with `gg work`.
- A repository is identified by its GitHub `owner/name`, read once per Run with `gh repo view --json nameWithOwner`.

**Checks** (D7, Q21)

- Unknown keys, keys outside what a source may hold, and missing or bad values are Problems that `gg doctor` and `gg
  run` preflight both list. JSON syntax errors and duplicate keys stay load errors, since nothing can be read past them.
- In `gg doctor`, a user Flow that does not fit the repository's contract is a warning; it is an error in preflight
  when selected. A repository Flow's problems are errors.

**What a Run records and pins** (Q22, Q24, Q25, Q31)

- The Execution Record gains `repository` (`owner/name`) and stores the Flow with its source (`default`,
  `user:strict`). A resume whose Flow is no longer declared keeps its record, as #122's
  rule does (X2, `lib/admission.ts` on main), but loudly (A2): the run reports it as an error naming the Ticket, the
  Flow and both remedies, exits 2, and `gg doctor` lists every such record as an error. #122 skips it with a log line
  and exit 0 (`test/unit/run.resume.test.ts:245-266` on main), so the user learns nothing is wrong only from the log. A
  report already decided still finishes without running a Vertex (`lib/run-flows.ts:131-136` on main,
  `test/unit/run.flows.test.ts:68-98`). Q24 was first put as "holds the Ticket at `needs-human`"; the owner chose to
  keep the record instead, since a hold ends the Execution and a Flow can go missing harmlessly (another `GG_HOME`, a
  rename).
- The remedies (Q32): declare the Flow again, and the next Run resumes; or `gg work abandon <n>` (request 3.5: keep
  the worktree, forget the position), after which `gg run <n> --flow <new>` starts a new Execution at the new Flow's
  entry on the same `ticket/<n>-…` branch, its commits kept (`lib/ticket-worktree.ts:27-60`). Moving an Execution to
  another Flow while keeping its position (`gg work resume <n> --flow <new> --at <vertex>`) goes to the backlog: the
  record's visits, Bounds, Sessions and outputs are keyed by the old Flow's Vertex ids.
- A ticket worktree's path is `worktreeRoot/<owner>/<name>/ticket-<n>`.
- The Config Hash fingerprints a Flow's content, not its source; the record, the run log and `gg doctor` name the
  source. Models stay in the hash, so a model change still changes it.
- A Flow change while a Ticket waits for approval asks the approver again, when Reconciliation lets the Execution
  resume, as today: a changed hash makes the Decision stale. A change that removes the waiting Vertex or changes its
  Procedure holds the Ticket before the digest is read (`lib/reconcile.ts:328-329`, `:376-388`).
- To make the hash depend on the Flow's content alone, the Pinned Configuration takes only the files the selected Flow
  uses. Today it takes every file its Layers declare, used or not (`lib/config.ts:100-114`, `:141`), and #122 pins
  them for each Flow (`lib/run-flows.ts:116` on main), so two sources holding the same Flow but different files
  declared by other Procedures or Agents would hash differently.

**Left out**: a trust record that holds a repository's unsandboxed `commands` until the user approves them once
(Q29), a `gg flow copy` command (Q27), and moving an Execution to another Flow while keeping its position (Q32), all
to the backlog.

**What it changes that is frozen or recorded elsewhere**

- The Execution Record schema gains `repository` and the Flow's source, and a non-string setting may need one new
  Problem code, so the follow-up lands before #23 freezes them.
- ADR 0022 records the decision. It supersedes in part ADR 0014 ("the repository owns its Flow": a user source may now
  hold Flows and Procedures) and decision P2 in `docs/research/user-defined-procedures-decisions.md`. ADR 0013 stands:
  commands stay repository-only.
- The request (3.1's Persona line, 3.3's layering paragraph, 3.5's user directory, 3.9), GLOSSARY **Layer**, AGENTS.md
  and README change in the follow-up.

## How the Layers load today

`loadLayers` (`lib/config.ts:172-185`) reads `defaults/gg.json` from gg's install (`readDefaults`, `:145-151`), then
`~/.agents/gg/gg.json` and the main checkout's `.agents/gg/gg.json` when each exists (`layerPath`, `:12`), and merges
them in that order: objects key by key at every depth, anything else replaced whole (`merge`, `:160-168`). The defaults
and user Layers are refused when they hold `commands`, `testPaths`, `approvers`, `flows` or `procedures`
(`rejectRepoOnly`, `:90-93`, a thrown load error with no Problem code; P-J). Each file name a Layer's own JSON declares
is read beside that Layer and hashed (`loadFiles`, `:121-143`); one name naming two paths is a load error (P-K).
`bin/gg.ts:40` and `:58` call it for `gg run` and `gg doctor` with the main checkout of the current directory's
repository (`bin/gg.ts:35`, `:55`).

On this machine the owner has no user Layer: `ls ~/.agents/gg/` reports "No such file or directory" (2026-11-08). So
today the user Layer is used only by tests (each with a temp home) and by the advice gg prints.

## 1. Each key gg reads from the merged configuration

| Key | Set in practice by | Read at | Validated | Belongs to |
| --- | --- | --- | --- | --- |
| `maxParallel` | defaults (`defaults/gg.json:2`, 2) | `lib/run.ts:315` (`mapConcurrently`, `:37-49`) | no (P-G, P-H) | the machine |
| `baseBranch` | defaults (`:3`, `main`) | `lib/admission.ts:226` (the record's `base`), `:285` (worktree admission), `:361` (the Run context's `base`: a Brief's `baseBranch` and diff, `lib/agent-action.ts:121-130`; the PR's base, `lib/effect-actions.ts:225`) | no (P-H2) | the repository |
| `worktreeRoot` | defaults (`:4`, `~/worktrees`) | `lib/admission.ts:139` (a new Execution's path only; a resumed one keeps its record's, `:141`) | no | the machine |
| `labelPrefix` | defaults (`:5`, `gg`) | `lib/admission.ts:121`, `:160`, `:277`, `:313`, `:362`; `lib/run.ts:215`, `:218`, `:233`, `:245`, `:347`; `lib/validate/flows.ts:340-344` (the Await and Decide Labels in the Resolved Flow) | no (P-H2: `a:b` passes) | the repository: its labels are on the repository's issues |
| `agents` | repository (`persona`, `access`); user (`harness`, `model`, `effort`, `examples/*.json`) | `lib/validate/index.ts:37-49`, `lib/validate/flows.ts:201`, `:228-245` | yes | split: see 3 |
| `flows`, `procedures` | repository only (P2) | `lib/validate/index.ts:32`, `:58`, `:101-131`; `lib/validate/flows.ts:326`, `:352` | yes | the repository |
| `commands` | repository only (ADR 0013) | `lib/run.ts:192`, `lib/validate/index.ts:56`; preflight `lib/config.ts:280-304` | yes | the repository |
| `testPaths` | repository only (P4) | `lib/run.ts:199`, `:308`; preflight `lib/config.ts:246-265` | yes | the repository |
| `approvers` | repository only (#119) | `lib/run.ts:200`, `lib/admission.ts:363`; preflight `lib/config.ts:268-277` | yes | the repository |
| `harnesses` | no Layer, example or fixture configuration; the hash test passes it directly (`test/unit/config.test.ts:67`) | `lib/run.ts:196` (pinned as `{}`) | no | not yet designed (request 3.2's `harnesses.codex.injectHooks`) |
| `files` | gg itself, from `loadFiles` | `lib/admission.ts:359`, `lib/run.ts:185-186`, `lib/doctor.ts:200-201` | n/a | gg |

Findings this table rests on:

- No Run setting is validated. The validator checks `procedures`, `agents`, `flows` and every `null` that survives the
  merge (`lib/validate/index.ts:92-131`), and preflight the three repository-only keys (`lib/config.ts:307-314`). A
  `maxParallel` of `"two"`, `0` or `-1` makes `mapConcurrently` start no worker, so `gg run` of an Epic runs no Ticket
  and reports nothing (P-H: `Tickets run: []`); `1.5` runs them (P-H). A misspelt key such as `maxParalel` is ignored
  in silence (P-G). A `labelPrefix` holding `:` passes (P-H2) though every label splits on `:` (`lib/labels.ts:38`).
- `labels.DEFAULT_PREFIX` (`lib/labels.ts:16`) repeats the defaults Layer's `"gg"`, and 9 other modules use it as a
  default or fallback (`lib/approval-action.ts:26`, `lib/github.ts:86`, `lib/interpreter.ts:100`,
  `lib/reconcile.ts:201`, ...), because the Run context's `labelPrefix` is optional (`lib/run-context.ts:134`).
- On resume, `baseBranch` comes from two places: the PR and the Brief's diff read the current configuration
  (`lib/admission.ts:361`), the Terminal report's diff stats read the record's `base` (`lib/terminal-report.ts:269`).
  A `baseBranch` changed between Runs splits them. Read from the code; not probed. Under the decision `baseBranch`
  belongs to the repository contract, so only an edit to the repository's `gg.json`, committed or not, can change it
  (the repository Layer is read from the main checkout's working tree, ADR 0013).

## 2. The defaults Layer

The defaults Layer holds four values that never vary by machine or repository (`defaults/gg.json:1-6`). Removing it
removes `DEFAULTS_DIRECTORY` (`lib/config.ts:10`), `readDefaults` and `loadDefaults` (`:145-157`), the `defaults/`
directory, and in `test/unit/config.test.ts` the cases `loadDefaults reads defaults/gg.json` (`:28-30`), `the shipped
defaults declare no agents, flows or procedures` (`:256-264`), the defaults assertion of the case at `:276-285`, and the
three copied-install cases `a <key> key in the defaults Layer is a load error naming the file` (`:317-332`).
`copyInstall` (`:97-103`) stops copying `defaults`; the install-path case that also uses it (`:122`) keeps working.

It changes neither the Config Hash nor the Pinned Configuration. Their inputs are the Resolved Flow, the Layer files,
`harnesses`, `launchProfile`, `commands`, `testPaths` and `approvers` (`lib/config.ts:211-233`, built at
`lib/run.ts:193-201`). The defaults Layer holds none of them and names no file. `labelPrefix` reaches the hash only
through an approval Vertex's labels (P-F), and `gg init` writes the same `gg`. No Problem code names the defaults load
error, which is a thrown `Error`, and `gg doctor` prints none of the four settings (`lib/doctor.ts:194-219`).

The owner chose to make all four required rather than move their defaults into code (D5): a setting gg cannot run
without is stated where it belongs, as `commands.test` and `testPaths` already are (P4), and its absence is a
`required-key-missing` Problem in doctor and preflight. Today a missing `worktreeRoot` would throw at
`lib/admission.ts:139`, and a missing `maxParallel` would run no Ticket (P-H's path), so the check must run in both
before anything reads them.

## 3. The user Layer's reach

A home-directory Layer applies to every repository the person runs gg in, and it may set any key outside the
repository-only list. The probes show:

- **Harness, model and effort** merge field by field, and the repository wins (P-M): a repository that sets the
  reviewer's `harness` and `model` but not `effort` runs it with the person's `effort`, written for another harness
  (`codex` with `gpt-6.1-sol` and the Claude example's `"effort": "high"`).
- **Files.** A user Layer may declare a Persona, and it fails to load in every repository that declares a different
  file under the same name (P-K). A file it declares is loaded and hashed even when the repository's own name wins the
  merge (P-K2: the merged Persona is `reviewer.md`, `my-reviewer.md` is still in `files`, and the hash moves from
  `e5e742878bf9` to `addb7302d813`).
- **`labelPrefix` and `baseBranch`** describe the repository. A person's `labelPrefix` change strands every Ticket gg
  labelled before it: `labelsFor('me')` parses none of `gg:await:approve`, `gg:state:in-progress`,
  `gg:decide:approve:approved` (P-prefix). A repository that sets them wins (P-N); one that relies on the default
  inherits the person's (P-E).
- **`worktreeRoot`, `maxParallel`** describe the machine. A resumed Execution keeps its recorded worktree
  (`lib/admission.ts:141`), so changing `worktreeRoot` is safe between Runs.

Under the decision the cross-source reach goes: nothing merges, a user's file cannot collide with a repository's, the
user's directory declares whole Flows that run only when selected by `user:<name>`, and the repository contract is
read from the repository alone. The machine settings still reach every repository by design: the user's
`maxParallel` and `worktreeRoot` apply to every Run on the machine, whichever Flow runs.

## 4. Merge rules

| Rule | Where | Under the decision |
| --- | --- | --- |
| Objects merge key by key, arrays replace whole | `lib/config.ts:160-168` | gone: nothing merges |
| No deletion | request 3.3 (`node-harness-dag.md:254`) | gone with the merge |
| `null` is never a value | `lib/validate/index.ts:76-90`, #298 | stays. Today only a `null` that survives the merge is reported: a user `labelPrefix: null` under a repository `"gg"` merges to `"gg"` with no error (P-null). With no merge, every `null` in either source is seen |
| One name names one file | `lib/config.ts:121-143` | gone: each source's files resolve beside its own `gg.json`, and names never cross sources |
| Repository-only keys | `lib/config.ts:90-93` | replaced by the repository contract and a closed key list per source |

## 5. What a Run pins

The Config Hash covers the Resolved Flow, every Layer file by name, `harnesses`, `launchProfile` (always `null` until
the Claude Harness lands, `lib/run.ts:197`), `commands`, `testPaths` and `approvers` (`lib/config.ts:223-233`). The
Resolved Flow carries each Vertex's merged Agent, harness, model and effort included (`lib/validate/flows.ts:245`), and
an approval Vertex's labels with their prefix (`:340-344`). So:

- A harness or model change changes the Config Hash (P-B `e5e742878bf9`, P-C `ee68cc5a0a35`, P-D `1914dc565c57`).
  That is the hash's job: request 3.7 (`node-harness-dag.md:602`) and ADR 0002 make it what tells two configurations
  apart in stats and evaluations. Kept (Q25).
- A person's unused file changes it too (P-K2), which serves nothing. Under the decision a file from the other source
  can no longer do so, but a file the selected Flow's own source declares for another Flow still would, unless only the
  selected Flow's files are pinned (see the decision's last bullet on pinning).
- `labelPrefix` changes it only when the Flow has an approval Vertex (P-F: `7af32a3fcde0` and `f87f739a53fb`); the
  other three Run settings never do (P-E: the hash stays `e5e742878bf9`).
- The record keeps the hash of the Run that created it (`lib/admission.ts:222`), but an Approval Request's digest takes
  the current Run's (`lib/admission.ts:364`, `lib/approval-action.ts:43`). A model change between the Run that asked
  and the Run that reads the Decision makes the digest differ (P-L: `f48fbad35c92` and `33c0554beeaf`, digests of the
  full hashes), so the Decision reads `stale` (`lib/approval.ts:148`) and gg retires the request and asks again
  (`lib/approval-action.ts:211-214`). Kept (Q31).

The Pinned Configuration's shape does not change under the decision: its `files` become the files the selected Flow
uses, from its own source, and the source itself stays out of the hash (Q25).

## 6. Open requests that assume Layers

- **"Eval variants are config layers and may change flow structure"** (request 3.9, `node-harness-dag.md:645`). P2
  already forbade it. Decided: a variant is a named Flow, picked with `--flow` (#122), in either source (D6).
- **The migration table** (`lib/config.ts:171`, "slice 5 brings the migration table"; request 3.9,
  `node-harness-dag.md:641-645`). Today any unknown top-level key is ignored (P-G). The closed key list per source (D7)
  gives the load-time Problem, and the migration table becomes the message for ff's known keys.
- **gg init's and preflight's advice** to merge an example into the user Layer (`lib/doctor.ts:230-231`,
  `lib/run.ts:144-150`, asserted at `test/unit/run.test.ts:319` and `test/e2e/gg.test.ts:175`). It is replaced: `gg init
  --harness` writes the harness into the example, and creates the user's `gg.json` with the machine settings.
- **Keys request 3.9 carries over by name** (`node-harness-dag.md:643-645`): `planApproval`, `stuckAfterHours`,
  `allowNetwork` and `style` describe the repository's process, so each lands in the repository contract or a Flow;
  `apiPrices` and `contextBudget.byModel` describe the person, so they land in the user's `gg.json`.
- **The registry** that `gg work` reads lives in the user's directory (`node-harness-dag.md:526`), so `GG_HOME` moves it
  with the Flows.

## Multiple repositories

- gg targets the repository holding the current directory (`bin/gg.ts:35`, `:50`, `:55`); there is no flag to point it
  elsewhere.
- A ticket worktree's path is `worktreeRoot/<main checkout's folder name>/ticket-<n>` (`lib/git.ts:16-17`, the name
  from `lib/git.ts:93`). Two repositories whose checkouts share a folder name would put Ticket 5 in the same directory.
- Each repository's Execution Records live in its own State Database, `<git common dir>/gg/gg.db`
  (`lib/admission.ts:120`), so two repositories' Flows of one name never share a table. A record names only its
  `commonDir`, a local path, and its Flow's name (`lib/record.ts:95-125`): once it leaves that database, nothing in it
  says which repository it belongs to. gg does not read the GitHub `owner/name` today; `lib/github.ts` never asks for
  it, and `gh` infers the repository from the current directory.

## How other tools split shared and personal configuration

A survey of primary documentation on 2026-11-09. The pages were read through a fetch tool that summarises, so the
statements below are paraphrases, not quotes; recheck the wording at the URL before quoting any of them.

- **git** (https://git-scm.com/docs/git-config): system < global < local < worktree, last value wins. The local file is
  inside `.git`, never tracked. Some keys, `safe.directory` among them, count only in protected configuration (system,
  global, command line), so a repository cannot set them. `GIT_CONFIG_GLOBAL` relocates the global file alone.
- **Claude Code** (https://code.claude.com/docs/en/settings, https://code.claude.com/docs/en/env-vars): user < shared
  project < local project (`.claude/settings.local.json`, untracked; Claude Code adds it to git's global excludes when
  it first writes the file, and one created by hand needs ignoring separately) < command line <
  managed. Some permission modes do not apply from project or local settings, and project allow rules wait for the
  workspace trust dialog, whose answer is kept in the home directory keyed by the main checkout's root.
  `CLAUDE_CONFIG_DIR` moves settings, history and plugins together, documented for running several accounts side by
  side.
- **Codex CLI** (https://learn.chatgpt.com/docs/config-file/config-basic,
  https://learn.chatgpt.com/docs/config-file/config-advanced): user < profile < project `.codex/config.toml` (trusted
  projects only) < command line. A project file cannot set a listed set of keys, those that redirect credentials,
  select profiles, or run notification and telemetry commands, though a trusted project may still define hooks.
  `CODEX_HOME` holds config, auth, history and logs.
- **VS Code** (https://code.visualstudio.com/docs/configure/settings): workspace settings override user settings, but
  some settings (for example `git.path`) may be set only in user settings, and Restricted Mode limits an untrusted
  workspace.
- **npm** (https://docs.npmjs.com/cli/v11/configuring-npm/npmrc) and **Cargo**
  (https://doc.rust-lang.org/cargo/reference/config.html): the project file overrides the user's. Neither reserves
  keys to a layer for security, though npm's `userconfig` cannot be set from the global config
  (https://docs.npmjs.com/cli/v11/using-npm/config/). `CARGO_HOME` moves config, credentials and caches.
- **mise** (https://mise.jdx.dev/configuration.html): `mise.local.toml` beside `mise.toml` for personal overrides, kept
  out of version control by the user; config that runs code is gated by `mise trust`, kept in a state directory,
  though some commands can grant it automatically (https://mise.jdx.dev/cli/trust.html).
- **direnv** (https://direnv.net/man/direnv.1.html): `.envrc` loads after `direnv allow`, or by a whitelist in its
  own config (https://direnv.net/man/direnv.toml.1.html).

None of the surveyed tools documents several people sharing one checkout; each assumes one OS user per home directory.
Claude Code and Codex run a second identity by moving that directory; VS Code can also switch settings profiles for one
folder with `--profile` (https://code.visualstudio.com/docs/configure/profiles). Most let the repository override the
person. Several give a key to one layer only. Five have a trust mechanism for a repository's code-running
configuration, though not every path through each is gated: mise and direnv can grant trust implicitly, and Claude
Code's headless sessions are not held by the interactive trust dialog. gg's decision
takes the per-directory identity (`GG_HOME`) and a key list per source, refuses merging altogether, and leaves the trust
record to the backlog.

## Designs considered before the decision

Before the owner reframed the question, the note set out four designs over the Layers, each keeping `flows`,
`procedures`, `commands`, `testPaths` and `approvers` repository-only:

- **A. Three Layers, tightened**: keep `defaults/gg.json`; an allow-list for the user Layer (an Agent's harness,
  model and effort, `worktreeRoot`, `maxParallel`).
- **B. Two Layers over settings in code**: as A without `defaults/gg.json`; `labelPrefix` and `baseBranch`
  repository-only. Recommended then.
- **C. A repository Layer plus an untracked `.agents/gg/local.json`** with A's allow-list, overriding the repository.
- **D. The repository Layer alone**, the Agents' harness, model and effort committed.

The Codex review of that draft (PR #315, round 1) found that B also stops accepting a user Layer's `baseBranch` and
`labelPrefix` (`test/unit/config.test.ts:276-283` sets one), that A, C and D's test and document costs were
understated, and that under each allow-list P-M's mixed Agent remains. The decision goes past all four: it keeps D's
single source per Flow and B's user directory, and drops the merge that every Layer design needed.

## Appendix: probes

Run from the job's temp directory, outside the worktree, on 2026-11-08 and 2026-11-09:

```
node probe-layers.ts C:/dev/worktrees/grey-goo-ri/314-config-layers
node probe-prefix.ts C:/dev/worktrees/grey-goo-ri/314-config-layers
node probe-null.ts C:/dev/worktrees/grey-goo-ri/314-config-layers
```

`probe-layers.ts` copies `test/fixtures/example/` into a temp repository's `.agents/gg/` with `commands.test` added,
writes a user Layer into a temp home for each case, calls `config.loadLayers(repo, home)`, runs the validator with the
shipped Harnesses as `lib/run.ts:183-187` does, and builds the Pinned Configuration and its hash as `lib/run.ts:193-202`
does (first 12 hex digits shown). It skips preflight (`lib/run.ts:191`), so no error means the validator passed, not
that a Run would be admitted. Cases: A no user Layer; B and C `examples/claude.json` and `examples/codex.json`; D B
with the reviewer's model `opus`; E B plus the four Run settings; F an approval Vertex between `reviewer` and
`publish`, under prefixes `gg` and `me`; G a misspelt `maxParalel`; H `run.mapConcurrently` over three Tickets with bad
limits; H2 bad types for three settings; I a `null` prefix; J each repository-only key in the user Layer; K the user
Layer declaring `reviewer.md` beside itself; K2 the user Layer naming its own `my-reviewer.md`; L `approval.digest`
over B's and D's full hashes; M the repository setting the reviewer's harness and model; N both Layers setting
`labelPrefix` and `baseBranch`. `probe-prefix.ts` parses three `gg:` labels with `labels.labelsFor('me')` and
`labelsFor('gg')`. `probe-null.ts` loads a user Layer `{"labelPrefix":null}` under a repository Layer
`{"labelPrefix":"gg"}`.

Output, in the order printed (temp paths shown as `<tmp>`):

```
A no user Layer: {"errors":["harness-unset@agents.implementer","harness-unset@agents.reviewer","harness-unset@agents.senior"],"run":{"maxParallel":2,"baseBranch":"main","worktreeRoot":"~/worktrees","labelPrefix":"gg"}}
B claude example user Layer: {"errors":[],"hash":"e5e742878bf9"}
C codex example user Layer: {"errors":[],"hash":"ee68cc5a0a35"}
D claude, reviewer model sonnet -> opus: {"errors":[],"hash":"1914dc565c57"}
E claude + the four Run settings in the user Layer: {"errors":[],"hash":"e5e742878bf9","run":{"maxParallel":9,"baseBranch":"dev","worktreeRoot":"/elsewhere","labelPrefix":"me"}}
F approval Vertex, prefix gg: {"errors":[],"hash":"7af32a3fcde0","labels":{"await":"gg:await:approve","decide":["gg:decide:approve:approved","gg:decide:approve:rejected"]}}
F approval Vertex, prefix me: {"errors":[],"hash":"f87f739a53fb","labels":{"await":"me:await:approve","decide":["me:decide:approve:approved","me:decide:approve:rejected"]}}
G typo maxParalel:7 in user Layer: {"errors":[],"maxParallel":2,"hash":"e5e742878bf9"}
H mapConcurrently with maxParallel "two": Tickets run: []
H mapConcurrently with maxParallel 0: Tickets run: []
H mapConcurrently with maxParallel -1: Tickets run: []
H mapConcurrently with maxParallel 1.5: Tickets run: [1,2,3]
H2 maxParallel "two", labelPrefix "a:b", baseBranch 7: validator errors: []
I labelPrefix null in user Layer: ["null-value@labelPrefix"]
J commands in user Layer: "THROWS <tmp>\\j-commands\\home\\.agents\\gg\\gg.json: commands may be set only in a repository Layer"
J testPaths in user Layer: "THROWS <tmp>\\j-testPaths\\home\\.agents\\gg\\gg.json: testPaths may be set only in a repository Layer"
J approvers in user Layer: "THROWS <tmp>\\j-approvers\\home\\.agents\\gg\\gg.json: approvers may be set only in a repository Layer"
J flows in user Layer: "THROWS <tmp>\\j-flows\\home\\.agents\\gg\\gg.json: flows may be set only in a repository Layer"
J procedures in user Layer: "THROWS <tmp>\\j-procedures\\home\\.agents\\gg\\gg.json: procedures may be set only in a repository Layer"
K user Layer re-declares persona reviewer.md beside itself: "THROWS file \"reviewer.md\" is declared by <tmp>\\k\\home\\.agents\\gg\\gg.json and by <tmp>\\plain\\repo\\.agents\\gg\\gg.json, each beside its own Layer; give one of them another name"
K2 user Layer names its own persona file: {"errors":[],"hash":"addb7302d813","fileFromHome":true}
L Approval Digest, same head and body, hash B vs D: ["f48fbad35c92","33c0554beeaf"]
K2 merged reviewer persona, and files loaded: {"persona":"reviewer.md","files":["my-reviewer.md","reviewer.md","review.md","review-comment.md"]}
M repo sets reviewer harness codex, user sets claude: merged: {"reviewer":{"harness":"codex","model":"gpt-6.1-sol","effort":"high","persona":"reviewer.md","access":"read-only"},"resolved":{"harness":"codex","model":"gpt-6.1-sol","effort":"high","persona":"reviewer.md","access":"read-only"}}
N repo sets labelPrefix/baseBranch, user too: merged: {"maxParallel":2,"baseBranch":"trunk","worktreeRoot":"~/worktrees","labelPrefix":"repo"}
prefix me reads gg:await:approve: null; prefix gg: {"family":"await","vertex":"approve"}
prefix me reads gg:state:in-progress: null; prefix gg: {"family":"state","name":"in-progress"}
prefix me reads gg:decide:approve:approved: null; prefix gg: {"family":"decide","vertex":"approve","outcome":"approved"}
user null, repo "gg": merged labelPrefix = "gg"
```

The three scripts, as run:

```ts
// Probes for #314: the configuration Layers as main 0f74178 loads them. Temp repo and temp home only.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]; // the worktree
const lib = (name: string) => import(pathToFileURL(join(root, 'lib', name)).href);
const config = await lib('config.ts');
const validator = await lib('validate/index.ts');
const run = await lib('run.ts');
const approval = await lib('approval.ts');
const { HARNESSES: harnesses } = await lib('harnesses/shipped.ts');
const example = join(root, 'test', 'fixtures', 'example');
const scratch = mkdtempSync(join(tmpdir(), 'gg-314-'));

// A repository Layer: the example gg init writes, with a test command, edited by `edit`.
function repoLayer(name: string, edit: (layer: any) => void = () => {}) {
  const repo = join(scratch, name, 'repo');
  const directory = join(repo, '.agents', 'gg');
  cpSync(example, directory, { recursive: true });
  rmSync(join(directory, 'doctor.txt'));
  const layer = JSON.parse(readFileSync(join(directory, 'gg.json'), 'utf8'));
  layer.commands = { test: 'node -e 0' };
  edit(layer);
  writeFileSync(join(directory, 'gg.json'), JSON.stringify(layer));
  return repo;
}
function home(name: string, layer: unknown, files: Record<string, string> = {}) {
  const directory = join(scratch, name, 'home');
  if (layer === undefined) return directory;
  mkdirSync(join(directory, '.agents', 'gg'), { recursive: true });
  writeFileSync(join(directory, '.agents', 'gg', 'gg.json'), JSON.stringify(layer));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, '.agents', 'gg', file), text);
  return directory;
}
const exampleUser = (harness: string) => JSON.parse(readFileSync(join(root, 'examples', `${harness}.json`), 'utf8'));

// What gg run's admitConfiguration pins (lib/run.ts:182-203), and its hash.
function admit(repo: string, homeDirectory: string) {
  const layers = config.loadLayers(repo, homeDirectory);
  const { flows, errors } = validator.validate(layers, {
    harnesses,
    readSchema: (name: string) => JSON.parse(config.layerFile(layers.files, name)),
    readTemplate: (name: string) => config.layerFile(layers.files, name),
  });
  const json = flows.default;
  const pinned = {
    flow: json,
    files: layers.files,
    harnesses: layers.harnesses ?? {},
    launchProfile: null,
    commands: layers.commands ?? {},
    testPaths: layers.testPaths,
    approvers: layers.approvers,
  };
  const run = { maxParallel: layers.maxParallel, baseBranch: layers.baseBranch, worktreeRoot: layers.worktreeRoot, labelPrefix: layers.labelPrefix };
  const fullHash = config.configHash(pinned);
  return { layers, json, errors: errors.map((e: any) => `${e.code}@${e.at}`), hash: fullHash.slice(0, 12), fullHash, run };
}
const show = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);
const attempt = (label: string, body: () => unknown) => {
  try {
    show(label, body());
  } catch (err) {
    show(label, `THROWS ${(err as Error).message.replaceAll(scratch, '<tmp>')}`);
  }
};

const plain = repoLayer('plain');
attempt('A no user Layer', () => { const r = admit(plain, home('a', undefined)); return { errors: r.errors, run: r.run }; });
const claude = admit(plain, home('b', exampleUser('claude')));
show('B claude example user Layer', { errors: claude.errors, hash: claude.hash });
const codex = admit(plain, home('c', exampleUser('codex')));
show('C codex example user Layer', { errors: codex.errors, hash: codex.hash });
const sonnetToOpus = exampleUser('claude');
sonnetToOpus.agents.reviewer.model = 'opus';
const opus = admit(plain, home('d', sonnetToOpus));
show('D claude, reviewer model sonnet -> opus', { errors: opus.errors, hash: opus.hash });
const settings = { ...exampleUser('claude'), labelPrefix: 'me', baseBranch: 'dev', worktreeRoot: '/elsewhere', maxParallel: 9 };
const personal = admit(plain, home('e', settings));
show('E claude + the four Run settings in the user Layer', { errors: personal.errors, hash: personal.hash, run: personal.run });

// An approval Vertex between reviewer and publish, so the Resolved Flow carries Await and Decide Labels.
const withApproval = repoLayer('approval', (layer) => {
  layer.procedures.approval = { actions: [{ id: 'ask', do: 'await-approval', decisions: ['approved', 'rejected'] }] };
  layer.flows.default.ticket.vertices.reviewer.route.ok = 'approve';
  layer.flows.default.ticket.vertices.approve = { procedure: 'approval', route: { approved: 'publish', rejected: { end: 'needs-human' } } };
});
const gg = admit(withApproval, home('f1', exampleUser('claude')));
const me = admit(withApproval, home('f2', { ...exampleUser('claude'), labelPrefix: 'me' }));
show('F approval Vertex, prefix gg', { errors: gg.errors, hash: gg.hash, labels: gg.json.ticket.vertices.approve?.approvalLabels });
show('F approval Vertex, prefix me', { errors: me.errors, hash: me.hash, labels: me.json.ticket.vertices.approve?.approvalLabels });

const typo = admit(plain, home('g', { ...exampleUser('claude'), maxParalel: 7 }));
show('G typo maxParalel:7 in user Layer', { errors: typo.errors, maxParallel: typo.run.maxParallel, hash: typo.hash });
for (const bad of ['two', 0, -1, 1.5]) {
  const started: number[] = [];
  await run.mapConcurrently([1, 2, 3], bad, async (ticket: number) => started.push(ticket));
  show(`H mapConcurrently with maxParallel ${JSON.stringify(bad)}: Tickets run`, started);
}
const badSettings = admit(plain, home('h2', { ...exampleUser('claude'), maxParallel: 'two', labelPrefix: 'a:b', baseBranch: 7 }));
show('H2 maxParallel "two", labelPrefix "a:b", baseBranch 7: validator errors', badSettings.errors);
attempt('I labelPrefix null in user Layer', () => admit(plain, home('i', { ...exampleUser('claude'), labelPrefix: null })).errors);
for (const key of ['commands', 'testPaths', 'approvers', 'flows', 'procedures'])
  attempt(`J ${key} in user Layer`, () => admit(plain, home(`j-${key}`, { ...exampleUser('claude'), [key]: {} })).errors);
const personaUser = exampleUser('claude');
personaUser.agents.reviewer.persona = 'reviewer.md';
attempt('K user Layer re-declares persona reviewer.md beside itself', () =>
  admit(plain, home('k', personaUser, { 'reviewer.md': '# mine\n' })).errors,
);
const ownPersona = exampleUser('claude');
ownPersona.agents.reviewer.persona = 'my-reviewer.md';
attempt('K2 user Layer names its own persona file', () => {
  const r = admit(plain, home('k2', ownPersona, { 'my-reviewer.md': '# mine\n' }));
  return { errors: r.errors, hash: r.hash, fileFromHome: Object.hasOwn(r.layers.files, 'my-reviewer.md') };
});
// The full hash, as lib/approval-action.ts:43 passes it; only the printed digest is cut.
const digest = (hash: string) => approval.digest({ head: 'a'.repeat(40), body: 'ticket body', configHash: hash }).slice(0, 12);
show('L Approval Digest, same head and body, hash B vs D', [digest(claude.fullHash), digest(opus.fullHash)]);

attempt('K2 merged reviewer persona, and files loaded', () => {
  const r = admit(plain, home('k3', ownPersona, { 'my-reviewer.md': '# mine\n' }));
  return { persona: r.layers.agents.reviewer.persona, files: Object.keys(r.layers.files).filter((f) => f.endsWith('.md') && /review/.test(f)) };
});
const repoHarness = repoLayer('repo-harness', (layer) => { layer.agents.reviewer.harness = 'codex'; layer.agents.reviewer.model = 'gpt-6.1-sol'; });
const overridden = admit(repoHarness, home('m', exampleUser('claude')));
show('M repo sets reviewer harness codex, user sets claude: merged', { reviewer: overridden.layers.agents.reviewer, resolved: overridden.json.ticket.vertices.reviewer.agent });
const repoSettings = repoLayer('repo-settings', (layer) => Object.assign(layer, { labelPrefix: 'repo', baseBranch: 'trunk' }));
const both = admit(repoSettings, home('n', { ...exampleUser('claude'), labelPrefix: 'me', baseBranch: 'dev' }));
show('N repo sets labelPrefix/baseBranch, user too: merged', both.run);
rmSync(scratch, { recursive: true, force: true });
```

```ts
import { pathToFileURL } from 'node:url';
const labels = await import(pathToFileURL(process.argv[2] + '/lib/labels.ts').href);
for (const label of ['gg:await:approve', 'gg:state:in-progress', 'gg:decide:approve:approved'])
  console.log(`prefix me reads ${label}: ${JSON.stringify(labels.labelsFor('me').parse(label))}; prefix gg: ${JSON.stringify(labels.labelsFor('gg').parse(label))}`);
```

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const config = await import(pathToFileURL(process.argv[2] + '/lib/config.ts').href);
const scratch = mkdtempSync(join(tmpdir(), 'gg-314-null-'));
for (const [name, text] of [['home', '{"labelPrefix":null}'], ['repo', '{"labelPrefix":"gg"}']]) {
  mkdirSync(join(scratch, name, '.agents', 'gg'), { recursive: true });
  writeFileSync(join(scratch, name, '.agents', 'gg', 'gg.json'), text);
}
const merged = config.loadLayers(join(scratch, 'repo'), join(scratch, 'home'));
console.log('user null, repo "gg": merged labelPrefix =', JSON.stringify(merged.labelPrefix));
```
