Review the change on branch {{ticket.branch}} (against {{base}}) for GitHub issue #{{ticket.number}}: {{ticket.title}}
Read-only: do not modify files.

## Ticket (includes the definition of done)
{{ticket.body}}

## Repo commands
{{#commands}}
- {{name}}: `{{command}}`
{{/commands}}
{{^commands}}
- (none declared)
{{/commands}}

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

## Red Evidence
`{{inputs.red.command}}` failed before the implementation:
```
{{inputs.red.output}}
```
{{#inputs.red.heuristic}}

The Red Check found the failing test by its name only: the runner printed no per-test statuses. Check that the test
fails for the reason the ticket gives.
{{/inputs.red.heuristic}}

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
those tests actually exercise the ticket's behaviour and were not weakened afterwards.
Return claim ok only if there are no blocker or major findings, changes otherwise, or misscoped with a diagnosis
when the ticket itself cannot be met as written.