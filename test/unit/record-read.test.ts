import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type * as recordJson from '../../lib/record-json.ts';
import * as recordRead from '../../lib/record-read.ts';
import * as recordReadVisit from '../../lib/record-read-visit.ts';
import type * as recordReadNode from '../../lib/record-read-node.ts';
import type * as commandCleanup from '../../lib/command-cleanup.ts';
import type * as integrity from '../../lib/integrity.ts';
import type * as visit from '../../lib/visit.ts';
import type * as sameType from '../support/same-type.ts';
import * as typeShape from '../support/type-shape.ts';

// The record types are the one declaration of a row (#402): tsc holds each reader to its type both ways, and the row's
// paths are read from the types.

type ValueOf<Reader> = Reader extends recordReadNode.Read<infer Value> ? Value : never;
const same = <First, Second>(holds: sameType.Same<First, Second>) => holds;

// Every reader the record modules export, held by tsc to the type it reads.
const READERS = {
  executionRecord: same<ValueOf<typeof recordRead.executionRecord>, recordJson.ExecutionRecordJson>(true),
  epicRecord: same<ValueOf<typeof recordRead.epicRecord>, recordJson.EpicRecordJson>(true),
  ruleIdentity: same<ValueOf<typeof recordReadVisit.ruleIdentity>, visit.RuleIdentity>(true),
  historyItem: same<ValueOf<typeof recordReadVisit.historyItem>, visit.HistoryItem>(true),
  worktreeSnapshot: same<ValueOf<typeof recordReadVisit.worktreeSnapshot>, integrity.WorktreeSnapshot>(true),
  untrackedFiles: same<ValueOf<typeof recordReadVisit.untrackedFiles>, integrity.UntrackedFiles>(true),
  integrityBaseline: same<ValueOf<typeof recordReadVisit.integrityBaseline>, integrity.IntegrityBaseline>(true),
  savedCleanup: same<ValueOf<typeof recordReadVisit.savedCleanup>, commandCleanup.SavedCleanup>(true),
  visitState: same<ValueOf<typeof recordReadVisit.visitState>, recordJson.VisitStateJson>(true),
  configurationSnapshot: same<ValueOf<typeof recordReadVisit.configurationSnapshot>, visit.ConfigurationSnapshot>(true),
  actionOutput: same<ValueOf<typeof recordReadVisit.actionOutput>, visit.ActionOutput>(true),
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Fixture {
  execution: { [key: string]: Json };
  variants: Record<string, Json[]>;
  epic: { [key: string]: Json };
}
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/record-rows.json', import.meta.url), 'utf8')) as Fixture;

const shapes = new typeShape.TypeShapes();
const EXECUTION = shapes.shapeOf('lib/record-json.ts', 'ExecutionRecordJson');
const EPIC = shapes.shapeOf('lib/record-json.ts', 'EpicRecordJson');

// The Execution Record's rows a full fixture gives: the row itself, then one row per variant at its path.
function executionRows(): Json[] {
  const rows: Json[] = [FIXTURE.execution];
  for (const [path, values] of Object.entries(FIXTURE.variants))
    for (const value of values) {
      const row = structuredClone(FIXTURE.execution);
      const segments = path.split('.');
      let parent: Json = row;
      for (const segment of segments.slice(0, -1)) parent = (parent as Record<string, Json>)[segment];
      (parent as Record<string, Json>)[segments.at(-1)!] = value;
      rows.push(row);
    }
  return rows;
}

const sorted = (lines: Iterable<string>) => [...new Set(lines)].sort();

test('every declared path is one the full fixture holds', () => {
  const held = executionRows().flatMap((row) => typeShape.paths(EXECUTION, { held: row }));
  assert.deepEqual(sorted(held), sorted(typeShape.paths(EXECUTION)), 'the Execution Record');
  assert.deepEqual(
    sorted(typeShape.paths(EPIC, { held: FIXTURE.epic })),
    sorted(typeShape.paths(EPIC)),
    'the Epic Record',
  );
});

test('every union form in the declared paths is named by its type or its tag', () => {
  const forms = [...typeShape.paths(EXECUTION), ...typeShape.paths(EPIC)].flatMap((line) =>
    [...line.split(':')[0].matchAll(/<([^>]+)>/g)].map(([, name]) => name),
  );
  assert.ok(forms.length > 20, `${forms.length} forms`);
  assert.deepEqual(sorted(forms.filter((name) => !/^(\w+\.\w+|\w+=[\w-]+|[\w[\]]+\[\])$/.test(name))), []);
});

test('every reader the record modules export has a check', () => {
  const exported = [recordRead, recordReadVisit].flatMap((module) =>
    Object.entries(module)
      .filter(([name, value]) => typeof value === 'function' && name !== 'RowFieldError')
      .map(([name]) => name),
  );
  assert.ok(exported.includes('executionRecord'), 'the readers are found');
  assert.deepEqual(Object.keys(READERS).sort(), exported.sort());
});

// A program of the repository with files' text replaced, for the type checker to judge.
function plantedProgram(rootFile: string, replaced: Record<string, string>) {
  const host = ts.createCompilerHost(typeShape.configured.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    Object.hasOwn(replaced, fileName)
      ? ts.createSourceFile(fileName, replaced[fileName], languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram([rootFile], typeShape.configured.options, host);
  return { program, file: program.getSourceFile(rootFile)! };
}
const errorLines = (program: ts.Program, file: ts.SourceFile) =>
  program
    .getSemanticDiagnostics(file)
    .map((diagnostic) => file.getLineAndCharacterOfPosition(diagnostic.start!).line + 1);

// A reader's source with each `[from, to]` replaced, each `from` a text the source holds.
function changed(file: string, ...replacements: [string, string][]) {
  const path = `${typeShape.root}${file}`;
  let text = readFileSync(path, 'utf8');
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `${file} holds ${from}`);
    text = text.replace(from, to);
  }
  return { [path]: text };
}

test('a declaration with a key its type lacks fails the type check', () => {
  const testFile = `${typeShape.root}test/unit/record-read.test.ts`;
  const { program, file } = plantedProgram(testFile, {
    // The Terminal Stop reads a key its type lacks, and the Epic Record leaves out one its type has.
    ...changed(
      'lib/record-read.ts',
      ["  held: flag(field('held')),", "  held: flag(field('held')),\n  more: 1,"],
      ["  planDecision: json(field('planDecision')),\n", ''],
    ),
  });
  const lineOf = (key: string) => file.text.split('\n').findIndex((line) => line.startsWith(`  ${key}: same<`)) + 1;
  assert.deepEqual(errorLines(program, file), [lineOf('executionRecord'), lineOf('epicRecord')]);
});

test('tsc tells a reader from its record type by a key, either way, at every object the type declares', () => {
  const objects = typeShape.objectPaths(EXECUTION);
  assert.ok(objects.length > 50, `${objects.length} objects`);
  const pathType = (segments: string[]) => `[${segments.map((segment) => `'${segment}'`).join(', ')}]`;
  const planted = `${typeShape.root}test/unit/planted-record-check.ts`;
  const lines = [
    "import type * as recordJson from '../../lib/record-json.ts';",
    "import type * as recordRead from '../../lib/record-read.ts';",
    "import type * as recordReadNode from '../../lib/record-read-node.ts';",
    "import type * as sameType from '../support/same-type.ts';",
    'type Read = typeof recordRead.executionRecord extends recordReadNode.Read<infer Value> ? Value : never;',
    'type Declared = recordJson.ExecutionRecordJson;',
    'export const unchanged: sameType.Same<Read, Declared> = true;',
    ...objects.flatMap((segments, i) => [
      `export const extra${i}: sameType.Same<sameType.KeyAddedAt<Read, ${pathType(segments)}>, Declared> = true;`,
      `export const missing${i}: sameType.Same<Read, sameType.KeyAddedAt<Declared, ${pathType(segments)}>> = true;`,
    ]),
  ];
  const { program, file } = plantedProgram(planted, { [planted]: lines.join('\n') });
  const failing = new Set(errorLines(program, file));
  const first = lines.indexOf('export const unchanged: sameType.Same<Read, Declared> = true;') + 1;
  assert.ok(!failing.has(first), 'the reader and its type are the same');
  const missed = objects.flatMap((segments, i) =>
    [first + 1 + 2 * i, first + 2 + 2 * i]
      .filter((line) => !failing.has(line))
      .map((line) => `${line % 2 === (first + 1) % 2 ? 'extra' : 'missing'} key at ${segments.join('.') || 'the row'}`),
  );
  assert.deepEqual(missed, []);
});
