Closes #{{ticket.number}}

## Summary
{{report.summary}}

## Definition of done
{{#report.dod}}
- [{{#met}}x{{/met}}{{^met}} {{/met}}] {{item}}{{#evidence}} — {{evidence}}{{/evidence}}
{{/report.dod}}

## TDD evidence
**Red** (`{{red.command}}`)
```
{{red.output}}
```
{{#green}}
**Green** (`{{green.command}}`)
```
{{green.output}}
```
{{/green}}
{{^green}}
**Green**: the test command has no passing run.
{{/green}}

## QA instructions
**Setup:** {{report.qa.setup}}

{{#report.qa.steps}}
1. {{action}}
   - Expected: {{expected}}
{{/report.qa.steps}}

**Edge cases to try**
{{#report.qa.edgeCases}}
- {{.}}
{{/report.qa.edgeCases}}
{{^report.qa.edgeCases}}
_none_
{{/report.qa.edgeCases}}

**Covered by automated tests**
{{#report.qa.automated}}
- {{.}}
{{/report.qa.automated}}
{{^report.qa.automated}}
_none_
{{/report.qa.automated}}

**Needs human eyes**
{{#report.qa.manual}}
- {{.}}
{{/report.qa.manual}}
{{^report.qa.manual}}
_none_
{{/report.qa.manual}}

## Provenance
| Vertex | Harness | Model | Effort | Persona | Calls | Tokens in (cached) / out |
|---|---|---|---|---|---|---|
{{#provenance}}
| {{vertex}} | {{harness}} | {{model}} | {{effort}} | {{persona}}@{{hash}} | {{calls}} | {{input}} ({{cached}}) / {{output}} |
{{/provenance}}

{{marker}}
