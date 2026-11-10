### gg: Approval Request

Vertex **{{vertex}}** asks for a Decision. Add one of these labels:

{{#decideLabels}}
- `{{.}}`
{{/decideLabels}}

A human with write permission decides, or a listed Approver. A Decide Label added before this request, or by anyone else, does not count.

To answer questions, reply in one or more comments on this Ticket before you add the label, not by editing its body: an edit to the body makes this request stale. Your comments after this one become the Decision's reply.

Pending Instance: `{{id}}`
Approval Digest: `{{digest}}`
{{#replaces}}

This request replaces an earlier one, which was stale, ambiguous or no longer on the issue.
{{/replaces}}

{{marker}}
