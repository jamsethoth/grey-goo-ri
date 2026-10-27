GREEN PHASE for GitHub issue #{{ticket.number}}: {{ticket.title}}

You are on branch {{ticket.branch}}, created from {{base}}. Work only here.

## Ticket
{{ticket.body}}

## Repo commands
{{#commands}}
- {{name}}: `{{command}}`
{{/commands}}
{{^commands}}
- (none declared)
{{/commands}}

## Rules
- Do not run git add, git commit, git push or gh: the orchestrator runs the tests, commits and handles GitHub.
- Run repo commands plainly, without command substitution or heredocs: they are permission-checked.
- Stay inside the ticket's scope.

## Committed tests
{{#testFiles}}
- {{.}}
{{/testFiles}}

The orchestrator committed these failing tests; the test command failed as expected:

```
{{redOutput}}
```

Write the smallest implementation that makes them pass and meets every definition-of-done item.
Committed tests must not be changed. If one is genuinely wrong, claim ok only if the implementation
still passes it as written, and say why in notes; otherwise claim blocked and say why in "diagnosis".
Finish with the test command passing.
Return the structured result: claim ok, blocked or misscoped; every definition-of-done item with evidence,
QA instructions, and notes. "diagnosis" is empty unless your claim is blocked or misscoped, or your persona asks for one.