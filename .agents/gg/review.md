Review the change on branch {{ticket.branch}} (against {{baseBranch}}) for GitHub issue #{{ticket.number}}: {{ticket.title}}
Read-only: do not modify files.

## Ticket (includes the definition of done)
{{ticket.body}}

## Declared Commands
{{#commands}}
- {{name}}: `{{command}}`
{{/commands}}
{{^commands}}
- (none declared)
{{/commands}}
{{#history}}
{{#first}}

## What happened on this branch (newest last)
{{/first}}
{{^first}}

{{/first}}
### Attempt {{attemptNumber}}: {{kind}}
{{text}}
{{/history}}

## Diff
```diff
{{diff}}
```
{{#changedTestFiles.length}}

## Test files changed since the red commit
{{/changedTestFiles.length}}
{{#changedTestFiles}}
- {{.}}
{{/changedTestFiles}}

## Implementer's report
{{inputs.report}}

## The red Visit's report
Claim {{inputs.redReport.claim}}, reason {{inputs.redReport.reason}}: {{inputs.redReport.summary}}
{{inputs.redReport.notes}}

When its reason is no-test-needed, red claims the ticket needs no test, and the Red Evidence below, if any, is from an
earlier red Visit. Judge that claim: if the change needed a test, set `needsTest: true`.

## Red Evidence
{{#inputs.red}}
`{{inputs.red.command}}` failed before the implementation:
```
{{inputs.red.output}}
```
{{/inputs.red}}
{{^inputs.red}}
No failing test was committed.
{{/inputs.red}}
{{#inputs.red.foundByNameOnly}}

The Red Check found the failing test by its name only: the runner printed no per-test statuses. Check that the test
fails for the reason the ticket gives.
{{/inputs.red.foundByNameOnly}}

## Green Evidence
{{#inputs.green}}
`{{inputs.green.command}}` passed after it:
```
{{inputs.green.output}}
```
{{/inputs.green}}
{{^inputs.green}}
The test command has no passing run.
{{/inputs.green}}

Check correctness, code quality and simplicity, and definition-of-done coverage. The orchestrator itself verified
that the "test:" commit's tests failed before implementation and pass now (the evidence above); check that
those tests actually exercise the ticket's behaviour and were not weakened afterwards. That proof assumes each test is
deterministic: report as a finding any new or changed test that depends on
sleep, wall-clock time, randomness, network, test order or shared state.
Return claim ok only if there are no blocker or major findings, changes otherwise. Set `needsTest: true` when the
change needed a test that red did not write. If the review cannot go on, claim blocked and say why in "diagnosis", with
reason misscoped when the ticket itself is wrong or contradictory, or needs-input or environment when something
outside the ticket is missing.
