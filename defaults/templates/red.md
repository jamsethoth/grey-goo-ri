RED PHASE for GitHub issue #{{ticket.number}}: {{ticket.title}}

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
{{#history}}
{{#first}}

## Previous attempts on this branch (newest last)
{{/first}}
{{^first}}

{{/first}}
### Attempt {{n}}: {{kind}}
{{text}}
{{/history}}

Write the failing tests that prove this ticket's definition of done (start from "Tests to write first").
Do NOT write any implementation code yet. Run the test command and confirm the new tests fail for the right reason.
Return the structured result: claim ok, blocked or misscoped; in "tests", the exact names of the failing tests you
wrote, as the test runner prints them; and why they fail. "diagnosis" is empty unless your claim is blocked or misscoped.