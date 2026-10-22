# User-defined Procedures: the shipped Flow, in full

Step 2 of the handoff: the defaults Layer's Agents, Procedures and Flow, rewritten with every accepted decision (R1–R14,
S1–S7, T1–T14). It is a draft for the owner and the round-3 review. Spelling is illustrative (S3 fixes it), YAML stands
for the JSON of `defaults/gg.json`, and Brief, schema and template names stand for files the slices add. Comments cite
the decision behind each line.

## Agents

```yaml
agents:                                      # no harness or model in the defaults Layer
  implementer: { persona: implementer.md, access: workspace-write }
  reviewer:    { persona: reviewer.md,    access: read-only }
  senior:      { persona: implementer.md, access: workspace-write }   # meant for a stronger model (R12e)
```

## Procedures

Every Procedure's `stopped` table is the same (R9b): the shared `blocked` token, refined by its `reason`. It is written
out in each Procedure because tables belong to the Procedure and a later Layer replaces one whole (R10).

### tests-fail (the `red` Vertex)

```yaml
tests-fail:
  tests: write                               # R3b
  claims:
    ok:      { requires: [red-check] }
    blocked: { stop: true, comment: blocked.md }               # S5, R9a
  actions:
    - { id: red,       do: agent, brief: red.md, schema: red.schema.json }        # response: tests (names), summary
    - { id: red-check, do: check, kind: tests-fail, command: test, names: response.tests,
        recoverBrief: still-green.md }        # "tests unexpectedly passed" is recoverable; missing names are not (T4c)
    - { id: commit,    do: commit, type: test }
  recover: { max: 1, brief: recover.md }    # today's stillGreen: 1 (T4a)
  passed: []                                 # no rows: the claimed token, ok (S3)
  failed: []                                 # no rows: the engine Outcome failed (T7)
  stopped:
    - { when: { response.reason: misscoped }, outcome: misscoped }
                                             # no match: the token, blocked
```

- Outcomes: `ok`, `failed`, `misscoped`, `blocked`, `harness-*`.
- Outputs read later: `commit.files`, `red-check.evidence`.

### implement (the `green` Vertex)

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
    - { id: pr,     do: pr-upsert, draft: true, body: pr-body.md }    # T2: the draft PR stays early
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
    - { id: commit, do: commit, type: fix }
    - { id: push,   do: push }
    - { id: pr,     do: pr-upsert, draft: true, body: pr-body.md }
  recover: { max: 1, brief: recover.md }
  passed: []
  failed: []
  stopped:
    - { when: { response.reason: misscoped }, outcome: misscoped }
```

- Outcomes: `ok`, `failed`, `misscoped`, `blocked`, `harness-*`.
- Outputs read later: `fix.response`, `test.evidence`, and `rescue` when a failure routes to another Vertex (R5c).

### review (the `reviewer` Vertex)

The response schema gains `needsTest` (boolean, R2g), `reason` and `diagnosis` (R9a), and the Claim enum becomes
`ok | changes | blocked`.

```yaml
review:
  claims:
    ok:      { requires: [review-pass] }     # R4b; see question 1
    changes: { requires: [] }
    blocked: { stop: true, comment: blocked.md }
  actions:
    - { id: review,      do: agent, brief: review.md, schema: review.schema.json }
    - { id: review-pass, do: check, kind: response, recoverable: false,  # R4a, R4b; see question 4
        all-of: [ { field: dodMet, is: true },
                  { field: tddEvidenceOk, is: true },
                  { none: findings, where: { severity: [blocker, major] } } ] }
    - { id: repeat,      do: check, kind: repeat, list: response.findings,
        fields: [file, severity, issue] }    # R4c: failed means a repeat; a fact, required by nothing
    - { id: comment,     do: comment, body: review-comment.md }
    - { id: pr,          do: pr-upsert, body: pr-body.md }
  passed:                                    # claim ok with review-pass passed, or claim changes
    - { when: { claim: changes, check.repeat: failed }, outcome: repeat }
    - { when: { claim: changes, response.needsTest: true }, outcome: retest }
                                             # no match: the token (ok or changes)
  failed:                                    # claim ok with review-pass failed (T13)
    - { when: { check.repeat: failed }, outcome: repeat }
    - { when: { response.needsTest: true }, outcome: retest }
  otherwise: changes                         # failed table only reaches it; see question 2
  stopped:
    - { when: { response.reason: misscoped }, outcome: misscoped }
```

- Outcomes: `ok`, `changes`, `retest`, `repeat`, `misscoped`, `blocked`, `harness-*`. The `failed` table is total
  with `otherwise`, so the engine Outcome `failed` is not listed (T7).
- Outputs read later: `review.response.findings`.

### publish (the `publish` Vertex)

No agent step, so its implicit Claim `ok` requires every Check (R11f).

```yaml
publish:
  actions:
    - { id: test,     do: check, kind: command, command: test }   # nothing to recover with: no agent
    - { id: pr,       do: pr-upsert, body: pr-body.md }           # re-renders the body (T2)
    - { id: pr-ready, do: pr-ready }         # publishing: test's tree = the published commit's, clean worktree (T1a)
  passed: []
  failed: []
```

- Outcomes: `ok`, `failed`.

## The Flow

```yaml
flows:
  default:
    ticket:
      entry: red
      routes:                                # T3: every Vertex inherits these
        misscoped: { end: needs-replan }
        "*":       { end: needs-human }
      vertices:
        red:
          use: implementer
          procedure: tests-fail
          inputs:
            findings: { from: reviewer.review.findings, optional: true }       # absent on the first Visit (T10)
          route: { ok: green }

        green:
          use: implementer
          procedure: implement
          inputs:
            tests:    { from: red.commit.files }
            evidence: { from: red.red-check.evidence }
          route: { ok: reviewer }

        reviewer:
          use: reviewer
          procedure: review
          inputs:                            # T6: the latest of the three
            report:   { from: [green.green.response, implementer-fix.fix.response, senior-dev.fix.response] }
            evidence: { from: [green.test.evidence, implementer-fix.test.evidence, senior-dev.test.evidence] }
          route:
            ok:      publish
            retest:  { to: red,             max: 2, exhausted: senior-dev }
            changes: { to: implementer-fix, max: 2, exhausted: senior-dev }
            repeat:  { to: senior-dev,      max: 1, exhausted: { end: needs-human } }   # T5

        implementer-fix:
          use: implementer
          procedure: fix
          inputs:
            findings:  { from: reviewer.review.findings }
            testFiles: { from: reviewer.review.findings, pick: file }           # T8
          route:
            ok:     reviewer
            failed: senior-dev               # T9: rescues the work (R5a), so senior-dev.previous exists

        senior-dev:
          use: senior
          procedure: fix
          maxVisits: 1                       # T5
          exhausted: { end: needs-human }
          inputs:
            findings:  { from: reviewer.review.findings }
            testFiles: { from: reviewer.review.findings, pick: file }
            previous:  { from: implementer-fix.rescue, optional: true }         # produced on implementer-fix failed (T9)
          route: { ok: reviewer }

        publish:
          procedure: publish                 # no Agent
          route: { ok: { end: ready-for-qa } }
```

## What admission sees

- **Every Outcome is routed** (R12b, T3). The Flow's `"*"` catches `blocked`, `failed` (except `implementer-fix`'s),
  `harness-*`, and every unlisted Outcome; `misscoped` goes to the planner from any Vertex.
- **Every path to `end: ready-for-qa` runs `pr-ready`** (R11e): only `publish` reaches it.
- **Publishing** (R11d, T1a): `publish` requires `test` and runs `pr-ready` only on that Check's tree.
- **Commits** (S2, T1c): every passing path of `red`, `green`, `implementer-fix` and `senior-dev` commits, and each
  committing token requires a Check.
- **Inputs** (Q7, S4, T6, T9): `green.tests` and `green.evidence` come from `red` on every path; the reviewer's
  `report` and `evidence` from one of three producers on every path; `red.findings` and `senior-dev.previous` are
  optional, each with a producing path.
- **Bounds** (I3, T5): `red → green → reviewer → red` is bounded by `retest`'s `max: 2`; `reviewer → implementer-fix →
  reviewer` by `changes`' `max: 2`; every path into `senior-dev` by its `maxVisits: 1`; the Ticket's Action Cap over
  all of them.
- **Rules** (R8): no unreachable or never-firing row. Two warnings, both intended: in the review's `passed` and
  `failed` tables a repeat that also has `needsTest: true` goes to `repeat`, which wins by order.

## Changes from today's shipped Flow

- `tdd` splits into `red` and `green` (R2b); `still-green` and `test-fix` become each Vertex's `recover` (T4).
  `resumeGreen` and `requireTestPass` go (R2c, Q3c).
- The review's `misscoped` token becomes `blocked` with `reason: misscoped`, and the reviewer may now stop (R9c).
- `repeat` routes to `senior-dev` instead of `changes` (R4d), removing the `shortcut:` in `interpreter.mjs`.
- `changes` exhausted goes to `senior-dev`, not `needs-human`. A `needsTest` review goes back to `red`.
- `done` becomes `publish` plus `end: ready-for-qa` (R11).
- New Agent `senior`; the example Layers gain an entry for it.

## Questions for the owner

1. **A failing `ok` review no longer posts its comment.** Today, an `ok` review that fails review-pass routes as
   `changes` and still posts the review comment and PR update. Under Q3d, a failed required Check skips the remaining
   effect Actions, so with `ok: { requires: [review-pass] }` that review's findings never reach the PR. Recommendation:
   `ok: { requires: [] }` with a first `passed` row `{ claim: ok, check.review-pass: failed } → changes` (its
   `repeat` and `retest` rows ahead of it). R11d now guards publishing in `publish`, so R4b's reason for requiring it
   is gone; the cost is that a later Layer replacing the review's table could drop the row, which `gg doctor` shows
   (R10b). Otherwise keep R4b and accept the missing comment.
2. **The review's `otherwise: changes`.** It applies to the `failed` table only, since `passed` already falls to the
   token (S3). If question 1 goes as recommended, the `failed` table is never reached and both `failed` and
   `otherwise` are dropped.
3. **`publish`'s `test` failing.** It falls to `"*"` and `end: needs-human`. Routing it back to `implementer-fix` is
   possible, but a suite that passed in `green` or `fix` and fails on the same tree points at flakiness or the
   environment, which is the human's.
4. **review-pass needs three conditions in one Check.** R4a defines each `response` form (`{ field, is }`, `none`,
   `any`, `all`, `count`) as a whole Check, so review-pass (`dodMet`, `tddEvidenceOk`, no blocker or major finding)
   would be three Checks, each named in `requires` and in rules. Recommendation: a `response` Check takes `all-of: [...]`
   over those forms, passing when every condition holds; its failing output names the conditions that failed, as
   `reviewPass`'s `reasons` do today.
