import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Documents agents read for today's paths. An ADR or a docs/research record is dated: it names paths as they were.
const LIVING_DOCUMENTS = [
  'AGENTS.md',
  'GLOSSARY.md',
  'README.md',
  'docs/adr/0014-procedures-are-data.md',
  'docs/interfaces/harness.md',
  'docs/library-survey.md',
  'docs/requests/node-harness-dag.md',
  'docs/testing.md',
];
// A path from the repository root, so not node_modules/eslint/bin/eslint.js or another project's src/lib/x.ts.
const CODE_PATH = /(?<![\w/.-])(?:lib|bin|scripts)\/[\w/.-]*\.(?:[cm]?js|ts)\b/g;
const codePathsIn = (text: string) => [...text.matchAll(CODE_PATH)].map((match) => match[0]);

test('a living document names only code files that exist', () => {
  assert.deepEqual(
    codePathsIn('See `lib/gone.mjs:12`, bin/gg.ts. Then node_modules/eslint/bin/eslint.js, src/lib/a.ts'),
    ['lib/gone.mjs', 'bin/gg.ts'],
  );
  const named = LIVING_DOCUMENTS.flatMap((document) => codePathsIn(readFileSync(root + document, 'utf8')));
  assert.ok(named.includes('lib/paths.ts'), 'the documents are read');
  assert.deepEqual(
    named.filter((path) => !existsSync(root + path)),
    [],
    'name the file as it is today',
  );
});

// #431 amended these documents to what gg builds; each phrase is wording it replaced, which must not come back.
const AMENDED_DOCUMENTS = ['GLOSSARY.md', 'docs/adr/0014-procedures-are-data.md', 'docs/requests/node-harness-dag.md'];
const SUPERSEDED_WORDING = [
  'back edge',
  'gg init` creates the labels',
  'every terminated attempt,',
  'at action end',
  'labels the flow references missing',
  'about 10 min',
  'default about 60',
];
// Lower case, each run of whitespace one space: a rewrapped or capitalised phrase is still found.
const supersededIn = (text: string) => {
  const words = text.replace(/\s+/g, ' ').toLowerCase();
  return SUPERSEDED_WORDING.filter((phrase) => words.includes(phrase));
};

test('a superseded phrase is found across a line break and in capitals', () => {
  const rewrapped = SUPERSEDED_WORDING.map((phrase) => phrase.replaceAll(' ', '\r\n  ').toUpperCase()).join('\n');
  assert.deepEqual(supersededIn(rewrapped), SUPERSEDED_WORDING);
});

for (const document of AMENDED_DOCUMENTS) {
  test(`${document} holds no wording #431 superseded`, () => {
    assert.deepEqual(supersededIn(readFileSync(root + document, 'utf8')), []);
  });
}
