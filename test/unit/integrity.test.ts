import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';
import { fakeGit } from '../support/fake-git.ts';
import * as tempDirectory from '../support/temp-directory.ts';

function newExecution(commonDir: string, ticket: number, worktree: string) {
  return record.createExecutionRecord({
    commonDir,
    ticket,
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree,
    branch: `ticket/${ticket}`,
    base: 'main',
  });
}

// Two ticket records saved on disk, `own` and `other`; activity is read from the records, so no worktree or git is
// needed.
async function twoRecords(t: TestContext) {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'own', '.git'));
  const commonDir = join(root, 'own', '.git');
  const ownRecord = newExecution(commonDir, 1, join(root, 'own'));
  await record.save(ownRecord);
  const other = join(root, 'other');
  await record.save(newExecution(commonDir, 2, other));
  return { root, other, commonDir, ownRecord };
}

// The other ticket's process holds its own copy of the record, as a separate Execution would.
const otherProcessRecord = (commonDir: string) =>
  record.load(commonDir, 'ticket', 2) as Promise<record.ExecutionRecord>;

test('markBusy and markIdle bump the generation and save', async (t) => {
  const { commonDir, ownRecord } = await twoRecords(t);
  await integrity.markBusy(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: true, generation: 1 });
  assert.deepEqual((await record.load(commonDir, 'ticket', 1))?.activity, { busy: true, generation: 1 });
  await integrity.markIdle(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: false, generation: 2 });
  assert.deepEqual((await record.load(commonDir, 'ticket', 1))?.activity, { busy: false, generation: 2 });
});

test("readActivity reads another ticket's record from disk", async (t) => {
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

test('a workflow file change is an integrity violation', async (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'main', '.git'));
  const fake = fakeGit();
  const { mainRoot, commonDir } = fake.init(root, { files: { '.github/workflows/ci.yml': 'on: push\n' } });
  const real = integrity.createIntegrity(fake.git);
  const executionRecord = newExecution(commonDir, 1, mainRoot);
  const baseline = await real.takeBaseline({
    record: executionRecord,
    others: [],
    protectedPaths: interpreter.protectedFiles({}),
  });
  writeFileSync(join(mainRoot, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
  mkdirSync(join(mainRoot, '.github', 'actions', 'setup'), { recursive: true });
  writeFileSync(join(mainRoot, '.github', 'actions', 'setup', 'action.yml'), 'runs: {}\n');

  const { violations } = await real.findViolations({
    baseline,
    record: executionRecord,
    others: [],
    access: 'workspace-write',
    protectedPaths: interpreter.protectedFiles({}),
  });
  assert.deepEqual(violations, [
    {
      worktree: mainRoot,
      surface: 'protected',
      before: null,
      after: ['.github/actions/setup/action.yml', '.github/workflows/ci.yml'],
    },
  ]);
});
