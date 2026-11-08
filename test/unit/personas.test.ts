import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleLayer from '../support/example-layer.ts';

// The example's Personas, which `gg init` writes.
const persona = (name: string) => exampleLayer.fixtureText(`${name}.md`);
const properties = (...schemas: string[]) =>
  new Set(
    schemas.flatMap((name) => Object.keys(JSON.parse(exampleLayer.fixtureText(`${name}.schema.json`)).properties)),
  );
// The fields a Persona's report section asks for, one `- \`field\`` line each.
const asked = (text: string) =>
  new Map([...text.split('## Report')[1]!.matchAll(/^- `(\w+)`(.*)$/gm)].map(([, field, rest]) => [field, rest]));
// ff's personas asked for PASS and a "blocked" status; every Claim token is now lowercase (GLOSSARY.md, Verdict).
const UPPERCASE_CLAIMS = /\b(?:OK|PASS|CHANGES|REPEAT|BLOCKED|MISSCOPED)\b/;

test('the example Personas describe one stop token, blocked, with a reason from the schema (R9)', () => {
  const implementer = persona('implementer');
  const reviewer = persona('reviewer');
  assert.ok(implementer.includes('claim: ok | blocked'), implementer);
  assert.ok(reviewer.includes('claim: ok | changes | blocked'), reviewer);
  for (const text of [implementer, reviewer]) {
    assert.match(text, /`misscoped`: the ticket itself is wrong or contradictory/);
    assert.match(text, /`needs-input` or `environment`: something outside the ticket is missing/);
  }
});

test(
  "each field the example implementer Persona asks for is a field of red's or green's schema, " +
    'and it asks for each',
  () => {
    const fields = asked(persona('implementer'));
    assert.deepEqual(new Set(fields.keys()), properties('red', 'implement'));
    for (const field of ['definitionOfDone', 'qa'])
      assert.match(fields.get(field)!, /green and fix Visits only/, field);
    assert.match(fields.get('tests')!, /red Visits only/);
  },
);

test('each field the example reviewer Persona asks for is a field of the review schema, and it asks for each', () => {
  assert.deepEqual(new Set(asked(persona('reviewer')).keys()), properties('review'));
});

for (const name of ['implementer', 'reviewer']) {
  test(`the example ${name} Persona names no uppercase claim and asks for a claim, not a status`, () => {
    const text = persona(name);
    assert.doesNotMatch(text, UPPERCASE_CLAIMS);
    assert.doesNotMatch(text, /return status/);
  });

  test(`the example ${name} Persona uses the GLOSSARY terms`, () => {
    assert.doesNotMatch(persona(name), /structured result|repo commands|\bphase\b|\brounds?\b/i);
  });
}
