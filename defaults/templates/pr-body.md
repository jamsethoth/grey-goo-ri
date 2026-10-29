Closes #{{ticket.number}}

## Summary
{{summary}}

## Definition of done
{{#dod}}
- [{{#met}}x{{/met}}{{^met}} {{/met}}] {{item}}{{#evidence}} — {{evidence}}{{/evidence}}
{{/dod}}

## TDD evidence
**Red** (`{{red.command}}`)
{{red.output}}
{{#green}}
**Green** (`{{green.command}}`)
{{green.output}}
{{/green}}
{{^green}}
**Green**: the test command has no passing run.
{{/green}}

## QA instructions
**Setup:** {{qa.setup}}

{{#qa.steps}}
{{n}}. {{action}}
   - Expected: {{expected}}
{{/qa.steps}}

**Edge cases to try**
{{#qa.edgeCases}}
- {{.}}
{{/qa.edgeCases}}
{{^qa.edgeCases}}
_none_
{{/qa.edgeCases}}

**Covered by automated tests**
{{#qa.automated}}
- {{.}}
{{/qa.automated}}
{{^qa.automated}}
_none_
{{/qa.automated}}

**Needs human eyes**
{{#qa.manual}}
- {{.}}
{{/qa.manual}}
{{^qa.manual}}
_none_
{{/qa.manual}}

## Provenance
| Vertex | Harness | Model | Effort | Persona | Calls | Tokens in (cached) / out |
|---|---|---|---|---|---|---|
{{#provenance}}
| {{vertex}} | {{harness}} | {{model}} | {{effort}} | {{persona}}@{{hash}} | {{calls}} | {{input}} ({{cached}}) / {{output}} |
{{/provenance}}

{{marker}}
