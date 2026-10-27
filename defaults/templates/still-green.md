The orchestrator ran the test command on branch {{ticket.branch}} after your red phase and it PASSED, so your new tests do not fail yet:

```
{{output}}
```

## Repo commands
{{#commands}}
- {{name}}: `{{command}}`
{{/commands}}
{{^commands}}
- (none declared)
{{/commands}}

Write tests that fail until the ticket is implemented. Do not implement anything.
If no test can fail first, claim blocked and say why in "diagnosis".