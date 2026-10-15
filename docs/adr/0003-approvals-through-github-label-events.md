---
status: accepted
date: 2026-10-15
---

# Human approvals are read from GitHub label events, never from comment text

An approval must be something gg can trust after a crash and that a later edit cannot forge. GitHub issue and pull request comments are editable by their author, so they cannot carry the control. Issue timeline events are read-only through the API and record actor, time and label. We therefore make the only approval flow a label event: gg applies a namespaced await label to request a decision, a human applies a namespaced decide label to answer, and gg verifies the decide event's order after the request, the actor's repository permission, and a digest of what was approved before routing. gg never applies a decide label; it only removes them to retire or consume a request.

## Considered options

- Local approval through a gg command only. Rejected: it loses every approve-from-GitHub path, including the mobile app, and ties approval to one machine.
- Pull request reviews. Not chosen as the mechanism: they bind to a commit and cannot be edited into another state, which is good, but plan approval has no pull request, and one mechanism for both cases is simpler. They remain a human convention.
- Signed git tags or notes. Deferred: strong binding, but needs a signing key and has no object to attach to for plans.

## Consequences

Labels are namespaced into three families, state, await and decide, with a configurable prefix. Anyone with triage permission can add a label, so gg checks the actor's permission and ignores decisions from below write. A lost local record costs one re-request, never a wrong approval.
