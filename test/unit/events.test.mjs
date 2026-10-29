import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as checks from '../../lib/checks.mjs';
import * as events from '../../lib/events.mjs';
import * as record from '../../lib/record.mjs';
import { fakeGit } from '../support/fake-git.mjs';

// The State Database is closed before the directory is removed, as Windows requires.
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-events-'));
  t.after(() => {
    record.close(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Reads the events table directly, as another SQLite client would.
function rows(commonDir) {
  const db = new DatabaseSync(join(commonDir, 'gg', 'gg.db'));
  try {
    return db.prepare('SELECT id, ts, type, run, execution, ticket, json FROM events ORDER BY id').all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

const usage = () => ({ peakContext: 1200, turns: 3, toolCalls: 4, compactions: 0, costUsd: null });

const actionFields = () => ({
  flow: 'default', configHash: 'c0ffee', launchProfile: null, confinement: null,
  ticket: 7, run: 'r1', execution: 'e1', vertex: 'implement', visit: 1, procedure: 'tdd', action: 'red',
  recovery: 0, attempt: 1, durationMs: 1500, outcome: 'ok', direction: 'forward', signals: [], rule: 'red-ok',
  agent: true,
  harness: 'fake', cliVersion: null, model: 'fake-model', effort: 'medium', personaHash: 'p1', tools: ['Read'],
  init: null, sessionId: 's1', lineage: [], transcriptPath: null,
  usage: { cumulative: usage(), delta: usage() },
  exitCode: 0, signal: null, finalEventSubtype: 'success', permissionDenials: [], commandsRun: [], failureClass: null,
});

const required = [
  'flow', 'configHash', 'launchProfile', 'confinement', 'ticket', 'run', 'execution', 'vertex', 'visit',
  'procedure', 'action', 'recovery', 'attempt', 'durationMs', 'outcome', 'direction', 'signals', 'rule',
];
const agentRequired = [
  'harness', 'cliVersion', 'model', 'effort', 'personaHash', 'tools', 'init', 'sessionId', 'lineage',
  'transcriptPath', 'usage', 'exitCode', 'signal', 'finalEventSubtype', 'permissionDenials', 'commandsRun',
  'failureClass',
];

test('an action event carries schema 2 and every required field', (t) => {
  const dir = tempDir(t);
  const log = events.eventLog(dir, { run: 'r1' });
  const event = events.actionEvent(actionFields());
  log(event.type, event);
  log('run_end', events.lifecycleEvent('run_end', { run: 'r1' }));
  const lines = rows(dir).map((row) => row.json);
  assert.deepEqual(lines.map((line) => line.slice(0, 11)), ['{"schema":2', '{"schema":2']);
  const back = JSON.parse(lines[0]);
  assert.equal(back.schema, 2);
  assert.equal(back.type, 'action');
  assert.equal(typeof back.ts, 'string');
  assert.deepEqual(Object.keys(back), [
    'schema', 'ts', 'type', 'run', 'flow', 'configHash', 'launchProfile', 'confinement', 'ticket', 'execution', 'vertex',
    'visit', 'procedure', 'action', 'recovery', 'attempt', 'durationMs', 'outcome', 'direction', 'signals', 'rule', 'agent',
    'harness', 'cliVersion', 'model', 'effort', 'personaHash', 'tools', 'init', 'sessionId', 'lineage', 'transcriptPath',
    'usage', 'exitCode', 'signal', 'finalEventSubtype', 'permissionDenials', 'commandsRun', 'failureClass',
  ]);
  assert.equal(back.launchProfile, null);
  assert.equal(back.confinement, null);
  assert.deepEqual(back.usage, { cumulative: usage(), delta: usage() });
  assert.deepEqual(events.readEvents(dir).map((e) => e.type), ['action', 'run_end']);
});

for (const key of [...required, ...agentRequired]) {
  test(`actionEvent throws naming a missing required field: ${key}`, () => {
    const fields = actionFields();
    delete fields[key];
    assert.throws(() => events.actionEvent(fields), new RegExp(`\\b${key}\\b`));
  });
}

test('actionEvent needs none of the agent fields when agent is false', () => {
  const check = Object.fromEntries(Object.entries(actionFields()).filter(([k]) => required.includes(k)));
  assert.equal(events.actionEvent({ ...check, agent: false }).type, 'action');
});

test('actionEvent rejects an unknown key', () => {
  assert.throws(() => events.actionEvent({ ...actionFields(), tokensIn: 5 }), /\btokensIn\b/);
});

const optional = {
  check: 'red', violations: [], requireTestPass: true, repeat: 2, exhausted: false, retryAfterMs: 1000, error: 'boom',
};
for (const [key, value] of Object.entries(optional)) {
  test(`actionEvent accepts the optional key ${key}`, () => {
    assert.equal(events.actionEvent({ ...actionFields(), [key]: value })[key], value);
  });
}

test('actionEvent accepts every optional key together', () => {
  const { check, violations, requireTestPass, repeat, exhausted, retryAfterMs, error } = events.actionEvent({ ...actionFields(), ...optional });
  assert.deepEqual({ check, violations, requireTestPass, repeat, exhausted, retryAfterMs, error }, optional);
});

for (const key of [...required, ...agentRequired]) {
  test(`actionEvent throws when a required field is undefined: ${key}`, () => {
    assert.throws(() => events.actionEvent({ ...actionFields(), [key]: undefined }), new RegExp(`\\b${key}\\b`));
  });
}

const BAD_USAGE = [
  ['null', null],
  ['an empty object', {}],
  ['no delta', { cumulative: usage() }],
  ['no cumulative', { delta: usage() }],
  ['an empty cumulative', { cumulative: {}, delta: usage() }],
  ['a null delta', { cumulative: usage(), delta: null }],
  ['a string count', { cumulative: usage(), delta: { ...usage(), turns: '3' } }],
  ['a cumulative without peakContext', { cumulative: { turns: 3, toolCalls: 4, compactions: 0, costUsd: null }, delta: usage() }],
];
for (const [name, value] of BAD_USAGE) {
  test(`actionEvent rejects an agent action's Usage with ${name}`, () => {
    assert.throws(() => events.actionEvent({ ...actionFields(), usage: value }), /\busage\b/);
  });
}

test('actionEvent accepts Usage members whose counts are all null', () => {
  const nulls = { peakContext: null, turns: null, toolCalls: null, compactions: null, costUsd: null };
  assert.equal(events.actionEvent({ ...actionFields(), usage: { cumulative: nulls, delta: nulls } }).type, 'action');
});

test('eventLog validates every event before appending it', (t) => {
  const dir = tempDir(t);
  const log = events.eventLog(dir);
  assert.throws(() => log('action', {}), /\bflow\b/);
  assert.throws(() => log('stage_call', { run: 'r1' }), /\bstage_call\b/);
  assert.throws(() => log('run_start', { run: 'r1', schema: 1 }), /\bschema\b/);
  assert.throws(() => log('run_start', { run: 'r1', ts: 'then' }), /\bts\b/);
  assert.throws(() => log('run_start', { run: 'r1', type: 'run_end' }), /\btype\b/);
  assert.throws(() => events.eventLog(dir, { ts: 'then' })('run_start', { run: 'r1' }), /\bts\b/);
  assert.deepEqual(events.readEvents(dir), []);
  events.eventLog(dir, { run: 'r1' })('run_start');
  const [row] = rows(dir);
  const back = JSON.parse(row.json);
  assert.equal(back.schema, 2);
  assert.equal(back.type, 'run_start');
  assert.equal(back.run, 'r1');
});

test('lifecycle events validate their required fields per type', () => {
  assert.equal(events.lifecycleEvent('run_start', { run: 'r1' }).type, 'run_start');
  assert.throws(() => events.lifecycleEvent('run_end', {}), /\brun\b/);
  assert.equal(events.lifecycleEvent('run_end', { run: 'r1', tickets: [], failureClass: 'auth' }).failureClass, 'auth');
  assert.equal(events.lifecycleEvent('ticket_start', { run: 'r1', execution: 'e1', ticket: 7 }).type, 'ticket_start');
  assert.throws(() => events.lifecycleEvent('ticket_end', { run: 'r1', ticket: 7 }), /\bexecution\b/);
  assert.equal(events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready', error: 'gh 502' }).type, 'label_failed');
  assert.equal(
    events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready', error: 'gh 502', run: 'r1' }).run, 'r1');
  assert.throws(() => events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready' }), /\berror\b/);
  assert.throws(() => events.lifecycleEvent('run_start', { run: 'r1', extra: 1 }), /\bextra\b/);
  assert.throws(() => events.lifecycleEvent('stage_call', { run: 'r1' }), /\bstage_call\b/);
});

test('eventLog appends a row with the identity columns and the full event', (t) => {
  const dir = tempDir(t);
  events.eventLog(dir, { run: 'r1' })('ticket_start', { execution: 'e1', ticket: 7 });
  assert.deepEqual(readdirSync(join(dir, 'gg')).filter((f) => !f.startsWith('gg.db') && f !== 'locks'), [],
    'only the State Database and its open lock are written');
  const [row, ...rest] = rows(dir);
  assert.equal(rest.length, 0);
  const event = JSON.parse(row.json);
  assert.deepEqual(event, { schema: 2, ts: event.ts, type: 'ticket_start', run: 'r1', execution: 'e1', ticket: 7 });
  assert.deepEqual({ ts: row.ts, type: row.type, run: row.run, execution: row.execution, ticket: row.ticket },
    { ts: event.ts, type: 'ticket_start', run: 'r1', execution: 'e1', ticket: 7 });

  events.eventLog(dir)('label_failed', { ticket: 8, change: 'add gg:ready', error: 'gh 502' });
  const absent = rows(dir)[1];
  assert.deepEqual([absent.type, absent.run, absent.execution, absent.ticket], ['label_failed', null, null, 8]);
});

test('readEvents returns events in insertion order', (t) => {
  const dir = tempDir(t);
  const log = events.eventLog(dir, { run: 'r1' });
  log('run_start');
  log('ticket_start', { execution: 'e1', ticket: 7 });
  log('action', events.actionEvent(actionFields()));
  log('action', events.actionEvent({ ...actionFields(), recovery: 1 }));
  log('ticket_end', { execution: 'e1', ticket: 7, outcome: 'done' });
  log('run_end');
  const read = events.readEvents(dir);
  assert.deepEqual(read.map((e) => [e.type, e.recovery ?? null]),
    [['run_start', null], ['ticket_start', null], ['action', 0], ['action', 1], ['ticket_end', null], ['run_end', null]]);
  assert.deepEqual(read, rows(dir).map((row) => JSON.parse(row.json)));
});

test('hasTicketEnd finds only the ticket_end of the named Execution', (t) => {
  const dir = tempDir(t);
  const log = events.eventLog(dir, { run: 'r1' });
  log('ticket_start', { execution: '7.aaa', ticket: 7 });
  log('run_end');
  assert.equal(events.hasTicketEnd(dir, '7.aaa'), false, 'a run_end is no ticket_end');
  log('ticket_end', { execution: '7.bbb', ticket: 7, outcome: 'needs-human' });
  assert.equal(events.hasTicketEnd(dir, '7.aaa'), false, "another Execution's end of the same Ticket");
  assert.equal(events.hasTicketEnd(dir, '7.bbb'), true);
});

test('readEvents on a fresh directory returns nothing', (t) => {
  assert.deepEqual(events.readEvents(tempDir(t)), []);
});

test('diffStats splits test and non-test insertions', () => {
  const s = events.diffStats([
    { path: 'src/cart.mjs', insertions: 3, deletions: 1 }, { path: 'test/cart.test.mjs', insertions: 10, deletions: 0 },
    { path: 'src/util.spec.ts', insertions: 2, deletions: 2 }, { path: 'img.png', insertions: null, deletions: null },
  ], checks.DEFAULT_TEST_GLOBS);
  assert.deepEqual(s, { files: 4, insertions: 15, deletions: 3, testFiles: 2, testInsertions: 12 });
});

// Each path is one that either the old stats regex or the default globs took for a test, and the other did not, or a
// control; case differs only in the directory or extension, so a case-insensitive disk keeps every path apart.
test('diffStats counts exactly the files Test Immutability treats as tests', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-events-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakeGit();
  const { mainRoot, base } = fake.init(root);
  const add = (p) => {
    mkdirSync(dirname(join(mainRoot, p)), { recursive: true });
    writeFileSync(join(mainRoot, p), 'x\n');
  };
  add('test/b.mjs'); add('Tests/a.mjs'); add('src/a.TEST.mjs'); add('spec/c.mjs'); add('fixtures/x.json'); add('lib/x.mjs');
  const immutability = await checks.testImmutability(mainRoot, base, { globs: checks.DEFAULT_TEST_GLOBS, git: fake.git });
  const stats = events.diffStats([
    { path: 'test/b.mjs', insertions: 1, deletions: 0 }, { path: 'Tests/a.mjs', insertions: 2, deletions: 0 },
    { path: 'src/a.TEST.mjs', insertions: 4, deletions: 0 }, { path: 'spec/c.mjs', insertions: 8, deletions: 0 },
    { path: 'fixtures/x.json', insertions: 16, deletions: 0 }, { path: 'lib/x.mjs', insertions: 32, deletions: 0 },
  ], checks.DEFAULT_TEST_GLOBS);

  assert.deepEqual(immutability.changed, ['Tests/a.mjs', 'fixtures/x.json', 'src/a.TEST.mjs', 'test/b.mjs']);
  assert.deepEqual(stats, { files: 6, insertions: 63, deletions: 0, testFiles: 4, testInsertions: 23 });
});

test('diffStats counts a declared test path outside the default globs', () => {
  const s = events.diffStats([{ path: 'e2e/cart.mjs', insertions: 5, deletions: 0 }, { path: 'lib/cart.mjs', insertions: 1, deletions: 0 }], ['e2e/**']);
  assert.deepEqual(s, { files: 2, insertions: 6, deletions: 0, testFiles: 1, testInsertions: 5 });
});
