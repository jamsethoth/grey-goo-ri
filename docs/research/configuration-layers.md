# Configuration Layers: what each one brings, and how many gg needs

Research note, 2026-11-08, for issue #314, against main at 0f74178. Every `file:line` is main's. #122 (in flight)
changes `bin/gg.ts`, `lib/run.ts` (`admitConfiguration`) and `lib/admission.ts`, so its merge may move the lines cited
in those three files. The probes ran on Node 26.13.0 in temp directories with a temp home; none read or wrote the owner's
`~/.agents/gg/`. Their script and full output are in the appendix; each answer names the probe line it rests on (`P-A`
and so on).

## How the Layers load today

`loadLayers` (`lib/config.ts:172-185`) reads `defaults/gg.json` from gg's install (`readDefaults`, `:145-151`), then
`~/.agents/gg/gg.json` and the main checkout's `.agents/gg/gg.json` when each exists (`layerPath`, `:12`), and merges
them in that order: objects key by key at every depth, anything else replaced whole (`merge`, `:160-168`). The defaults
and user Layers are refused when they hold `commands`, `testPaths`, `approvers`, `flows` or `procedures`
(`rejectRepoOnly`, `:90-93`, a thrown load error with no Problem code; P-J). Each file name a Layer's own JSON declares
is read beside that Layer and hashed (`loadFiles`, `:121-143`); one name naming two paths is a load error (P-K).
`bin/gg.ts:40` and `:58` call it for `gg run` and `gg doctor` with the main checkout's root.

On this machine the owner has no user Layer: `ls ~/.agents/gg/` reports "No such file or directory" (2026-11-08). So
today the user Layer is used only by tests (each with a temp home) and by the advice gg prints.

## 1. Each key gg reads from the merged configuration

| Key | Set in practice by | Read at | Validated | Belongs to |
| --- | --- | --- | --- | --- |
| `maxParallel` | defaults (`defaults/gg.json:2`, 2) | `lib/run.ts:315` (`mapConcurrently`, `:37-49`) | no (P-G, P-H) | the machine: how many Tickets it runs at once |
| `baseBranch` | defaults (`:3`, `main`) | `lib/admission.ts:226` (the record's `base`), `:285` (worktree admission), `:361` (the Run context's `base`: a Brief's `baseBranch` and diff, `lib/agent-action.ts:121-130`; the PR's base, `lib/effect-actions.ts:225`) | no (P-H2) | the repository |
| `worktreeRoot` | defaults (`:4`, `~/worktrees`) | `lib/admission.ts:139` (a new Execution's path only; a resumed one keeps its record's, `:141`) | no | the machine |
| `labelPrefix` | defaults (`:5`, `gg`) | `lib/admission.ts:121`, `:160`, `:277`, `:313`, `:362`; `lib/run.ts:215`, `:218`, `:233`, `:245`, `:347`; `lib/validate/flows.ts:340-344` (the Await and Decide Labels in the Resolved Flow) | no (P-H2: `a:b` passes) | the repository: its labels are on the repository's issues |
| `agents` | repository (`persona`, `access`); user (`harness`, `model`, `effort`, `examples/*.json`) | `lib/validate/index.ts:37-49`, `lib/validate/flows.ts:201`, `:228-252` | yes | split: see 3 |
| `flows`, `procedures` | repository only (P2) | `lib/validate/index.ts:32`, `:58`, `:101-131`; `lib/validate/flows.ts:326`, `:352` | yes | the repository |
| `commands` | repository only (ADR 0013) | `lib/run.ts:192`, `lib/validate/index.ts:56`; preflight `lib/config.ts:280-304` | yes | the repository |
| `testPaths` | repository only (P4) | `lib/run.ts:199`, `:308`; preflight `lib/config.ts:246-265` | yes | the repository |
| `approvers` | repository only (#119) | `lib/run.ts:200`, `lib/admission.ts:363`; preflight `lib/config.ts:268-277` | yes | the repository |
| `harnesses` | nobody: no Layer, example or test sets it | `lib/run.ts:196` (pinned as `{}`) | no | not yet designed (request 3.2's `harnesses.codex.injectHooks`) |
| `files` | gg itself, from `loadFiles` | `lib/admission.ts:359`, `lib/run.ts:185-186`, `lib/doctor.ts:200-201` | n/a | gg |

Findings this table rests on:

- No Run setting is validated. The validator checks `procedures`, `agents` and `flows` and every `null`
  (`lib/validate/index.ts:92-131`), and preflight the three repository-only keys (`lib/config.ts:307-314`). A
  `maxParallel` of `"two"`, `0` or `-1` makes `mapConcurrently` start no worker, so `gg run` of an Epic runs no Ticket
  and reports nothing (P-H: `Tickets run: []`); `1.5` runs them (P-H). A misspelt key such as `maxParalel` is ignored
  in silence (P-G). A `labelPrefix` holding `:` passes (P-H2) though every label splits on `:` (`lib/labels.ts:58`).
- `labels.DEFAULT_PREFIX` (`lib/labels.ts:36`) repeats the defaults Layer's `"gg"`, and 9 other modules use it as a default or fallback
  (`lib/approval-action.ts:26`, `lib/github.ts:86`, `lib/interpreter.ts:100`, `lib/reconcile.ts:201`, ...),
  because the Run context's `labelPrefix` is optional (`lib/run-context.ts:134`).
- On resume, `baseBranch` comes from two places: the PR and the Brief's diff read the current configuration
  (`lib/admission.ts:361`), the Terminal report's diff stats read the record's `base` (`lib/terminal-report.ts:269`).
  A `baseBranch` changed between Runs splits them. Read from the code; not probed.

## 2. The defaults Layer as constants in code

The defaults Layer holds four values that never vary by machine or repository (`defaults/gg.json:1-6`). Turning them
into one constant in `lib/config.ts`, under the user and repository Layers, removes:

- `DEFAULTS_DIRECTORY` (`lib/config.ts:10`), `readDefaults` and `loadDefaults` (`:145-157`), and the `defaults/`
  directory; `rejectRepoOnly`'s defaults call (`:148`).
- In `test/unit/config.test.ts`: `loadDefaults reads defaults/gg.json` (`:28-30`), `the shipped defaults declare no
  agents, flows or procedures` (`:256-264`), the `commands` assertion at `:284`, and the three copied-install cases `a
  <key> key in the defaults Layer is a load error naming the file` (`:317-332`). `copyInstall` (`:97-103`) stops
  copying `defaults`; the install-path case that also uses it (`:122`) keeps working.
- Docs: the AGENTS.md Layout row for `defaults/` (`AGENTS.md:117`), GLOSSARY **Layer** (`GLOSSARY.md:474-478`), request
  3.9's "Three layers, defaults < user < repo" (`docs/requests/node-harness-dag.md:636-639`), `lib/config.ts:21`'s and
  `:170`'s comments, and `test/support/shipped-flow.ts:10`'s.

What it does not change:

- The Config Hash and the Pinned Configuration. Their inputs are the Resolved Flow, the Layer files, `harnesses`,
  `launchProfile`, `commands`, `testPaths` and `approvers` (`lib/config.ts:211-233`, built at `lib/run.ts:193-201`).
  The defaults Layer holds none of them and names no file, so the same four values from code give the same hashes.
  `labelPrefix` reaches the hash only through an approval Vertex's labels (P-F), and keeps its value.
- Problem codes: the defaults load error is a thrown `Error`, not a Problem.
- `gg doctor` output: `lib/doctor.ts:194-219` prints none of the four settings, so `test/fixtures/example/doctor.txt`
  is unchanged.
- `labels.DEFAULT_PREFIX` stays the one place the prefix's default is spelt; the constant takes it from there.

## 3. The user Layer's reach

A home-directory Layer applies to every repository the person runs gg in, and it may set any key outside the
repository-only list. What the probes show:

- **Harness, model and effort.** Choosing a subscription's CLI and model is the person's, and is the same in every
  repository they own, so a home Layer suits it. The risk is the key: settings are keyed by Agent name, and a name means
  what each repository's Flow makes it mean. The repository Layer also wins field by field (`merge` order, P-M): a
  repository that sets the reviewer's `harness` and `model` but not `effort` runs with the person's `effort`, written
  for another harness (P-M: `codex` with `gpt-6.1-sol` and the Claude example's `"effort": "high"`). An effort the other
  CLI rejects would fail only when its Harness validates it.
- **Files.** A user Layer may declare a Persona, so it may replace the repository's Persona when the repository names
  none, and it fails to load in every repository that declares a different file under the same name (P-K: "file
  "reviewer.md" is declared by <home> and by <repo>"). A file the user Layer declares is loaded and hashed even when the
  repository's own name wins the merge (P-K2: the merged Persona is `reviewer.md`, `my-reviewer.md` is still in
  `files`, and the hash moves from `e5e742878bf9` to `addb7302d813`).
- **`labelPrefix` and `baseBranch`.** Both describe the repository: the labels live on its issues and gg reads them
  back on the next Run. A person's `labelPrefix` change strands every Ticket gg labelled before it: `labelsFor('me')`
  parses none of `gg:await:approve`, `gg:state:in-progress`, `gg:decide:approve:approved` (P-prefix), so a Pending
  Ticket's Await Label is no longer seen. A repository that sets them wins over the person (P-N); one that relies on the
  default inherits whatever the person set (P-E).
- **`worktreeRoot`, `maxParallel`.** Both describe the machine, so a home Layer suits them. A resumed Execution keeps
  its recorded worktree (`lib/admission.ts:141`), so changing `worktreeRoot` is safe between Runs.

The alternatives the issue names:

- **A per-repository personal Layer**, an untracked `.agents/gg/local.json` beside the repository Layer. It reaches one
  repository, its files resolve in the same directory (one name is then one file by construction), and gg init can
  write its `.gitignore` line. It costs a copy in each repository, and the person's settings no longer follow them.
- **User settings keyed by repository**, `repositories.<owner/name>` in the home Layer. Same reach as a local Layer,
  but gg must name a repository the same way on every machine (remote URL, path or GitHub slug), and a renamed
  repository silently loses its settings. Not carried into the candidates.
- **An allow-list** of what a user Layer may set, in place of today's growing deny list (`lib/config.ts:91`, five keys
  since ADR 0013, P2, P4 and #119). Every key added to gg would default to repository-only, so a new key cannot reach
  every repository by accident. It also gives the closed key list that catches P-G's typo.

## 4. Merge rules with fewer Layers

| Rule | Where | With two Layers (user < repository) | With one Layer |
| --- | --- | --- | --- |
| Objects merge key by key | `lib/config.ts:160-168` | still needed for `agents.<name>` | gone |
| Arrays replace whole | `:168` | no array is user-settable under an allow-list, so moot | gone |
| No deletion | request 3.3 (`node-harness-dag.md:254`) | still true; a person cannot unset a repository key | gone |
| `null` is never a value | `lib/validate/index.ts:76-90`, #298 | still needed: a `null` in any Layer reaches the validator (P-I: `null-value@labelPrefix`) | still needed |
| One name names one file | `lib/config.ts:121-143` | gone if the user Layer may not name files; stays (trivially) for a local Layer in the same directory | gone |
| Repository-only keys | `lib/config.ts:90-93` | replaced by the allow-list | gone |

The rule that earns the most code is "one name names one file" (`FileSources`, `loadFiles`'s cross-Layer branch and
three cases in `test/unit/config.test.ts`, at `:152`, `:185` and `:225`). It exists only because a non-repository Layer may name files.

## 5. What a Run pins

The Config Hash covers the Resolved Flow, every Layer file by name, `harnesses`, `launchProfile` (always `null` until
the Claude Harness lands, `lib/run.ts:197`), `commands`, `testPaths` and `approvers` (`lib/config.ts:223-233`). The
Resolved Flow carries each Vertex's merged Agent, harness, model and effort included (`lib/validate/flows.ts:245`), and
an approval Vertex's labels with their prefix (`:340-344`). So:

- A person's harness or model change changes a repository's Config Hash (P-B `e5e742878bf9`, P-C `ee68cc5a0a35`, P-D
  `1914dc565c57`). That is the hash's job: request 3.7 (`node-harness-dag.md:602`) and ADR 0002 make it what tells two
  configurations apart in stats and evaluations, so Runs on different models must differ.
- A person's unused file changes it too (P-K2), which serves nothing.
- `labelPrefix` changes it only when the Flow has an approval Vertex (P-F: `7af32a3fcde0` and `f87f739a53fb`); the
  other three Run settings never do (P-E: the hash stays `e5e742878bf9`).
- The record keeps the hash of the Run that created it (`lib/admission.ts:222`), but an Approval Request's digest takes
  the current Run's (`lib/admission.ts:364`, `lib/approval-action.ts:43`). A model change between the Run that asked
  and the Run that reads the Decision makes the digest differ (P-L: `a60117c18fa0` and `e4acc0832294`), so the
  Decision reads `stale` (`lib/approval.ts:148`) and gg retires the request and asks again (`lib/approval-action.ts:213`).
  This is loud and loses nothing; whether a person's model is part of what an approver approves is a question for the
  owner (decision 3).

## 6. Open requests that assume Layers

- **"Eval variants are config layers and may change flow structure"** (request 3.9, `node-harness-dag.md:645`). P2
  forbids any Layer but the repository's to hold `flows` or `procedures`, so a variant cannot be a Layer that changes a
  Flow. A variant fits as a second named Flow in the repository Layer, picked with `--flow` (#122), whose Resolved Flow
  and hash already differ. No code implements variants. The sentence should be rewritten whatever the design.
- **The migration table** (`lib/config.ts:171`, "slice 5 brings the migration table"; request 3.9,
  `node-harness-dag.md:641-645`). ff's stage keys in a gg Layer should be a loud load error naming the replacement.
  Today any unknown top-level key is ignored (P-G). A closed list of top-level keys per Layer gives the error, and the
  migration table is then the message for ff's known keys. It is independent of the number of Layers.
- **gg init's and preflight's advice** to merge an example into the user Layer (`lib/doctor.ts:230-231`,
  `lib/run.ts:144-150`, asserted at `test/unit/run.test.ts:319` and `test/e2e/gg.test.ts:175`). It stays under any
  design that keeps a home Layer, and names the new place otherwise.
- **Keys request 3.9 carries over by name** (`node-harness-dag.md:643-645`): `planApproval`, `stuckAfterHours`,
  `allowNetwork` and `style` describe the repository's process; `apiPrices` and `contextBudget.byModel` describe the
  person's subscription. An allow-list sorts each as it lands.
- **The registry** that `gg work` reads lives in the home directory too (`node-harness-dag.md:526`), so `~/.agents/gg/`
  stays meaningful under every design.

## Candidate designs

Each design keeps `flows`, `procedures`, `commands`, `testPaths` and `approvers` in the repository Layer alone (ADR
0013, ADR 0014), and each can take the Run-setting validation in decision 2.

### A. Three Layers, tightened

Keep `defaults/gg.json`. Replace the deny list with an allow-list: a user Layer may set `agents.<name>.harness`,
`model` and `effort`, `worktreeRoot` and `maxParallel`; anything else is a load error naming the file and key.

- Cost: `rejectRepoOnly` becomes an allow-list check (about 15 lines); the five user-Layer load-error cases in
  `test/unit/config.test.ts` (`:247-254`, `:293-315`, `:496-504`) become allow-list cases; the cross-Layer file rule and
  its cases stay for the defaults Layer, which names none. Docs: request 3.9, GLOSSARY **Layer**.
- Gives up nothing it has today; keeps a configuration file for four constants, and the file machinery for a Layer
  that names no file.
- Config Hash: unchanged for every valid configuration; a user Layer that names a file stops loading (it was P-K2's
  case). Pinned Configuration and Problem codes unchanged.

### B. Two Layers, user < repository, over settings in code (recommended)

The four Run settings become one constant in `lib/config.ts`. The user Layer takes the allow-list of A and names no
file. The repository Layer may set every key; `labelPrefix` and `baseBranch` are repository-only.

- Cost: section 2's removals; the allow-list of A; `loadFiles` reads one Layer, so `FileSources`, the "declared by ...
  and by ..." error and the three cross-Layer cases (`test/unit/config.test.ts:152`, `:185`, `:225`) go. Docs: request 3.1
  (`node-harness-dag.md:57`, "resolved through the user and repo Layers"), 3.3 (`:252-256`), 3.9; GLOSSARY **Layer**;
  AGENTS.md Layout; a new ADR. Advice texts unchanged.
- Gives up a Persona or other file from the home directory, and a person's own `labelPrefix` or `baseBranch`. Neither is
  used today.
- Config Hash: inputs unchanged; same values for every configuration that loads today except one whose user Layer
  names a file, which stops loading. Pinned Configuration unchanged. Problem codes: none new unless decision 2 adds
  one.
- Migration: none on this machine (no user Layer); a user Layer copied from `examples/` already fits the allow-list.

### C. Repository Layer plus an untracked per-repository Layer

Settings in code < `.agents/gg/gg.json` < `.agents/gg/local.json` (untracked, the allow-list of A). No home Layer.

- Cost: B's removals, plus `loadLayers` loses its `home` parameter, so every test that passes a temp home changes
  (`test/unit/interpreter.test.ts:65`, `test/unit/run.test.ts:303`, `test/unit/doctor.test.ts:250` and `:300`, the e2e
  temp home at `test/e2e/gg.test.ts:108`); gg init writes the `.gitignore` line; both advice texts and their assertions
  change; `examples/` are copied per repository.
- Gives up settings that follow the person; each repository needs its own copy, and a fresh clone has none until the
  person copies one.
- Config Hash: as B. Note the local Layer overrides the repository, so it reverses today's precedence for those keys:
  the person's harness wins over the repository's.

### D. One Layer: the repository's, over settings in code

The Agents' harness, model and effort are committed in the repository Layer; there is no personal Layer.

- Cost: the least code: `merge`, `rejectRepoOnly`, `FileSources` and the home read go; `loadLayers` reads one file.
  gg init must write a harness, model and effort (a `--harness` flag, or the advice to edit gg.json), and `examples/`
  become what it writes. Tests as C, and every case that builds a user Layer.
- Gives up per-person choices: a collaborator on another subscription must edit a tracked file, and every model change
  is a commit, which also moves the Config Hash in the repository's history rather than per Run.
- Config Hash: as B; the hash's inputs then come from one tracked file and gg's own templates.

### Costs side by side

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| Layers | 3 | 2 | 2 | 1 |
| `defaults/`, `loadDefaults` | kept | removed | removed | removed |
| Cross-Layer file rule | kept | removed | trivial | removed |
| Settings follow the person | yes | yes | no | no |
| A person can override the repository | no | no | yes | n/a |
| Tests that change | the 5 user-Layer load-error cases | A's, the 5 defaults cases and the 3 cross-Layer file cases | B's, and every caller that passes a temp home (5 files) | C's, and every case that builds a user Layer |
| Advice texts change | no | no | yes | yes |
| Config Hash inputs, Pinned Configuration, Problem codes | unchanged | unchanged | unchanged | unchanged |

## Recommendation

B. It removes the Layer that holds only constants and the file rule that exists only for non-repository Layers, keeps
what the user Layer is for (a person's harness, model and effort, and the machine's `worktreeRoot` and `maxParallel`),
and makes every future key repository-only unless it is added to the allow-list. It changes no Config Hash input, no
Pinned Configuration and no Problem code, so the follow-up can land before #23 without touching the freeze. C is the
better choice only if settings that follow the person across repositories are judged a hazard rather than a
convenience; the probes found no harm in them once the user Layer names no files and cannot set `labelPrefix`.

## Decisions for the owner

1. The Layer design: A, B, C or D (recommended: B).
2. The Run settings' validation (section 1): today an invalid `maxParallel` runs no Ticket in silence and an unknown key
   is ignored. (a) Fold into the follow-up a closed top-level key list and type checks on the four settings, with the
   migration table's messages for ff's keys (recommended; may add one Problem code for a non-string setting, so it
   lands before #23); (b) a separate bug ticket; (c) leave it.
3. A person's model in the Approval Digest (section 5): (a) keep, a changed model re-asks the approver (recommended:
   loud, nothing lost, no code); (b) the digest takes the Execution's own hash from its record, so a Decision outlives a
   configuration change; (c) the digest drops the Agents' settings.

## Appendix: probes

Run from the job's temp directory, outside the worktree, on 2026-11-08:

```
node probe-layers.ts C:/dev/worktrees/grey-goo-ri/314-config-layers
node probe-prefix.ts C:/dev/worktrees/grey-goo-ri/314-config-layers
```

`probe-layers.ts` copies `test/fixtures/example/` into a temp repository's `.agents/gg/` with `commands.test` added,
writes a user Layer into a temp home for each case, calls `config.loadLayers(repo, home)`, runs the validator with the
shipped Harnesses as `lib/run.ts:183-187` does, and builds the Pinned Configuration and its hash as `lib/run.ts:193-202`
does (first 12 hex digits shown). Cases: A no user Layer; B and C `examples/claude.json` and `examples/codex.json`; D
B with the reviewer's model `opus`; E B plus the four Run settings; F an approval Vertex between `reviewer` and
`publish`, under prefixes `gg` and `me`; G a misspelt `maxParalel`; H `run.mapConcurrently` over three Tickets with
bad limits; H2 bad types for three settings; I a `null` prefix; J each repository-only key in the user Layer; K the user
Layer declaring `reviewer.md` beside itself; K2 the user Layer naming its own `my-reviewer.md`; L `approval.digest`
over B's and D's hashes; M the repository setting the reviewer's harness and model; N both Layers setting `labelPrefix`
and `baseBranch`. `probe-prefix.ts` parses three `gg:` labels with `labels.labelsFor('me')` and `labelsFor('gg')`.

Output (temp paths shown as `<tmp>`):

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
K2 merged reviewer persona, and files loaded: {"persona":"reviewer.md","files":["my-reviewer.md","reviewer.md","review.md","review-comment.md"]}
L Approval Digest, same head and body, hash B vs D: ["a60117c18fa0","e4acc0832294"]
M repo sets reviewer harness codex, user sets claude: merged: {"reviewer":{"harness":"codex","model":"gpt-6.1-sol","effort":"high","persona":"reviewer.md","access":"read-only"},"resolved":{"harness":"codex","model":"gpt-6.1-sol","effort":"high","persona":"reviewer.md","access":"read-only"}}
N repo sets labelPrefix/baseBranch, user too: merged: {"maxParallel":2,"baseBranch":"trunk","worktreeRoot":"~/worktrees","labelPrefix":"repo"}
prefix me reads gg:await:approve: null; prefix gg: {"family":"await","vertex":"approve"}
prefix me reads gg:state:in-progress: null; prefix gg: {"family":"state","name":"in-progress"}
prefix me reads gg:decide:approve:approved: null; prefix gg: {"family":"decide","vertex":"approve","outcome":"approved"}
```

The two scripts, as run:

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
  return { layers, json, errors: errors.map((e: any) => `${e.code}@${e.at}`), hash: config.configHash(pinned).slice(0, 12), run };
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
const digest = (hash: string) => approval.digest({ head: 'a'.repeat(40), body: 'ticket body', configHash: hash }).slice(0, 12);
show('L Approval Digest, same head and body, hash B vs D', [digest(claude.hash), digest(opus.hash)]);

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
