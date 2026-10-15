import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as events from '../lib/events.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'gg-events-'));

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

test('an action event carries schema 2 and every required field', () => {
  const dir = tempDir();
  assert.equal(events.eventsFile(dir), join(dir, 'gg', 'events.jsonl'));
  const log = events.eventLog(dir, { run: 'r1' });
  const event = events.actionEvent(actionFields());
  log(event.type, event);
  log('run_end', events.lifecycleEvent('run_end', { run: 'r1' }));
  const lines = readFileSync(events.eventsFile(dir), 'utf8').split('\n').filter(Boolean);
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

test('eventLog validates every event before appending it', () => {
  const dir = tempDir();
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
  const [line] = readFileSync(events.eventsFile(dir), 'utf8').split('\n').filter(Boolean);
  const back = JSON.parse(line);
  assert.equal(back.schema, 2);
  assert.equal(back.type, 'run_start');
  assert.equal(back.run, 'r1');
});

test('lifecycle events validate their required fields per type', () => {
  assert.equal(events.lifecycleEvent('run_start', { run: 'r1' }).type, 'run_start');
  assert.throws(() => events.lifecycleEvent('run_end', {}), /\brun\b/);
  assert.equal(events.lifecycleEvent('ticket_start', { run: 'r1', execution: 'e1', ticket: 7 }).type, 'ticket_start');
  assert.throws(() => events.lifecycleEvent('ticket_end', { run: 'r1', ticket: 7 }), /\bexecution\b/);
  assert.equal(events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready', error: 'gh 502' }).type, 'label_failed');
  assert.equal(
    events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready', error: 'gh 502', run: 'r1' }).run, 'r1');
  assert.throws(() => events.lifecycleEvent('label_failed', { ticket: 7, change: 'add gg:ready' }), /\berror\b/);
  assert.throws(() => events.lifecycleEvent('run_start', { run: 'r1', extra: 1 }), /\bextra\b/);
  assert.throws(() => events.lifecycleEvent('stage_call', { run: 'r1' }), /\bstage_call\b/);
});

test('readEvents keeps schema-1 lines and skips corrupt lines', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'gg'), { recursive: true });
  writeFileSync(events.eventsFile(dir), [
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'stage_call', run: 'old' }),
    '{not json',
    JSON.stringify({ schema: 2, ts: '2026-02-01T00:00:00.000Z', type: 'run_start', run: 'new' }),
    '',
  ].join('\n'));
  const read = events.readEvents(dir);
  assert.equal(read.length, 2);
  assert.equal(read[0].schema, 1);
  assert.equal(read[0].type, 'stage_call');
  assert.equal(read[1].schema, 2);
  assert.deepEqual(events.readEvents(tempDir()), []);
});

test('diffStats splits test and non-test insertions', () => {
  const s = events.diffStats('3\t1\tsrc/cart.mjs\n10\t0\ttest/cart.test.mjs\n2\t2\tsrc/util.spec.ts\n-\t-\timg.png\n');
  assert.deepEqual(s, { files: 4, insertions: 15, deletions: 3, testFiles: 2, testInsertions: 12 });
});
