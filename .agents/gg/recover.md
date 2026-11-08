The orchestrator ran your work's Checks on branch {{ticket.branch}}, and these failed:
{{#sections}}

{{.}}
{{/sections}}

## Declared Commands
{{#commands}}
- {{name}}: `{{command}}`
{{/commands}}
{{^commands}}
- (none declared)
{{/commands}}

Fix what each section asks, then return the Structured Response again; every Check runs again.
If you cannot, claim blocked and say why in "diagnosis".
