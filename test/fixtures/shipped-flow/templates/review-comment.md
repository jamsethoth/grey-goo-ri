### gg review: **{{review.response.claim}}**
_{{agent.harness}} {{agent.model}} ({{agent.effort}}), persona {{agent.persona}}@{{agent.personaHash}}_

```
{{review.response.summary}}
```

- Definition of done met: {{#review.response.definitionOfDoneMet}}yes{{/review.response.definitionOfDoneMet}}{{^review.response.definitionOfDoneMet}}no{{/review.response.definitionOfDoneMet}}
- TDD evidence OK: {{#review.response.redGreenEvidenceOk}}yes{{/review.response.redGreenEvidenceOk}}{{^review.response.redGreenEvidenceOk}}no{{/review.response.redGreenEvidenceOk}}
{{#review.response.findings}}

**{{severity}}**
```
{{file}}
```
```
{{issue}}
```
Fix:
```
{{fix}}
```
{{/review.response.findings}}
{{^review.response.findings}}

_No findings._
{{/review.response.findings}}

VERDICT: {{review.response.claim}}

{{marker}}
