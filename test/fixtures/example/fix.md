FIX VISIT for GitHub issue #{{ticket.number}}: {{ticket.title}}

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
{{/inputs.findings.length}}
{{#inputs.findings}}
- {{severity}} in {{file}}: {{issue}}
  Fix: {{fix}}
{{/inputs.findings}}
{{#inputs.previous}}

## Work rescued from an earlier Visit
An earlier Visit's work did not pass its Checks and was kept at {{inputs.previous.ref}}:

```
{{inputs.previous.diffStat}}
```

Read it with `git diff HEAD {{inputs.previous.ref}}` and keep what is right. The output it failed with:

```
{{inputs.previous.output}}
```
{{/inputs.previous}}

The branch already holds the previous work. Address every blocker and major finding above.
If a fix changes behaviour, add or adjust a failing test first. Finish with the test command passing.
Return the Structured Response: claim ok with reason none; every definition-of-done item with evidence, QA
instructions, and notes. If you cannot, claim blocked and say why in "diagnosis", with reason misscoped when the ticket
itself is wrong or contradictory, or needs-input or environment when something outside the ticket is missing.
