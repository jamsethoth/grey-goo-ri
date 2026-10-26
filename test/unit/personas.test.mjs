import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const persona = (name) => readFile(new URL(`../../defaults/personas/${name}.md`, import.meta.url), 'utf8');
// ff's personas asked for PASS and a "blocked" status; every Claim token is now lowercase (GLOSSARY.md, Verdict).
const UPPERCASE_CLAIMS = /\b(?:OK|PASS|CHANGES|REPEAT|BLOCKED|MISSCOPED)\b/;

test('the shipped personas use the lowercase claim vocabulary', async () => {
  const implementer = await persona('implementer');
  const reviewer = await persona('reviewer');
  assert.ok(implementer.includes('claim: ok | blocked | misscoped'), implementer);
  assert.ok(reviewer.includes('ok | changes | misscoped'), reviewer);
  for (const [name, text] of [['implementer', implementer], ['reviewer', reviewer]]) {
    assert.doesNotMatch(text, UPPERCASE_CLAIMS, `${name} names no uppercase claim`);
    assert.doesNotMatch(text, /return status/, `${name} asks for a claim, not a status`);
  }
});
