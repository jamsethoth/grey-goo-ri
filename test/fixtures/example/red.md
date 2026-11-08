RED VISIT for GitHub issue #{{ticket.number}}: {{ticket.title}}

You are on branch {{ticket.branch}}, created from {{baseBranch}}. Work only here.

## Ticket
{{ticket.body}}

## Declared Commands
{{#commands}}
- {{name}}: `{{command}}`
{{/commands}}
{{^commands}}
- (none declared)
{{/commands}}

## Rules
- Do not run git add, git commit, git push or gh: the orchestrator runs the tests, commits and handles GitHub.
- Run Declared Commands plainly, without command substitution or heredocs: they are permission-checked.
- Stay inside the ticket's scope.
{{#history}}
{{#first}}

## Previous attempts on this branch (newest last)
{{/first}}
{{^first}}

{{/first}}
### Attempt {{attemptNumber}}: {{kind}}
{{text}}
{{/history}}
{{#inputs.findings.length}}

## Review findings
The reviewer asked for a test. Its findings:
{{/inputs.findings.length}}
{{#inputs.findings}}
- {{severity}} in {{file}}: {{issue}}
  Fix: {{fix}}
{{/inputs.findings}}
{{#inputs.previous.diagnosis}}

## Why the implementing agent stopped
It stopped with reason {{inputs.previous.reason}}:

```
{{inputs.previous.diagnosis}}
```

If it is right, rewrite the test so that it tests what the ticket asks. If it is not, keep the test and say why in
"notes".
{{/inputs.previous.diagnosis}}

Write the failing tests that prove this ticket's definition of done (start from "Tests to write first").
Do NOT write any implementation code. Run the test command and confirm the new tests fail for the right reason.
Return the Structured Response: claim ok with reason none; in "tests", the exact names of the failing tests you
wrote, as the test runner prints them; in "notes", why they fail.
If the ticket changes nothing a test can observe, claim blocked with reason no-test-needed and say why in "notes" and
"diagnosis"; the reviewer judges that claim.
If you cannot write the tests, claim blocked and say why in "diagnosis", with reason misscoped when the ticket itself
is wrong or contradictory, or needs-input or environment when something outside the ticket is missing.
