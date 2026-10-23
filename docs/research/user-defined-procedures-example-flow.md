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
W10); green also any rescued work, for `senior-green` (V6); fix the History, findings and any rescued work; the reviewer
the diff, the changed test files, the report and both evidences, and, when `redReport.reason` is `no-test-needed`,
whether a test was in fact needed (`needsTest: true` sends it back through `retest`; N6, N10). Green, the reviewer and
`pr-body.md` show red's no-test notes whenever its latest Claim says so, since after a `retest` the `tests` and `red`
inputs still hold an earlier Visit's values (S4). `pr-body.md` reads `report`, `red`, `green` and `redReport` (today's
`render.prBody`), and each `pr-upsert` binds them with `with:`.

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
        #   Visit's baseline (U2, K7)
        # not: named tests missing from the output
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
        with: { report: green.response, red: inputs.red, green: test.evidence } }
  recover: { max: 1, brief: recover.md }    # today's testFix: 1
  passed: []
  failed: []
  stopped:
    - { when: { response.reason: misscoped }, outcome: misscoped }
```

- Outcomes: `ok`, `failed`, `misscoped`, `blocked`, `harness-*`.
- Outputs read later: `green.response` (the implementation report), `test.evidence` (Green Evidence).

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
        with: { report: fix.response, red: inputs.red, green: test.evidence } }
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
        with: { report: inputs.report, red: inputs.red, green: inputs.green } }
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
    - { id: test,     do: check, kind: command, command: test }   # no agent to recover with; failed re-runs
                                             # once through the Flow (N4), then needs-human (P5c)
    - { id: pr,       do: pr-upsert, body: pr-body.md,            # re-renders the body (T2)
        with: { report: inputs.report, red: inputs.red, green: inputs.green } }
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
    actionCap: 128                           # K2, V2: every Attempt in the Execution, a required spend ceiling
    ticket:
      entry: red
      routes:                                # T3: every Vertex inherits these
        misscoped: { end: needs-replan }     # also posts the diagnosis to the Epic (U6)
        "*":       { end: needs-human }
      vertices:
        red:
          use: implementer
          procedure: tests-fail
          inputs:
            findings: { from: reviewer.review.response.findings, optional: true }       # absent on the first Visit (T10)
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
            ok:     reviewer
            failed: senior-green             # V6: rescues the work (R5a), so senior-green.previous exists

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
          route: { ok: reviewer }

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
            ok:     { end: ready-for-qa }
            failed: { to: publish, max: 1, exhausted: { end: needs-human } }   # N4: a flaky suite re-runs once
```

## What admission sees

- **Every Outcome is routed** (R12b, T3). The Flow's `"*"` catches `blocked`, `failed` (except `green`'s,
  `implementer-fix`'s and `publish`'s), `harness-*`, and every unlisted Outcome; `misscoped` goes to the planner from
  any Vertex.
- **Every path to `end: ready-for-qa` runs `pr-ready`** (R11e): only `publish` reaches it.
- **Publishing** (R11d, T1a): `publish` requires `test` and runs `pr-ready` only on that Check's tree.
- **Commits** (S2, T1c): every passing path of `red`, `senior-red`, `green`, `senior-green`, `implementer-fix` and
  `senior-dev` commits, and each committing token requires a Check.
- **Inputs** (Q7, S4, T6, T9, U1, N6): `tests` and `red` of `green` and `senior-green`, and every `red` evidence, are
  optional: `red`'s `no-test` path produces neither (`red-check.evidence` exists only when the Check passed, N9); every
  `redReport` comes from `red`, whose agent Action responds on every Visit, stops included (N10); every `report` and
  `green` comes from one of their producers on every path, since `green` precedes every reviewer; `senior-red.findings`
  and the fix Vertices' `findings` from `reviewer`, which precedes them on every path; `red.findings`, both green
  Vertices' `findings` and `previous`, and both fix Vertices' `previous` are optional, each with a producing path
  (`implementer-fix.previous` through `senior-red → senior-dev → reviewer → implementer-fix`; `green.previous` through
  `green → senior-green → reviewer → red → green`).
- **Bounds** (I3, T5, V3): `red → green → reviewer → red` is bounded by `retest`'s `max: 2`;
  `reviewer → implementer-fix → reviewer` by `changes`' `max: 2`; every path into `senior-red`, `senior-green` and
  `senior-dev` by their `maxVisits: 1`; `publish`'s self-edge by its `max: 1` (N4); the Ticket's Action Cap over all
  of them. The cap covers the longest bounded path: three passes of red, green and review (13 Attempts each, two
  `retest` loops), then `senior-red`, `green`, `senior-green`, review, two `changes` loops, `senior-dev`, review and
  `publish`, about 90 Attempts, and about 125 with one recovery per agent Visit (V2).
- **Rules** (R8, U4): no unreachable or never-firing row. Three partial-overlap warnings in the review's `passed`
  table, all intended: a clean `ok` whose findings repeat earlier ones stays `ok` (row 1 over row 2); a clean `ok` that
  also has `needsTest: true` stays `ok` (row 1 over row 3); a repeat that also has `needsTest: true` goes to `repeat`
  (row 2 over row 3).
- **Rescue** (R5, U5): decided on the effective target. `red`'s `no-test` rescues any partial test work and resets
  before `green` (N6); `green`'s `failed` rescues and resets while `senior-green` has a Visit left; `implementer-fix`'s
  `failed` and `senior-red`'s `no-test` while `senior-dev` has one. Once the Visit is spent they end at `needs-human`
  with the work in place (R5b).

## Changes from today's shipped Flow

- It is no longer shipped: `defaults/gg.json` loses `agents` and `flows`, and `gg init` writes this (P1, P3).
- `tdd` splits into `red` and `green` (R2b); `still-green` and `test-fix` become each Procedure's `recover` (T4, W1).
  `resumeGreen` and `requireTestPass` go (R2c, U7).
- `red-failed` and `gate-failed(test)` become `failed`, with the failing Check named in its signal and Terminal Reason
  (U14). A failed `red` ending at `needs-human` leaves its work in place instead of discarding it (R5b, U10).
- A failed `green` escalates once to `senior-green` instead of ending at `needs-human` (V6).
- `red`'s `no-test` goes to `green`, and the reviewer judges the claim, instead of ending at `needs-human` (N6).
- A failed `publish` re-runs its suite once before `needs-human` (N4).
- The review's `misscoped` token becomes `blocked` with `reason: misscoped`, and the reviewer may now stop (R9c). The
  review declares `access: read-only` itself (U12).
- `repeat` routes to `senior-dev` instead of `changes` (R4d), removing the `shortcut:` in `interpreter.mjs`.
- `changes` exhausted goes to `senior-dev`, not `needs-human`. A `needsTest` review goes back to `red`, and
  `retest` exhausted to `senior-red`.
- `done` becomes `publish` plus `end: ready-for-qa` (R11).
- New Agent `senior`; the example Layers gain an entry for it.

## Decided

The four questions the first draft raised are P5 (a)–(d), the round-3 changes are U1–U15 and the round-4 changes W1–W10, in the decisions file.
