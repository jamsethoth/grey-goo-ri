import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as checks from '../../lib/checks.ts';
import * as events from '../../lib/events.ts';
import * as exampleLayer from '../support/example-layer.ts';
import { fakeGit } from '../support/fake-git.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// A row of the events table.
interface EventRow {
  id: number;
  ts: string;
  type: string;
  run: string | null;
  execution: string | null;
  ticket: number | null;
  json: string;
}

// Reads the events table directly, as another SQLite client would.
function rows(commonDir: string): EventRow[] {
  const db = new DatabaseSync(join(commonDir, 'gg', 'gg.db'));
  try {
    return db
      .prepare('SELECT id, ts, type, run, execution, ticket, json FROM events ORDER BY id')
      .all()
      .map((row) => ({ ...row }) as unknown as EventRow);
  } finally {
    db.close();
  }
}

const usage = () => ({ peakContextTokens: 1200, turns: 3, toolCalls: 4, compactions: 0, costUsd: null });

const actionFields = () => ({
  flow: 'default',
  configHash: 'c0ffee',
  launchProfile: null,
  confinement: null,
  ticket: 7,
  run: 'r1',
  execution: 'e1',
  vertex: 'implement',
  visit: 1,
  procedure: 'tdd',
  action: 'red',
  recovery: 0,
  attempt: 1,
  durationMs: 1500,
  outcome: 'ok',
  direction: 'forward',
  signals: [],
  rule: 'red-ok',
  agent: true,
  harness: 'fake',
  agentCliVersion: null,
  model: 'fake-model',
  effort: 'medium',
  personaHash: 'p1',
  tools: ['Read'],
  sessionInit: null,
  sessionId: 's1',
  sessionLineage: [],
  transcriptPath: null,
  usage: { cumulative: usage(), delta: usage() },
  exitCode: 0,
  exitSignal: null,
  finalEventSubtype: 'success',
  permissionDenials: [],
  commandsRun: [],
  failureClass: null,
});

const required = [
  'flow',
  'configHash',
  'launchProfile',
  'confinement',
  'ticket',
  'run',
  'execution',
  'vertex',
  'visit',
  'procedure',
  'action',
  'recovery',
  'attempt',
  'durationMs',
  'outcome',
  'direction',
  'signals',
  'rule',
];
const agentRequired = [
  'harness',
  'agentCliVersion',
  'model',
  'effort',
  'personaHash',
  'tools',
  'sessionInit',
  'sessionId',
  'sessionLineage',
  'transcriptPath',
  'usage',
  'exitCode',
  'exitSignal',
  'finalEventSubtype',
  'permissionDenials',
  'commandsRun',
];

// The keys of a persisted Action Event, in the order it is written.
const ACTION_EVENT_KEYS = [
  'schemaVersion',
  'time',
  'type',
  'flow',
  'configHash',
  'launchProfile',
  'confinement',
  'ticket',
  'run',
  'execution',
  'vertex',
  'visit',
  'procedure',
  'action',
  'recovery',
  'attempt',
  'durationMs',
  'outcome',
  'direction',
  'signals',
  'rule',
  'agent',
  'harness',
  'agentCliVersion',
  'model',
  'effort',
  'personaHash',
  'tools',
  'sessionInit',
  'sessionId',
  'sessionLineage',
  'transcriptPath',
  'usage',
  'exitCode',
  'exitSignal',
  'finalEventSubtype',
  'permissionDenials',
  'commandsRun',
  'check',
  'integrityViolations',
  'retryAfterMs',
  'failureClass',
  'error',
  'cleanup',
  'decision',
];

test('an action event carries schema version 2 and every required field', (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-events-');
  const log = events.eventLog(directory, { run: 'r1' });
  const event = events.actionEvent(actionFields());
  log(event.type, event);
  log('run_end', events.lifecycleEvent('run_end', { run: 'r1' }));
  const lines = rows(directory).map((row) => row.json);
  assert.deepEqual(
    lines.map((line) => line.slice(0, 18)),
    ['{"schemaVersion":2', '{"schemaVersion":2'],
  );
  const back = JSON.parse(lines[0]);
  assert.equal(back.schemaVersion, 2);
  assert.equal(back.type, 'action');
  assert.equal(typeof back.time, 'string');
  assert.deepEqual(Object.keys(back), ACTION_EVENT_KEYS);
  assert.equal(back.launchProfile, null);
  assert.equal(back.confinement, null);
  assert.deepEqual(back.usage, { cumulative: usage(), delta: usage() });
  assert.deepEqual(
    events.readEvents(directory).map((event) => event.type),
    ['action', 'run_end'],
  );
});

for (const key of [...required, ...agentRequired]) {
  test(`actionEvent throws naming a missing required field: ${key}`, () => {
    const fields: Record<string, unknown> = actionFields();
    delete fields[key];
    assert.throws(() => events.actionEvent(fields), new RegExp(`\\b${key}\\b`));
  });
}

test('actionEvent needs none of the agent fields when agent is false', () => {
  const check = Object.fromEntries(Object.entries(actionFields()).filter(([key]) => required.includes(key)));
  assert.equal(events.actionEvent({ ...check, agent: false }).type, 'action');
});

test('actionEvent rejects an unknown key', () => {
  assert.throws(() => events.actionEvent({ ...actionFields(), tokensIn: 5 }), /\btokensIn\b/);
});

const optional = {
  check: 'red',
  integrityViolations: [],
  retryAfterMs: 1000,
  failureClass: 'auth',
  error: 'boom',
};
for (const [key, value] of Object.entries(optional)) {
  test(`actionEvent accepts the optional key ${key}`, () => {
    const event: Record<string, unknown> = events.actionEvent({ ...actionFields(), [key]: value });
    assert.equal(event[key], value);
  });
}

test('actionEvent accepts every optional key together', () => {
  const { check, integrityViolations, retryAfterMs, failureClass, error } = events.actionEvent({
    ...actionFields(),
    ...optional,
  });
  assert.deepEqual({ check, integrityViolations, retryAfterMs, failureClass, error }, optional);
});

test('an Event carries schemaVersion and time', (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-events-');
  events.eventLog(directory, { run: 'r1' })('run_start');
  const [event] = events.readEvents(directory);
  assert.deepEqual(Object.keys(event), ['schemaVersion', 'time', 'type', 'run']);
  assert.equal(event.schemaVersion, 2);
  assert.ok(!Number.isNaN(Date.parse(event.time)), event.time);
});

const OPTIONAL_KEYS = ['check', 'integrityViolations', 'retryAfterMs', 'failureClass', 'error', 'cleanup', 'decision'];

test('an agent Action Event declares every field, null where it was not given', () => {
  const event: Record<string, unknown> = events.actionEvent(actionFields());
  assert.deepEqual(Object.keys(event), ['type', ...required, 'agent', ...agentRequired, ...OPTIONAL_KEYS]);
  assert.deepEqual(
    OPTIONAL_KEYS.map((key) => event[key]),
    [null, null, null, null, null, null, null],
  );
});

test('a deterministic Action Event declares every field of its shape', () => {
  const check = Object.fromEntries(Object.entries(actionFields()).filter(([key]) => required.includes(key)));
  const event: Record<string, unknown> = events.actionEvent(check);
  assert.deepEqual(Object.keys(event), ['type', ...required, 'agent', ...OPTIONAL_KEYS]);
  assert.deepEqual(
    ['agent', ...OPTIONAL_KEYS].map((key) => event[key]),
    [false, null, null, null, null, null, null, null],
  );
});

test('a deterministic Action Event carries failureClass, null unless the Action failed', () => {
  const deterministic = Object.fromEntries(Object.entries(actionFields()).filter(([key]) => required.includes(key)));
  const done = events.actionEvent(deterministic);
  assert.ok(Object.hasOwn(done, 'failureClass'), 'declared on every Action Event');
  assert.equal(done.failureClass, null);
  const failed = events.actionEvent({
    ...deterministic,
    outcome: 'run-stop',
    failureClass: 'auth',
    error: 'git push exited 128',
  });
  assert.deepEqual([failed.failureClass, failed.error], ['auth', 'git push exited 128']);
});

test('a Lifecycle Event declares every field of its type, null where it was not given', () => {
  const exact = (actual: object, expected: object) => {
    assert.deepEqual(actual, expected);
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
  };
  exact(events.lifecycleEvent('run_end', { run: 'r1' }), {
    type: 'run_end',
    run: 'r1',
    tickets: null,
    failureClass: null,
  });
  exact(events.lifecycleEvent('ticket_end', { run: 'r1', execution: 'e1', ticket: 7 }), {
    type: 'ticket_end',
    run: 'r1',
    execution: 'e1',
    ticket: 7,
    outcome: null,
    diffStats: null,
    terminalReason: null,
    error: null,
    interrupted: null,
  });
  exact(events.lifecycleEvent('label_failed', { ticket: 7, change: { add: ['x'], remove: [] }, error: 'gh 502' }), {
    type: 'label_failed',
    ticket: 7,
    change: { add: ['x'], remove: [] },
    error: 'gh 502',
    run: null,
  });
  assert.throws(
    () => events.lifecycleEvent('ticket_end', { run: 'r1', execution: 'e1', ticket: 7, reason: {} }),
    /\breason\b/,
  );
});

test('a visit_end event holds exactly its declared fields', () => {
  const fields = {
    run: 'r1',
    execution: 'e1',
    ticket: 7,
    vertex: 'reviewer',
    visit: 2,
    outcome: 'repeat',
    rule: { table: 'passed', row: 1 },
    next: 'senior-dev',
    edge: 'reviewer->senior-dev:repeat',
    count: 1,
    spent: [{ edge: 'reviewer->implementer-fix:changes' }, { vertex: 'implementer-fix' }],
  };
  const visitEnd = events.lifecycleEvent('visit_end', fields);
  assert.deepEqual(visitEnd, { type: 'visit_end', ...fields });
  assert.deepEqual(Object.keys(visitEnd), ['type', ...Object.keys(fields)]);
  assert.throws(() => events.lifecycleEvent('visit_end', { ...fields, edge: undefined }), /\bedge\b/);
  assert.throws(() => events.lifecycleEvent('visit_end', { ...fields, owner: null }), /\bowner\b/);
});

for (const key of [...required, ...agentRequired]) {
  test(`actionEvent throws when a required field is undefined: ${key}`, () => {
    assert.throws(() => events.actionEvent({ ...actionFields(), [key]: undefined }), new RegExp(`\\b${key}\\b`));
  });
}

const BAD_USAGE: [string, unknown][] = [
  ['null', null],
  ['an empty object', {}],
  ['no delta', { cumulative: usage() }],
  ['no cumulative', { delta: usage() }],
  ['an empty cumulative', { cumulative: {}, delta: usage() }],
  ['a null delta', { cumulative: usage(), delta: null }],
  ['a string count', { cumulative: usage(), delta: { ...usage(), turns: '3' } }],
  [
    'a cumulative without peakContextTokens',
    { cumulative: { turns: 3, toolCalls: 4, compactions: 0, costUsd: null }, delta: usage() },
  ],
];
for (const [name, value] of BAD_USAGE) {
  test(`actionEvent rejects an agent action's Usage with ${name}`, () => {
    assert.throws(() => events.actionEvent({ ...actionFields(), usage: value }), /\busage\b/);
  });
}

test('actionEvent accepts Usage members whose counts are all null', () => {
  const nulls = { peakContextTokens: null, turns: null, toolCalls: null, compactions: null, costUsd: null };
  assert.equal(events.actionEvent({ ...actionFields(), usage: { cumulative: nulls, delta: nulls } }).type, 'action');
});

test('eventLog validates every event before appending it', (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-events-');
  const log = events.eventLog(directory);
  assert.throws(() => log('action', {}), /\bflow\b/);
  assert.throws(() => log('stage_call' as events.LifecycleType, { run: 'r1' }), /\bstage_call\b/);
  assert.throws(() => log('run_start', { run: 'r1', schemaVersion: 1 }), /\bschemaVersion\b/);
  assert.throws(() => log('run_start', { run: 'r1', time: 'then' }), /\btime\b/);
  assert.throws(() => log('run_start', { run: 'r1', type: 'run_end' }), /\btype\b/);
  assert.throws(() => events.eventLog(directory, { time: 'then' })('run_start', { run: 'r1' }), /\btime\b/);
  assert.deepEqual(events.readEvents(directory), []);
  events.eventLog(directory, { run: 'r1' })('run_start');
  const [row] = rows(directory);
  const back = JSON.parse(row.json);
  assert.equal(back.schemaVersion, 2);
  assert.equal(back.type, 'run_start');
  assert.equal(back.run, 'r1');
});

test('lifecycle events validate their required fields per type', () => {
  assert.equal(events.lifecycleEvent('run_start', { run: 'r1' }).type, 'run_start');
  assert.throws(() => events.lifecycleEvent('run_end', {}), /\brun\b/);
  assert.equal(events.lifecycleEvent('run_end', { run: 'r1', tickets: [], failureClass: 'auth' }).failureClass, 'auth');
  assert.equal(events.lifecycleEvent('ticket_start', { run: 'r1', execution: 'e1', ticket: 7 }).type, 'ticket_start');
  assert.throws(() => events.lifecycleEvent('ticket_end', { run: 'r1', ticket: 7 }), /\bexecution\b/);
  assert.equal(
    events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready', error: 'gh 502' }).type,
    'label_failed',
  );
  assert.equal(
    events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready', error: 'gh 502', run: 'r1' }).run,
    'r1',
  );
  assert.throws(() => events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready' }), /\berror\b/);
  assert.throws(() => events.lifecycleEvent('run_start', { run: 'r1', extra: 1 }), /\bextra\b/);
  assert.throws(() => events.lifecycleEvent('stage_call' as events.LifecycleType, { run: 'r1' }), /\bstage_call\b/);
});

// A type named after an Object member is no lifecycle type, though LIFECYCLE[type] finds something for it.
for (const type of ['toString', 'constructor', '__proto__']) {
  test(`lifecycleEvent refuses the type ${type}, which only Object.prototype defines`, () => {
    assert.throws(
      () => events.lifecycleEvent(type as events.LifecycleType, { run: 'r1' }),
      new RegExp(`unknown lifecycle event type ${type}`),
    );
  });
}

test('eventLog appends a row with the identity columns and the full event', (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-events-');
  events.eventLog(directory, { run: 'r1' })('ticket_start', { execution: 'e1', ticket: 7 });
  assert.deepEqual(
    readdirSync(join(directory, 'gg')).filter((name) => !name.startsWith('gg.db') && name !== 'locks'),
    [],
    'only the State Database and its open lock are written',
  );
  const [row, ...rest] = rows(directory);
  assert.equal(rest.length, 0);
  const event = JSON.parse(row.json);
  assert.deepEqual(event, {
    schemaVersion: 2,
    time: event.time,
    type: 'ticket_start',
    run: 'r1',
    execution: 'e1',
    ticket: 7,
  });
  assert.deepEqual(
    { ts: row.ts, type: row.type, run: row.run, execution: row.execution, ticket: row.ticket },
    { ts: event.time, type: 'ticket_start', run: 'r1', execution: 'e1', ticket: 7 },
  );

  events.eventLog(directory)('label_failed', { ticket: 8, change: 'add gg:ready', error: 'gh 502' });
  const absent = rows(directory)[1];
  assert.deepEqual([absent.type, absent.run, absent.execution, absent.ticket], ['label_failed', null, null, 8]);
});

test('readEvents returns events in insertion order', (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-events-');
  const log = events.eventLog(directory, { run: 'r1' });
  log('run_start');
  log('ticket_start', { execution: 'e1', ticket: 7 });
  log('action', events.actionEvent(actionFields()));
  log('action', events.actionEvent({ ...actionFields(), recovery: 1 }));
  log('ticket_end', { execution: 'e1', ticket: 7, outcome: 'ready-for-qa' });
  log('run_end');
  const read = events.readEvents(directory);
  assert.deepEqual(
    read.map((event) => [event.type, (event as { recovery?: number }).recovery ?? null]),
    [
      ['run_start', null],
      ['ticket_start', null],
      ['action', 0],
      ['action', 1],
      ['ticket_end', null],
      ['run_end', null],
    ],
  );
  assert.deepEqual(
    read,
    rows(directory).map((row) => JSON.parse(row.json)),
  );
});

test('hasTicketEnd finds only the ticket_end of the named Execution', (t) => {
  const directory = tempDirectory.tempDirectory(t, 'gg-events-');
  const log = events.eventLog(directory, { run: 'r1' });
  log('ticket_start', { execution: '7.aaa', ticket: 7 });
  log('run_end');
  assert.equal(events.hasTicketEnd(directory, '7.aaa'), false, 'a run_end is no ticket_end');
  log('ticket_end', { execution: '7.bbb', ticket: 7, outcome: 'needs-human' });
  assert.equal(events.hasTicketEnd(directory, '7.aaa'), false, "another Execution's end of the same Ticket");
  assert.equal(events.hasTicketEnd(directory, '7.bbb'), true);
});

test('readEvents on a fresh directory returns nothing', (t) => {
  assert.deepEqual(events.readEvents(tempDirectory.tempDirectory(t, 'gg-events-')), []);
});

test('diffStats splits test and non-test insertions', () => {
  const stats = events.diffStats(
    [
      { path: 'src/cart.mjs', insertions: 3, deletions: 1 },
      { path: 'test/cart.test.mjs', insertions: 10, deletions: 0 },
      { path: 'src/util.spec.ts', insertions: 2, deletions: 2 },
      { path: 'img.png', insertions: null, deletions: null },
    ],
    exampleLayer.TEST_GLOBS,
  );
  assert.deepEqual(stats, { files: 4, insertions: 15, deletions: 3, testFiles: 2, testInsertions: 12 });
});

// Each path is one that either the old stats regex or the default globs took for a test, and the other did not, or a
// control; case differs only in the directory or extension, so a case-insensitive disk keeps every path apart.
test('diffStats counts exactly the files Test Immutability treats as tests', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-events-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakeGit();
  const { mainRoot, base } = fake.init(root);
  const add = (path: string) => {
    mkdirSync(dirname(join(mainRoot, path)), { recursive: true });
    writeFileSync(join(mainRoot, path), 'x\n');
  };
  add('test/b.mjs');
  add('Tests/a.mjs');
  add('src/a.TEST.mjs');
  add('spec/c.mjs');
  add('fixtures/x.json');
  add('lib/x.mjs');
  const immutability = await checks.testImmutability(mainRoot, base, {
    globs: exampleLayer.TEST_GLOBS,
    git: fake.git,
  });
  const stats = events.diffStats(
    [
      { path: 'test/b.mjs', insertions: 1, deletions: 0 },
      { path: 'Tests/a.mjs', insertions: 2, deletions: 0 },
      { path: 'src/a.TEST.mjs', insertions: 4, deletions: 0 },
      { path: 'spec/c.mjs', insertions: 8, deletions: 0 },
      { path: 'fixtures/x.json', insertions: 16, deletions: 0 },
      { path: 'lib/x.mjs', insertions: 32, deletions: 0 },
    ],
    exampleLayer.TEST_GLOBS,
  );

  assert.deepEqual(immutability.changed, ['Tests/a.mjs', 'fixtures/x.json', 'src/a.TEST.mjs', 'test/b.mjs']);
  assert.deepEqual(stats, { files: 6, insertions: 63, deletions: 0, testFiles: 4, testInsertions: 23 });
});

test('diffStats counts a declared test path outside the default globs', () => {
  const stats = events.diffStats(
    [
      { path: 'e2e/cart.mjs', insertions: 5, deletions: 0 },
      { path: 'lib/cart.mjs', insertions: 1, deletions: 0 },
    ],
    ['e2e/**'],
  );
  assert.deepEqual(stats, { files: 2, insertions: 6, deletions: 0, testFiles: 1, testInsertions: 5 });
});
