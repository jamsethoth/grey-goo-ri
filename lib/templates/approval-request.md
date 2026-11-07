### gg: Approval Request

Vertex **{{vertex}}** asks for a Decision. Add one of these labels:

{{#decideLabels}}
- `{{.}}`
{{/decideLabels}}

A human with write permission decides, or a listed Approver. A Decide Label added before this request, or by anyone else, does not count.

Pending Instance: `{{id}}`
Approval Digest: `{{digest}}`
{{#replaces}}

This request replaces an earlier one, which was stale, ambiguous or no longer on the issue.
{{/replaces}}

{{marker}}
