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
{{report}}

Check correctness, code quality and simplicity, and definition-of-done coverage. The orchestrator itself verified
that the "test:" commit's tests failed before implementation and pass now (outputs are in the report); check that
those tests actually exercise the ticket's behaviour and were not weakened afterwards.
Return claim ok only if there are no blocker or major findings, changes otherwise, or misscoped with a diagnosis
when the ticket itself cannot be met as written.