# User-defined Procedures: the example Flow, in full

Step 2 of the handoff: the Agents, Procedures and Flow that `gg init` writes into a repository Layer (P1, P3), with every
accepted decision (R1–R14, S1–S7, T1–T14, P1–P5, U1–U15). gg ships no default Flow; this is an example the repository
then owns. Spelling is illustrative (S3 fixes it), YAML stands for the JSON of `.agents/gg/gg.json`, and Brief, schema,
Persona and template names stand for files `gg init` writes beside it. Comments cite the decision behind each line.

```yaml
testPaths: [...]                             # required (P4); gg init writes today's DEFAULT_TEST_GLOBS
commands: { test: ... }                      # required (ADR 0013); Checks name it, never a command line (U13)
```

## What Briefs and templates read (U1)

- **gg's own context**, for any Brief or template that names it, never inserted: the Ticket, base, branch diff,
  Declared Commands, History, provenance, Action Marker, and the test files changed since the Execution's first test
  commit (R3d); a stop template also reads the Terminal Reason and the end's name (W6). gg computes a value only when
  a template names it.
- **The Vertex's own outputs**, by Action id (`fix.response`, `test.evidence`).
- **Everything another Vertex produced**, through `inputs` (Q7), snapshotted at Visit entry (S4), as
  `<vertex>.<action id>.<field>` (W2), or `<vertex>.rescue`, `{ ref, diffStat, output }`, when R5a rescued that
  Vertex's work (W3).

The example's Briefs use what today's do: red and green the Ticket and commands, and the findings when present (R2g,
W10); red also green's `diagnosis` when green stopped with `bad-test` (M2); green also any rescued work, for
`senior-green` (V6); fix the History, findings and any rescued work; the reviewer the diff, the changed test files, the
report, both evidences and the History, which records a `bad-test` detour (L4), and, when `redReport.reason` is
`no-test-needed`, whether a test was in fact needed (`needsTest: true` sends it back through `retest`; N6, N10). Green,
the reviewer and `pr-body.md` show red's no-test notes whenever its latest Claim says so, since after a `retest` the
`tests` and `red` inputs still hold an earlier Visit's values (S4). `pr-body.md` reads `report`, `red`, `green` and
`redReport` (today's `render.prBody`), and each `pr-upsert` binds them with `with:`.

## Agents

```yaml
agents:                                      # harness, model and effort come from the user Layer (P2)
  implementer: { persona: implementer.md, access: workspace-write }
  reviewer:    { persona: reviewer.md,    access: read-only }
  senior:      { persona: implementer.md, access: workspace-write }   # meant for a stronger model (R12e)
```

## Procedures

Every response schema's `reason` enum includes `none` for a Claim that is not a stop (U3). Every Procedure's `stopped`
table refines the shared `blocked` token by its `reason` (R9b); it is written out in each Procedure because tables
belong to the Procedure. A stop token's `comment` template replaces the end's Terminal Reason comment, goes to the
Ticket, and to the Epic too at `end: needs-replan` (U6, W5, W9). `blocked.md` reads `summary`, `diagnosis` and the
Terminal Reason, which every schema and stop provides (W6).

`pr-upsert` creates the PR as a draft and never changes its draft state; only `pr-ready` makes it ready (W4).

### base-check (the `baseline` Vertex)

No agent step, so its implicit Claim `ok` requires its Check (R11f); a Check leaves the tree unchanged (T1b).

```yaml
base-check:
  actions:
    - { id: test, do: check, kind: command, command: test, reuse: tree }   # L8, L13: passing runs reused per tree
  passed: []
  failed: []
```

- Outcomes: `ok`, `failed`.
- `reuse: tree` reuses a passing result this repository recorded for the same tree and resolved command line, so
  Tickets on a green base share one run; a failing result is never reused, so a repaired environment clears on the next
  run (L8, L13, J2). A reused pass does not prove this worktree's environment is still healthy; if it is not,
  the Ticket takes the no-baseline path below. A red base ends at `needs-human` with the
  failing tests in the Terminal Reason, before any agent runs, and only an observed base run says so. With a green
  base, every test failing at red is new or broken by red: a named one is red's failing test, and a test red broke
  through a shared fixture fails green, which can stop with `bad-test` (M2) to send it back to red.
- It is optional (L1). Without it, a base with a failing test still lets red
  pass, since red needs only a named test failing (request 3.6), then fails every implementation: `green`, its
  recovery, `senior-green` and its recovery each fail on the unrelated test (about 11 Attempts and two senior calls),
  and the Ticket ends at `needs-human` with a Terminal Reason that blames the implementation. A green that blames red's
  test can also stop with `bad-test`, sending the Ticket to red, which may edit the unrelated test (`tests: write`);
  the reviewer sees that edit in the diff.

### tests-fail (the `red` and `senior-red` Vertices)

`red.schema.json`'s `reason` is `none | misscoped | needs-input | environment | no-test-needed` (U11).

```yaml
tests-fail:
  tests: write                               # R3b
  claims:
    ok:      { requires: [red-check] }
    blocked: { stop: true, comment: blocked.md }               # S5, R9a
  actions:
    - { id: red,       do: agent, brief: red.md, schema: red.schema.json }        # response: tests (names), summary
    - { id: red-check, do: check, kind: tests-fail, command: test, names: response.tests,
        recoverBrief: still-green.md }
        # recoverable: the named tests unexpectedly passed (T4c); no file under testPaths changed since the
        #   Visit's baseline (U2, K7); named tests missing from the output (N5)
        # not: a timeout or a missing command
    - { id: commit,    do: commit, type: test }                # nothing to commit: a no-op, files: [] (U2)
  recover: { max: 1, brief: recover.md }    # today's stillGreen: 1 (T4a)
  passed: []                                 # no rows: the claimed token, ok (S3)
  failed: []                                 # no rows: the engine Outcome failed (T7, U14)
  stopped:
    - { when: { response.reason: misscoped },      outcome: misscoped }
    - { when: { response.reason: no-test-needed }, outcome: no-test }       # U11
                                             # no match: the token, blocked
```

- Outcomes: `ok`, `failed`, `misscoped`, `no-test`, `blocked`, `harness-*`.
- Outputs read later: `commit.files`, `red-check.evidence`, and `rescue` when a failure or stop routes to another
  Vertex (R5c).

### implement (the `green` and `senior-green` Vertices)

```yaml
implement:
  tests: frozen                              # the default, written for gg doctor's sake (R3b)
  claims:
    ok:      { requires: [test] }
    blocked: { stop: true, comment: blocked.md }
  actions:
    - { id: green,  do: agent, brief: green.md, schema: implement.schema.json }   # response: summary, dod, qa
    - { id: test,   do: check, kind: command, command: test, recoverBrief: test-fix.md }   # non-zero exit recoverable
    - { id: commit, do: commit, type: feat }
    - { id: push,   do: push }
    - { id: pr,     do: pr-upsert, body: pr-body.md,                               # T2: the draft PR stays early
        with: { report: green.response, red: inputs.red, green: test.evidence,
                redReport: inputs.redReport } }
  recover: { max: 1, brief: recover.md }    # today's testFix: 1
  passed: []
  failed: []
  stopped:
    - { when: { response.reason: misscoped }, outcome: misscoped }
    - { when: { response.reason: bad-test },  outcome: bad-test }       # M2: the test is wrong; red rewrites it
```

- `implement.schema.json`'s `reason` adds `bad-test` to the shared enum (M2); `diagnosis` says what is wrong.
- Outcomes: `ok`, `failed`, `misscoped`, `bad-test`, `blocked`, `harness-*`.
- Outputs read later: `green.response` (the implementation report, and a `bad-test` diagnosis), `test.evidence`
  (Green Evidence).

### fix (the `implementer-fix` and `senior-dev` Vertices)

```yaml
fix:
  tests: { named: inputs.testFiles }         # T8: a list of paths, from pick: file
  claims:
    ok:      { requires: [test] }
    blocked: { stop: true, comment: blocked.md }
  actions:
    - { id: fix,    do: agent, brief: fix.md, schema: implement.schema.json }     # findings, History, previous
    - { id: test,   do: check, kind: command, command: test, recoverBrief: test-fix.md }
    - { id: commit, do: commit, type: fix }                    # no edits: a no-op, as today (U2)
    - { id: push,   do: push }
    - { id: pr,     do: pr-upsert, body: pr-body.md,
        with: { report: fix.response, red: inputs.red, green: test.evidence,
                redReport: inputs.redReport } }
  recover: { max: 1, brief: recover.md }
  passed: []
  failed: []
  stopped:
    - { when: { response.reason: misscoped }, outcome: misscoped }
```

- Outcomes: `ok`, `failed`, `misscoped`, `blocked`, `harness-*`.
- Outputs read later: `fix.response`, `test.evidence`, and `rescue` when a failure routes to another Vertex (R5c).

### review (the `reviewer` Vertex)

The response schema gains `needsTest` (boolean, R2g), `reason` and `diagnosis` (R9a, U3), and the Claim enum becomes
`ok | changes | blocked`.

```yaml
review:
  access: read-only                          # caps the Agent's access whatever it declares (U12)
  claims:                                    # neither requires a Check, so effects always run (P5a)
    ok:      { requires: [] }
    changes: { requires: [] }
    blocked: { stop: true, comment: blocked.md }
  actions:
    - { id: review,      do: agent, brief: review.md, schema: review.schema.json }
    - { id: review-pass, do: check, kind: response,                       # R4a, P5d
        all-of: [ { field: dodMet, is: true },
                  { field: tddEvidenceOk, is: true },
                  { none: findings, where: { severity: [blocker, major] } } ] }
    - { id: repeat,      do: check, kind: repeat, list: response.findings,
        fields: [file, severity, issue] }    # R4c: failed means a repeat; a fact, required by nothing
    - { id: comment,     do: comment, target: pr, body: review-comment.md }   # W5
    - { id: pr,          do: pr-upsert, body: pr-body.md,
        with: { report: inputs.report, red: inputs.red, green: inputs.green, redReport: inputs.redReport } }
  passed:                                    # every review lands here: nothing is required (P5a, P5b)
    - { when: { claim: ok, check.review-pass: passed }, outcome: ok }   # the only way to ok
    - { when: { check.repeat: failed }, outcome: repeat }
    - { when: { response.needsTest: true }, outcome: retest }
  otherwise: changes                         # claim changes, or ok with review-pass failed (T13)
  stopped:
    - { when: { response.reason: misscoped }, outcome: misscoped }
```

- Outcomes: `ok`, `changes`, `retest`, `repeat`, `misscoped`, `blocked`, `harness-*`. No token requires a Check, so
  the review has no `failed` table and never produces the engine Outcome `failed` (T7).
- Outputs read later: `review.response.findings`.

### publish (the `publish` Vertex)

No agent step, so its implicit Claim `ok` requires every Check (R11f).

```yaml
publish:
  actions:
    - { id: test,     do: check, kind: command, command: test }   # no agent to recover with; failed falls
                                             # to "*": needs-human, naming publish.test (P5c, J1)
    - { id: pr,       do: pr-upsert, body: pr-body.md,            # re-renders the body (T2)
        with: { report: inputs.report, red: inputs.red, green: inputs.green, redReport: inputs.redReport } }
    - { id: pr-ready, do: pr-ready }         # publishing: test's tree = the published commit's, clean worktree (T1a)
  passed: []
  failed: []
```

- Outcomes: `ok`, `failed`.

## The Flow

The implementation report and the two evidences are declared the same way wherever they are read (T6: the latest Visit
across the list wins). They are shown once as `&impl`; the JSON spells them out at each Vertex.

```yaml
flows:
  default:
    plan: null                               # X2: no Epic-level planning; standalone tickets run
    actionCap: 180                           # K2, V2, M3, L8: every Attempt in the Execution, a required spend ceiling
    ticket:
      entry: baseline                        # L1: optional; drop it to skip the base run
      routes:                                # T3: every Vertex inherits these
        misscoped: { end: needs-replan }     # also posts the diagnosis to the Epic (U6)
        "*":       { end: needs-human }
      vertices:
        baseline:
          procedure: base-check              # no Agent
          route: { ok: red }                 # failed falls to "*": the base is red before any agent runs (L8)

        red:
          use: implementer
          procedure: tests-fail
          inputs:
            findings: { from: reviewer.review.response.findings, optional: true }       # absent on the first Visit (T10)
            previous: { from: [green.green.response, senior-green.green.response], optional: true }   # M2
          route:
            ok:      green
            no-test: green                   # N6: rescued and reset (R5a); the reviewer judges the claim

        green:
          use: implementer
          procedure: implement
          inputs:
            tests:    { from: [red.commit.files, senior-red.commit.files], optional: true }   # N6: absent after no-test
            red:      { from: [red.red-check.evidence, senior-red.red-check.evidence], optional: true }
            findings: { from: reviewer.review.response.findings, optional: true }   # W10
            previous: { from: green.rescue, optional: true }   # V6: the shared green.md reads it, as W7
            redReport: { from: [red.red.response, senior-red.red.response] }   # N10: red's latest Claim
          route:
            ok:       reviewer
            failed:   senior-green           # V6: rescues the work (R5a), so senior-green.previous exists
            bad-test: { to: red, max: 1, exhausted: { end: needs-human } }   # M2: rescued and reset (R5a)

        senior-green:                        # V6: tests the implementer could not pass go to the stronger model once
          use: senior
          procedure: implement
          maxVisits: 1
          exhausted: { end: needs-human }
          inputs:
            tests:    { from: [red.commit.files, senior-red.commit.files], optional: true }
            red:      { from: [red.red-check.evidence, senior-red.red-check.evidence], optional: true }
            findings: { from: reviewer.review.response.findings, optional: true }
            previous: { from: green.rescue, optional: true }
            redReport: { from: [red.red.response, senior-red.red.response] }   # N10: red's latest Claim
          route:
            ok:       reviewer
            bad-test: { to: red, max: 1, exhausted: { end: needs-human } }   # M2

        reviewer:
          use: reviewer
          procedure: review
          inputs: &impl                      # U1, T6
            report: { from: [green.green.response, senior-green.green.response, implementer-fix.fix.response,
                              senior-dev.fix.response] }
            red:    { from: [red.red-check.evidence, senior-red.red-check.evidence], optional: true }   # N6
            redReport: { from: [red.red.response, senior-red.red.response] }   # N10
            green:  { from: [green.test.evidence, senior-green.test.evidence, implementer-fix.test.evidence,
                              senior-dev.test.evidence] }
          route:
            ok:      publish
            retest:  { to: red,             max: 2, exhausted: senior-red }    # U11
            changes: { to: implementer-fix, max: 2, exhausted: senior-dev }
            repeat:  { to: senior-dev,      max: 1, exhausted: { end: needs-human } }   # T5

        senior-red:                          # U11: the stronger model writes the failing test; green makes it pass
          use: senior
          procedure: tests-fail
          maxVisits: 1
          exhausted: { end: needs-human }
          inputs:
            findings: { from: reviewer.review.response.findings }
            previous: { from: [green.green.response, senior-green.green.response], optional: true }   # L2: red.md reads it
          route:
            ok:      green
            no-test: senior-dev              # a stop routed to a Vertex: rescued and reset (R5a)

        implementer-fix:
          use: implementer
          procedure: fix
          inputs:
            <<: *impl
            findings:  { from: reviewer.review.response.findings }
            testFiles: { from: reviewer.review.response.findings, pick: file }           # T8
            previous:  { from: [implementer-fix.rescue, senior-red.rescue], optional: true }   # W7
          route:
            ok:     reviewer
            failed: senior-dev               # T9: rescues the work (R5a), so senior-dev.previous exists

        senior-dev:
          use: senior
          procedure: fix
          maxVisits: 1                       # T5
          exhausted: { end: needs-human }
          inputs:
            <<: *impl
            findings:  { from: reviewer.review.response.findings }
            testFiles: { from: reviewer.review.response.findings, pick: file }
            previous:  { from: [implementer-fix.rescue, senior-red.rescue], optional: true }   # T9, U11
          route: { ok: reviewer }

        publish:
          procedure: publish                 # no Agent
          inputs: *impl                      # U1
          route:
            ok:     { end: ready-for-qa }   # failed falls to "*" (J1)
```

## What admission sees

- **Every Outcome is routed** (R12b, T3). The Flow's `"*"` catches `blocked`, `failed` (except `green`'s
  and `implementer-fix`'s), `harness-*`, and every unlisted Outcome; `bad-test` goes back to `red`;
  `misscoped` goes to the planner from any Vertex.
- **Every path to `end: ready-for-qa` runs `pr-ready`** (R11e): only `publish` reaches it.
- **Entry** (L1): `baseline` has no Agent; its `failed` falls to `"*"`, naming `baseline.test`.
- **Publishing** (R11d, T1a): `publish` requires `test` and runs `pr-ready` only on that Check's tree. Its `failed`
  falls to `"*"`, naming `publish.test`: the tree already passed, so the failure is the environment or a test that
  is not deterministic, and a re-run would hide the second (J1).
- **Commits** (S2, T1c): every passing path of `red`, `senior-red`, `green`, `senior-green`, `implementer-fix` and
  `senior-dev` commits, and each committing token requires a Check.
- **Inputs** (Q7, S4, T6, T9, U1, N6): `tests` and `red` of `green` and `senior-green`, and every `red` evidence, are
  optional: `red`'s `no-test` path produces neither (`red-check.evidence` exists only when the Check passed, N9); every
  `redReport` comes from `red`, whose agent Action responds on every Visit, stops included (N10); every `report` and
  `green` comes from one of their producers on every path, since `green` precedes every reviewer; `senior-red.findings`
  and the fix Vertices' `findings` from `reviewer`, which precedes them on every path; `red.findings`, both green
  Vertices' `findings` and `previous`, and both fix Vertices' `previous` are optional, each with a producing path
  (`implementer-fix.previous` through `senior-red → senior-dev → reviewer → implementer-fix`; `green.previous` through
  `green → senior-green → reviewer → red → green`; `red.previous` through `red → green →
  red`, M2).
- **Bounds** (I3, T5, V3): `red → green → reviewer → red` is bounded by `retest`'s `max: 2`;
  `reviewer → implementer-fix → reviewer` by `changes`' `max: 2`; every path into `senior-red`, `senior-green` and
  `senior-dev` by their `maxVisits: 1`; each cycle back to `red` through
  a `bad-test` edge by that edge's `max: 1` (M2); the Ticket's Action Cap over all of them. The cap covers the longest
  bounded path: three passes of red, green and review (13 Attempts each, two `retest` loops), then `senior-red`,
  `green`, `senior-green`, review, two `changes` loops, `senior-dev`, review and `publish`, about 90 Attempts; the two
  `bad-test` detours add about 20, one recovery per agent Visit about 45 and `baseline` 1, so about 156 (V2, M3, L1).
- **Rules** (R8, U4, J14): no unreachable or never-firing row. Three partial overlaps in the review's `passed` table,
  reported as two row warnings (row 2, and row 3), all intended: a clean `ok` whose findings repeat earlier ones stays `ok` (row 1 over row 2); a clean `ok` that
  also has `needsTest: true` stays `ok` (row 1 over row 3); a repeat that also has `needsTest: true` goes to `repeat`
  (row 2 over row 3).
- **Rescue** (R5, U5): decided on the effective target. `red`'s `no-test` rescues any partial test work and resets
  before `green` (N6); a green Vertex's `bad-test` rescues and resets before `red` (M2); `green`'s `failed` rescues and
  resets while `senior-green` has a Visit left; `implementer-fix`'s `failed` and `senior-red`'s `no-test` while
  `senior-dev` has one. Once the Visit is spent they end at `needs-human` with the work in place (R5b).

## Changes from today's shipped Flow

- It is no longer shipped: `defaults/gg.json` loses `agents` and `flows`, and `gg init` writes this (P1, P3).
- An optional `baseline` Vertex runs the suite on the base before any agent, once per base tree (L1, L8).
- `tdd` splits into `red` and `green` (R2b); `still-green` and `test-fix` become each Procedure's `recover` (T4, W1).
  `resumeGreen` and `requireTestPass` go (R2c, U7).
- `red-failed` and `gate-failed(test)` become `failed`, with the failing Check named in its signal and Terminal Reason
  (U14). A failed `red` ending at `needs-human` leaves its work in place instead of discarding it (R5b, U10).
- A failed `green` escalates once to `senior-green` instead of ending at `needs-human` (V6).
- `red`'s `no-test` goes to `green`, and the reviewer judges the claim, instead of ending at `needs-human` (N6).
- A green that finds the test wrong stops with `bad-test`, and red rewrites it once (M2).
- The review's `misscoped` token becomes `blocked` with `reason: misscoped`, and the reviewer may now stop (R9c). The
  review declares `access: read-only` itself (U12).
- `repeat` routes to `senior-dev` instead of `changes` (R4d), removing the `shortcut:` in `interpreter.mjs`.
- `changes` exhausted goes to `senior-dev`, not `needs-human`. A `needsTest` review goes back to `red`, and
  `retest` exhausted to `senior-red`.
- `done` becomes `publish` plus `end: ready-for-qa` (R11).
- New Agent `senior`; the example Layers gain an entry for it.

## Decided

The four questions the first draft raised are P5 (a)–(d), the round-3 changes are U1–U15 and the round-4 changes W1–W10, in the decisions file.
