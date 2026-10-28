The orchestrator ran the test command on branch {{ticket.branch}} after your work and it FAILED:

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

Make the test command pass.
Committed tests must not be changed. If one is genuinely wrong, claim ok only if the implementation
still passes it as written, and say why in notes; otherwise claim blocked and say why in "diagnosis".