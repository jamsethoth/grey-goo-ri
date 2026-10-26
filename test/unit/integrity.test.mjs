import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as integrity from '../../lib/integrity.mjs';
import * as record from '../../lib/record.mjs';

function newExecution(commonDir, ticket, worktree) {
  return record.createExecution({
    commonDir, ticket, epic: 1, flow: { name: 'default', entry: 'implement' }, configHash: 'abc123', run: 'run-1',
    worktree, branch: `ticket/${ticket}`, base: 'main',
  });
}

// Two ticket records saved on disk, `own` and `other`; activity is read from the records, so no worktree or git is needed.
async function twoRecords(t) {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  const commonDir = join(root, 'own', '.git');
  t.after(() => {
    record.close(commonDir);
    rmSync(root, { recursive: true, force: true });
  });
  const ownRecord = newExecution(commonDir, 1, join(root, 'own'));
  await record.save(ownRecord);
  const other = join(root, 'other');
  await record.save(newExecution(commonDir, 2, other));
  return { root, other, commonDir, ownRecord };
}

// The other ticket's process holds its own copy of the record, as a separate Execution would.
const otherProcessRecord = (commonDir) => record.load(commonDir, 'ticket', 2);

test('markBusy and markIdle bump the generation and save', async (t) => {
  const { commonDir, ownRecord } = await twoRecords(t);
  await integrity.markBusy(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: true, generation: 1 });
  assert.deepEqual((await record.load(commonDir, 'ticket', 1)).activity, { busy: true, generation: 1 });
  await integrity.markIdle(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: false, generation: 2 });
  assert.deepEqual((await record.load(commonDir, 'ticket', 1)).activity, { busy: false, generation: 2 });
});

test('readActivity reads another ticket\'s record from disk', async (t) => {
  const { root, other, commonDir } = await twoRecords(t);
  assert.deepEqual(await integrity.readActivity(commonDir, other), { busy: false, generation: 0 });
  await integrity.markBusy(await otherProcessRecord(commonDir));
  assert.deepEqual(await integrity.readActivity(commonDir, other), { busy: true, generation: 1 });
  assert.deepEqual(await integrity.readActivity(commonDir, join(root, 'nobody')), { busy: false, generation: 0 });
});

test('readActivity matches a differently cased path on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { other, commonDir } = await twoRecords(t);
  await integrity.markBusy(await otherProcessRecord(commonDir));
  assert.deepEqual(await integrity.readActivity(commonDir, other.toUpperCase()), { busy: true, generation: 1 });
});

test('sameFile never takes an absent file for the same', () => {
  assert.equal(integrity.sameFile({ base64: Buffer.from('a').toString('base64') }, undefined), false);
});
