import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as outcome from '../../lib/outcome.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database/index.ts';
import * as terminalReport from '../../lib/terminal-report.ts';
import * as report from '../../lib/validate/report.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import * as fullTerminalReason from '../support/full-terminal-reason.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as tempDirectory from '../support/temp-directory.ts';
import * as typeShape from '../support/type-shape.ts';

// The frozen interfaces (#23): each document in docs/interfaces/ holds its fields in fenced blocks labelled
// `text <kind>:<name>`, and each block equals what the code declares, outside the document's Reserved section.

const documentText = (name: string) =>
  readFileSync(new URL(`../../docs/interfaces/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

// Each labelled block of a document, as its lines, leaving out its Reserved section: shapes reserved for a later
// ticket are not in the code yet.
function blocks(name: string): Map<string, string[]> {
  const frozen = documentText(name).replace(/^## Reserved[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');
  const found = new Map<string, string[]>();
  for (const [, label, body] of frozen.matchAll(/^```text ([\w-]+:[\w.-]+)\n([\s\S]*?)^```$/gm)) {
    assert.ok(!found.has(label!), `${name} has one block ${label}`);
    found.set(label!, body!.split('\n').filter(Boolean));
  }
  return found;
}

const sorted = (lines: Iterable<string>) => [...lines].sort();

const shapes = new typeShape.TypeShapes(
  ts.createProgram(
    [
      'lib/record-json.ts',
      'lib/events.ts',
      'lib/validate/report.ts',
      'lib/agent-action.ts',
      'test/support/fake-harness.ts',
    ].map((file) => `${typeShape.root}${file}`),
    typeShape.configured.options,
  ),
);
const walked = (file: string, name: string) => typeShape.paths(shapes.shapeOf(file, name));

const START: record.ExecutionStart = {
  commonDir: 'C:/repo/.git',
  repository: 'o/r',
  ticket: 7,
  flow: { name: 'tdd', entry: 'red' },
  configHash: 'hash',
  run: 'run',
  worktree: 'C:/wt/7',
  branch: 'ticket/7',
  base: 'main',
};

test('record.md lists exactly the fresh execution record fields', () => {
  const documented = blocks('record.md');
  const fresh = Object.keys(record.createExecutionRecord(START)).filter((key) => key !== 'commonDir');
  assert.deepEqual(documented.get('fields:ExecutionRecord'), fresh);
  const epic = Object.keys(record.createEpicRecord({ commonDir: 'C:/repo/.git', epic: 3 })).filter(
    (key) => key !== 'commonDir',
  );
  assert.deepEqual(documented.get('fields:EpicRecord'), epic);
});

// record-read.test.ts holds the full fixture to every declared path, and each reader to its type both ways (#402).
test('saved records hold no undocumented field', () => {
  const documented = blocks('record.md');
  for (const name of ['ExecutionRecordJson', 'EpicRecordJson'])
    assert.deepEqual(sorted(documented.get(`paths:${name}`) ?? []), sorted(walked('lib/record-json.ts', name)), name);
});

const presence = (declaration: Readonly<Record<string, string>>) =>
  Object.entries(declaration).map(([field, given]) => `${field}: ${given}`);
// The Event type each Lifecycle Event type declares: run_start is RunStartEvent.
const aliasOf = (type: string) =>
  `${type.replace(/(^|_)(\w)/g, (_match, _start, letter: string) => letter.toUpperCase())}Event`;

test('events.md lists exactly the action event fields', () => {
  const documented = blocks('events.md');
  assert.deepEqual(documented.get('presence:action'), presence(events.ACTION));
  assert.deepEqual(documented.get('presence:agent'), presence(events.AGENT));
  for (const gone of ['requireTestPass', 'repeat', 'exhausted'])
    assert.ok(!Object.hasOwn(events.ACTION, gone) && !Object.hasOwn(events.AGENT, gone), `no ${gone}`);
  for (const name of ['DeterministicActionEvent', 'AgentActionEvent'])
    assert.deepEqual(sorted(documented.get(`paths:${name}`) ?? []), sorted(walked('lib/events.ts', name)), name);
});

test('events.md lists exactly each lifecycle event and its fields', () => {
  const documented = blocks('events.md');
  const types = Object.keys(events.LIFECYCLE);
  assert.ok(types.length >= 7, types.join());
  for (const [type, declaration] of Object.entries(events.LIFECYCLE)) {
    assert.deepEqual(documented.get(`presence:${type}`), presence(declaration), type);
    const alias = aliasOf(type);
    assert.deepEqual(sorted(documented.get(`paths:${alias}`) ?? []), sorted(walked('lib/events.ts', alias)), alias);
  }
  const listed = [...documented.keys()].filter((label) => label.startsWith('presence:')).map((label) => label.slice(9));
  assert.deepEqual(sorted(listed), sorted(['action', 'agent', ...types]), 'no presence block for an undeclared Event');
});

test('every Execution-scoped Event and the Execution Record name the owner', () => {
  const scoped = Object.entries(events.LIFECYCLE).filter(([, declaration]) => Object.hasOwn(declaration, 'execution'));
  assert.ok(scoped.length >= 4, scoped.map(([type]) => type).join());
  for (const [type, declaration] of [['action', events.ACTION] as const, ...scoped])
    assert.equal(new Map(Object.entries(declaration)).get('owner'), 'required', type);
  const fresh = new Map(Object.entries(record.createExecutionRecord(START)));
  assert.deepEqual(fresh.get('owner'), { kind: 'ticket', number: START.ticket });
});

const HARNESS_SHAPES = [
  ['lib/agent-action.ts', 'SentCall'],
  ['lib/run-context.ts', 'HarnessResult'],
  ['lib/visit.ts', 'HarnessFailure'],
] as const;

test('harness.md lists exactly the harness contract methods', () => {
  const documented = blocks('harness.md');
  assert.deepEqual(documented.get('list:HARNESS_METHODS'), contract.HARNESS_METHODS);
  assert.deepEqual(documented.get('list:CAPABILITY_FIELDS'), contract.CAPABILITY_FIELDS);
  assert.deepEqual(documented.get('list:USAGE_FIELDS'), contract.USAGE_FIELDS);
  const fake = Object.keys(fakeHarness.fakeHarness());
  assert.deepEqual(sorted(fake.filter((member) => !contract.HARNESS_METHODS.includes(member))), ['calls', 'cancel']);
  assert.deepEqual(documented.get('list:fake-harness-test-only'), ['calls', 'cancel']);
  assert.deepEqual(
    sorted(documented.get('paths:ScriptedResponse') ?? []),
    sorted(walked('test/support/fake-harness.ts', 'ScriptedResponse')),
  );
  // What gg passes run(call) and what it reads back: the call it builds, the Harness Result and a failure.
  for (const [file, name] of HARNESS_SHAPES)
    assert.deepEqual(sorted(documented.get(`paths:${name}`) ?? []), sorted(walked(file, name)), name);
});

test('problems.md lists exactly the Problem codes', () => {
  const documented = blocks('problems.md');
  assert.deepEqual(documented.get('list:PROBLEM_CODES'), [...report.PROBLEM_CODES]);
  assert.deepEqual(
    sorted(documented.get('paths:ProblemParams') ?? []),
    sorted(walked('lib/validate/report.ts', 'ProblemParams')),
  );
});

test('records and events carry the frozen version constants', (t) => {
  assert.equal(record.RECORD_SCHEMA_VERSION, 1);
  assert.equal(record.createExecutionRecord(START).schemaVersion, record.RECORD_SCHEMA_VERSION);
  assert.equal(record.createEpicRecord({ commonDir: 'C:/x', epic: 3 }).schemaVersion, record.RECORD_SCHEMA_VERSION);
  assert.equal(events.EVENT_SCHEMA_VERSION, 2);
  assert.equal(fakeHarness.FAKE_HARNESS_VERSION, 1);
  const directory = tempDirectory.stateDatabaseDirectory(t, 'gg-freeze-');
  events.eventLog(directory)('run_start', { run: 'r' });
  assert.deepEqual(
    eventRead.readEvents(directory).map((event) => event.schemaVersion),
    [events.EVENT_SCHEMA_VERSION],
  );
  for (const [document, constant, value] of [
    ['record.md', 'RECORD_SCHEMA_VERSION', record.RECORD_SCHEMA_VERSION],
    ['events.md', 'EVENT_SCHEMA_VERSION', events.EVENT_SCHEMA_VERSION],
    ['harness.md', 'FAKE_HARNESS_VERSION', fakeHarness.FAKE_HARNESS_VERSION],
    ['record.md', 'stateDatabase.SCHEMA_VERSION', stateDatabase.SCHEMA_VERSION],
  ] as const)
    assert.ok(documentText(document).includes(`\`${constant} = ${value}\``), `${document} names ${constant}`);
});

test('record.md lists the State Database tables, columns, indexes and version', (t) => {
  const directory = tempDirectory.stateDatabaseDirectory(t, 'gg-freeze-');
  const connection = stateDatabase.open(directory);
  const schema = connection
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type DESC, name")
    .all() as { type: string; name: string; sql: string }[];
  const version = connection.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(version.user_version, stateDatabase.SCHEMA_VERSION);
  const tables = schema.filter((row) => row.type === 'table').map((row) => row.name);
  assert.deepEqual(sorted(tables), ['check_results', 'configs', 'events', 'records']);
  assert.deepEqual(blocks('record.md').get('sql:StateDatabase'), [
    ...schema.map((row) => `${row.type} ${row.name}: ${row.sql.replace(/\s+/g, ' ')}`),
    `user_version: ${version.user_version}`,
  ]);
});

test('the Failure Class set is listed whole in record.md and events.md', () => {
  for (const document of ['record.md', 'events.md'])
    assert.deepEqual(
      sorted(blocks(document).get('list:FailureClass') ?? []),
      sorted(Object.keys(outcome.FAILURE_CLASSES)),
      document,
    );
});

// Runs the golden Execution to its end, or stopped at admission as a hold, an abandonment or a fault.
async function ended(t: TestContext, stop: Partial<interpreter.ExecutionOptions> = {}) {
  const fixture = await golden.fixture(t);
  await interpreter.runExecution({ ...fixture.options, ...stop });
  return fixture;
}
const STOPS: Record<string, Partial<interpreter.ExecutionOptions>> = {
  hold: { admission: { kind: 'hold', name: 'dirty-worktree', terminalReasonText: 'The worktree is dirty.' } },
  abandon: { admission: { kind: 'abandon', terminalReasonText: 'A human set needs-human.', inProgress: true } },
  fault: { fault: new Error('admission broke') },
};

test('every ticket_end carries a full Terminal Reason, with a rule exactly when an Outcome was decided', async (t) => {
  const end = await goldenRun.runFirstVisit(t);
  const [endReason] = fullTerminalReason.ticketEnds(end.options.record.commonDir, end.options.record.execution);
  fullTerminalReason.assertFull(endReason?.terminalReason, 'an end');
  assert.notEqual((endReason?.terminalReason as { rule: unknown }).rule, null, 'an end names its rule');
  for (const [kind, stop] of Object.entries(STOPS)) {
    const fixture = await ended(t, stop);
    const [stopped] = fullTerminalReason.ticketEnds(fixture.options.record.commonDir, fixture.options.record.execution);
    fullTerminalReason.assertFull(stopped?.terminalReason, kind);
    const reason = stopped?.terminalReason as { rule: unknown; decidedBy: Record<string, unknown> };
    assert.equal(reason.rule, null, `a ${kind} decides no rule`);
    if (kind === 'abandon') {
      assert.equal(typeof reason.decidedBy.label, 'string', 'an abandonment is decided by its State Label');
      assert.ok(!Object.hasOwn(reason.decidedBy, 'human'), 'human names a login only');
    }
  }
});

test('reporting Actions carry their <report>-<effect> ids', async (t) => {
  const documented = blocks('events.md').get('list:report-actions') ?? [];
  assert.deepEqual(sorted(documented), [
    'abandon-label',
    'end-comment',
    'end-epic-comment',
    'end-label',
    'fault-comment',
    'fault-label',
    'hold-comment',
    'hold-label',
    'resolve-close',
    'resolve-comment',
    'resolve-label',
  ]);
  const flags = { end: {}, hold: { held: true }, abandon: { abandoned: true }, fault: { error: 'broke' } };
  // gg work done's resolve Actions are checked where it runs (test/unit/work.test.ts).
  for (const id of documented.filter((name) => !name.startsWith('resolve-'))) {
    const [, report, effect] = /^(\w+)-(.+)$/.exec(id)!;
    const flagged = new Map(Object.entries(flags)).get(report!);
    assert.equal(terminalReport.terminalActionIdentity('needs-human', flagged)(effect!).action, id, id);
  }
  const observed = new Set<string>();
  for (const stop of [{}, ...Object.values(STOPS)]) {
    const fixture = await ended(t, stop);
    for (const event of fixture.readEvents())
      if (event.type === 'action' && /^(end|hold|fault|abandon)-/.test(event.action)) observed.add(event.action);
  }
  for (const id of observed) assert.ok(documented.includes(id), `${id} is documented`);
});

test('AGENTS.md declares the frozen interfaces and the rule that changes one', () => {
  const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  const section = /^## Frozen interfaces\n([\s\S]*?)(?=^## )/m.exec(agents)?.[1] ?? '';
  for (const document of ['harness.md', 'record.md', 'events.md', 'problems.md'])
    assert.ok(section.includes(`docs/interfaces/${document}`), document);
  assert.match(section, /new ADR/);
  assert.match(section, /version/);
});
