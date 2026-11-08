The orchestrator ran your work's Checks on branch {{ticket.branch}}, and these failed:
{{#sections}}

{{.}}
{{/sections}}

## Repo commands
{{#commands}}
- {{name}}: `{{command}}`
{{/commands}}
{{^commands}}
- (none declared)
{{/commands}}

Fix what each section asks, then return the structured result again; every Check runs again.
If you cannot, claim blocked and say why in "diagnosis".
