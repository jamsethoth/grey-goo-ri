import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as events from '../lib/events.mjs';
import * as record from '../lib/record.mjs';

const appender = fileURLToPath(new URL('./support/event-appender.mjs', import.meta.url));

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
  ticket: 7, run: 'r1', execution: 'e1', vertex: 'implement', visit: 1, procedure: 'tdd', phase: 'red',
  ordinal: 1, attempt: 1, durationMs: 1500, outcome: 'ok', direction: 'forward', signals: [], rule: 'red-ok',
  agent: true,
  harness: 'fake', cliVersion: null, model: 'fake-model', effort: 'medium', personaHash: 'p1', tools: ['Read'],
  init: null, sessionId: 's1', lineage: [], transcriptPath: null,
  usage: { cumulative: usage(), delta: usage() },
  exitCode: 0, signal: null, finalEventSubtype: 'success', permissionDenials: [], commandsRun: [], failureClass: null,
});

const required = [
  'flow', 'configHash', 'launchProfile', 'confinement', 'ticket', 'run', 'execution', 'vertex', 'visit',
  'procedure', 'phase', 'ordinal', 'attempt', 'durationMs', 'outcome', 'direction', 'signals', 'rule',
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
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(line.startsWith('{"schema":2'), line);
  const back = JSON.parse(lines[0]);
  assert.equal(back.schema, 2);
  assert.equal(back.type, 'action');
  assert.equal(typeof back.ts, 'string');
  for (const key of [...required, ...agentRequired]) assert.ok(key in back, `line carries ${key}`);
  assert.equal(back.launchProfile, null);
  assert.equal(back.confinement, null);
  assert.deepEqual(back.usage, { cumulative: usage(), delta: usage() });
  assert.deepEqual(events.readEvents(dir).map((e) => e.type), ['action', 'run_end']);
});

test('actionEvent throws naming a missing required field', () => {
  for (const key of required) {
    const fields = actionFields();
    delete fields[key];
    assert.throws(() => events.actionEvent(fields), new RegExp(`\\b${key}\\b`), key);
  }
  for (const key of agentRequired) {
    const fields = actionFields();
    delete fields[key];
    assert.throws(() => events.actionEvent(fields), new RegExp(`\\b${key}\\b`), key);
  }
  const check = Object.fromEntries(Object.entries(actionFields()).filter(([k]) => required.includes(k)));
  assert.equal(events.actionEvent({ ...check, agent: false }).type, 'action');
});

test('actionEvent rejects an unknown key and accepts the optional keys', () => {
  assert.throws(() => events.actionEvent({ ...actionFields(), tokensIn: 5 }), /\btokensIn\b/);
  const optional = {
    check: 'red', violations: [], requireTestPass: true, repeat: 2, exhausted: false, retryAfterMs: 1000, error: 'boom',
  };
  for (const [key, value] of Object.entries(optional)) {
    assert.equal(events.actionEvent({ ...actionFields(), [key]: value })[key], value, key);
  }
  const all = events.actionEvent({ ...actionFields(), ...optional });
  for (const key of Object.keys(optional)) assert.ok(key in all, key);
});

test('actionEvent throws when a required field is undefined', () => {
  for (const key of [...required, ...agentRequired]) {
    assert.throws(() => events.actionEvent({ ...actionFields(), [key]: undefined }), new RegExp(`\\b${key}\\b`), key);
  }
  assert.throws(() => events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready', error: undefined }), /\berror\b/);
});

test('actionEvent checks both Usage members of an agent action', () => {
  const bad = [
    null, {}, { cumulative: usage() }, { delta: usage() }, { cumulative: {}, delta: usage() },
    { cumulative: usage(), delta: null }, { cumulative: usage(), delta: { ...usage(), turns: '3' } },
    { cumulative: (({ peakContext, ...u }) => u)(usage()), delta: usage() },
  ];
  for (const value of bad) {
    assert.throws(() => events.actionEvent({ ...actionFields(), usage: value }), /\busage\b/, JSON.stringify(value));
  }
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
  assert.throws(() => log('label_failed', { ticket: 7, change: 'add gg:ready', error: undefined }), /\berror\b/);
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
  assert.ok(!('eventsFile' in events), 'events no longer exports eventsFile');
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
  log('action', events.actionEvent({ ...actionFields(), ordinal: 2 }));
  log('ticket_end', { execution: 'e1', ticket: 7, outcome: 'done' });
  log('run_end');
  const read = events.readEvents(dir);
  assert.deepEqual(read.map((e) => [e.type, e.ordinal ?? null]),
    [['run_start', null], ['ticket_start', null], ['action', 1], ['action', 2], ['ticket_end', null], ['run_end', null]]);
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

test('two processes append to the same table without loss', async (t) => {
  const dir = tempDir(t);
  const exits = await Promise.all(['a', 'b'].map((run) => new Promise((resolve) => {
    const child = spawn(process.execPath, [appender, dir, run, '200'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ run, code, err }));
  })));
  assert.deepEqual(exits, [{ run: 'a', code: 0, err: '' }, { run: 'b', code: 0, err: '' }]);
  assert.equal(rows(dir).length, 400);
  const read = events.readEvents(dir);
  assert.equal(read.length, 400);
  assert.equal(read.filter((e) => e.run === 'a').length, 200);
  assert.equal(read.filter((e) => e.run === 'b').length, 200);
});

test('readEvents on a fresh directory returns nothing', (t) => {
  assert.deepEqual(events.readEvents(tempDir(t)), []);
});

test('diffStats splits test and non-test insertions', () => {
  const s = events.diffStats('3\t1\tsrc/cart.mjs\n10\t0\ttest/cart.test.mjs\n2\t2\tsrc/util.spec.ts\n-\t-\timg.png\n');
  assert.deepEqual(s, { files: 4, insertions: 15, deletions: 3, testFiles: 2, testInsertions: 12 });
});
