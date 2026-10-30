### gg review: **{{review.response.claim}}**
_{{agent.harness}} {{agent.model}} ({{agent.effort}}), persona {{agent.persona}}@{{agent.hash}}_

```
{{review.response.summary}}
```

- Definition of done met: {{#review.response.dodMet}}yes{{/review.response.dodMet}}{{^review.response.dodMet}}no{{/review.response.dodMet}}
- TDD evidence OK: {{#review.response.tddEvidenceOk}}yes{{/review.response.tddEvidenceOk}}{{^review.response.tddEvidenceOk}}no{{/review.response.tddEvidenceOk}}
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
