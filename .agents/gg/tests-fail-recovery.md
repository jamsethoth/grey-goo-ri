## The tests-fail Check {{id}}
{{#failure.passed}}
The orchestrator ran the test command after your red work and your tests PASSED, so they do not fail yet:

```
{{output}}
```

Write tests that fail until the ticket is implemented. Do not implement anything.
{{/failure.passed}}
{{#failure.unchanged}}
No file under the repository's test paths changed since this Visit began, so no test was written.
Write the failing test now. If the ticket needs no test, claim blocked with reason no-test-needed and say why in
"notes" and "diagnosis".
{{/failure.unchanged}}
{{#failure.missing}}
The test command failed, but its output does not name the tests you reported:

```
{{output}}
```

In "tests", give each failing test's name exactly as the runner prints them, or make the test command run your tests.
{{/failure.missing}}
