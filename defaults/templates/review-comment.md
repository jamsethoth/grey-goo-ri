### gg review: **{{claim}}**
_{{agent.harness}} {{agent.model}} ({{agent.effort}}), persona {{agent.persona}}@{{agent.hash}}_

{{summary}}

- Definition of done met: {{#dodMet}}yes{{/dodMet}}{{^dodMet}}no{{/dodMet}}
- TDD evidence OK: {{#tddEvidenceOk}}yes{{/tddEvidenceOk}}{{^tddEvidenceOk}}no{{/tddEvidenceOk}}

{{#findings}}
{{^first}}

{{/first}}
**{{severity}}**
{{file}}
{{issue}}
Fix:
{{fix}}
{{/findings}}
{{^findings}}
_No findings._
{{/findings}}

VERDICT: {{claim}}

{{marker}}
