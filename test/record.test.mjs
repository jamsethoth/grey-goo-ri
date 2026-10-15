import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as record from '../lib/record.mjs';

async function tempCommonDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gg-record-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function newExecution(commonDir, ticket = 8) {
  return record.createExecution({
    commonDir, ticket, epic: 1, flow: { name: 'default', entry: 'implement' }, configHash: 'abc123', run: 'run-1',
    worktree: join(commonDir, 'wt'), branch: `ticket/${ticket}`, base: 'main',
  });
}

function withoutCommonDir(r) {
  const { commonDir, ...rest } = r;
  return rest;
}

test('createExecution mints an execution id and the documented fields', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  assert.match(r.execution, /^8\.[0-9a-f]{6}$/);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.commonDir, commonDir);
  assert.equal(r.ticket, 8);
  assert.equal(r.epic, 1);
  assert.equal(r.configHash, 'abc123');
  assert.equal(r.run, 'run-1');
  assert.equal(r.state, 'active');
  assert.deepEqual(Object.keys(r.cursor).sort(), ['attempt', 'ordinal', 'phase', 'vertex', 'visit']);
  assert.equal(r.cursor.vertex, 'implement');
  assert.equal(r.cursor.visit, 1);
  assert.deepEqual(r.visits, {});
  assert.deepEqual(r.traversals, {});
  assert.deepEqual(r.retries, {});
  assert.deepEqual(r.sessions, {});
  assert.deepEqual(r.outputs, { red: null, implementation: [], reviews: [] });
  assert.deepEqual(r.history, []);
  assert.equal(r.branch, 'ticket/8');
  assert.equal(r.base, 'main');
  assert.equal(r.pr, null);
  assert.equal(r.pending, null);
  assert.equal(r.snapshot, null);
  assert.deepEqual(r.activity, { busy: false, generation: 0 });
  assert.deepEqual(r.log, []);
  assert.notEqual(newExecution(commonDir).execution, r.execution);

  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  assert.deepEqual(withoutCommonDir(epic), { schemaVersion: 1, epic: 1, approval: null, pending: null });
});

test('save and load round-trip', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  await record.save(r);
  const path = join(commonDir, 'gg', 'records', 'ticket-8.json');
  const text = await readFile(path, 'utf8');
  assert.match(text, /\n  "/, 'indented JSON');
  assert.ok(!('commonDir' in JSON.parse(text)), 'commonDir is not persisted');
  const loaded = await record.load(commonDir, 'ticket', 8);
  assert.deepEqual(withoutCommonDir(loaded), withoutCommonDir(r));
  assert.equal(await record.load(commonDir, 'ticket', 9), null);

  const epic = record.createEpicRecord({ commonDir, epic: 1 });
  await record.save(epic);
  await readFile(join(commonDir, 'gg', 'records', 'epic-1.json'), 'utf8');
  assert.deepEqual(withoutCommonDir(await record.load(commonDir, 'epic', 1)), withoutCommonDir(epic));
});

test('the write-ahead log records intent, evidence and completion per marker', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  await record.intent(r, 'm1', 'commit', { message: 'red' });
  await record.evidence(r, 'm1', { sha: 'deadbeef' });
  await record.complete(r, 'm1');
  assert.equal(r.log.length, 3);
  assert.deepEqual(r.log.map((e) => e.step), ['intent', 'evidence', 'complete']);
  for (const e of r.log) {
    assert.equal(e.marker, 'm1');
    assert.equal(e.action, 'commit');
    assert.equal(typeof e.ts, 'string');
  }
  assert.deepEqual(r.log[0].payload, { message: 'red' });
  assert.deepEqual(r.log[1].evidence, { sha: 'deadbeef' });
  const loaded = await record.load(commonDir, 'ticket', 8);
  assert.deepEqual(loaded.log, r.log, 'each step saves');
});

test('openIntents lists intents without completion oldest first', async (t) => {
  const commonDir = await tempCommonDir(t);
  const r = newExecution(commonDir);
  await record.intent(r, 'm1', 'commit', {});
  assert.deepEqual(record.openIntents(r).map((e) => e.marker ?? e), ['m1']);
  await record.intent(r, 'm2', 'push', {});
  await record.intent(r, 'm3', 'comment', {});
  await record.evidence(r, 'm2', { ok: true });
  await record.complete(r, 'm2');
  assert.deepEqual(record.openIntents(r).map((e) => e.marker ?? e), ['m1', 'm3']);
  await record.complete(r, 'm1');
  await record.complete(r, 'm3');
  assert.deepEqual(record.openIntents(r), []);
});

test('a corrupt record throws RecordCorruptError and is left untouched', async (t) => {
  const commonDir = await tempCommonDir(t);
  const dir = join(commonDir, 'gg', 'records');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'ticket-8.json');
  await writeFile(path, '{');
  await assert.rejects(record.load(commonDir, 'ticket', 8), (err) => {
    assert.ok(err instanceof record.RecordCorruptError);
    assert.match(err.message, /ticket-8\.json/);
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), '{');
});

test('an unknown schemaVersion throws RecordCorruptError', async (t) => {
  const commonDir = await tempCommonDir(t);
  const dir = join(commonDir, 'gg', 'records');
  await mkdir(dir, { recursive: true });
  const text = JSON.stringify({ schemaVersion: 99, epic: 2 });
  await writeFile(join(dir, 'epic-2.json'), text);
  await assert.rejects(record.load(commonDir, 'epic', 2), (err) => {
    assert.ok(err instanceof record.RecordCorruptError);
    assert.match(err.message, /epic-2\.json/);
    return true;
  });
  assert.equal(await readFile(join(dir, 'epic-2.json'), 'utf8'), text);
});

test('loadAll lists every ticket record', async (t) => {
  const commonDir = await tempCommonDir(t);
  assert.deepEqual(await record.loadAll(commonDir, 'ticket'), []);
  await record.save(newExecution(commonDir, 8));
  await record.save(newExecution(commonDir, 12));
  await record.save(record.createEpicRecord({ commonDir, epic: 1 }));
  const all = await record.loadAll(commonDir, 'ticket');
  assert.deepEqual(all.map((r) => r.ticket).sort((a, b) => a - b), [8, 12]);
});
