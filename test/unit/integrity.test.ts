import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import { fakeGit } from '../support/fake-git.ts';
import * as integrityWorktrees from '../support/integrity-worktrees.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// Two ticket records saved on disk, `own` and `other`; activity is read from the records, so no worktree or git is
// needed.
async function twoRecords(t: TestContext) {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'own', '.git'));
  const commonDir = join(root, 'own', '.git');
  stateDatabase.create(commonDir);
  const ownRecord = integrityWorktrees.worktreeRecord(commonDir, 1, join(root, 'own'));
  record.save(ownRecord);
  const other = join(root, 'other');
  record.save(integrityWorktrees.worktreeRecord(commonDir, 2, other));
  return { root, other, commonDir, ownRecord };
}

// The other ticket's process holds its own copy of the record, as a separate Execution would.
const otherProcessRecord = (commonDir: string) => record.load(commonDir, 'ticket', 2) as record.ExecutionRecord;

test('markBusy and markIdle bump the generation and save', async (t) => {
  const { commonDir, ownRecord } = await twoRecords(t);
  await integrity.markBusy(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: true, generation: 1 });
  assert.deepEqual(record.load(commonDir, 'ticket', 1)?.activity, { busy: true, generation: 1 });
  await integrity.markIdle(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: false, generation: 2 });
  assert.deepEqual(record.load(commonDir, 'ticket', 1)?.activity, { busy: false, generation: 2 });
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

// The names every object inherits, `__proto__` among them: a file map indexed by one it lacks gives what it inherits.
const INHERITED_NAMES = Object.getOwnPropertyNames(Object.prototype);

test('sameFile never takes an inherited value for a file', () => {
  const none: integrity.UntrackedFiles = {};
  const taken = INHERITED_NAMES.filter((name) => integrity.sameFile(none[name], none[name]));
  assert.deepEqual(taken, []);
});

// A worktree over the fake git holding one untracked root file `name`, protected so the baseline saves it.
async function protectedRootFile(t: TestContext, name: string) {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'main', '.git'));
  const fake = fakeGit();
  const { mainRoot, commonDir } = fake.init(root);
  const real = integrity.createIntegrity(fake.git);
  const executionRecord = integrityWorktrees.worktreeRecord(commonDir, 1, mainRoot);
  const protectedPaths = [name];
  const takeBaseline = () => real.takeBaseline({ record: executionRecord, others: [], protectedPaths });
  const rollBack = (baseline: integrity.IntegrityBaseline) =>
    real.restoreUntracked(mainRoot, integrity.rollbackSet(baseline, protectedPaths, {}));
  return { mainRoot, takeBaseline, rollBack };
}

test('an untracked file named __proto__ is kept in the baseline', async (t) => {
  const { mainRoot, takeBaseline, rollBack } = await protectedRootFile(t, '__proto__');
  writeFileSync(join(mainRoot, '__proto__'), 'kept');
  const baseline = await takeBaseline();
  assert.ok(Object.hasOwn(baseline.untracked, '__proto__'), JSON.stringify(baseline.untracked));
  assert.deepEqual(baseline.untracked['__proto__'], { base64: Buffer.from('kept').toString('base64') });

  await fsPromises.rm(join(mainRoot, '__proto__'));
  await rollBack(baseline);
  assert.equal(readFileSync(join(mainRoot, '__proto__'), 'utf8'), 'kept');
});

test('an untracked file with any inherited name is kept in the baseline and restored', async (t) => {
  const lost: string[] = [];
  for (const name of INHERITED_NAMES) {
    const { mainRoot, takeBaseline, rollBack } = await protectedRootFile(t, name);
    writeFileSync(join(mainRoot, name), name);
    const baseline = await takeBaseline();
    await fsPromises.rm(join(mainRoot, name));
    await rollBack(baseline);
    if (!Object.hasOwn(baseline.untracked, name) || !existsSync(join(mainRoot, name))) lost.push(name);
  }
  assert.deepEqual(lost, []);
});

test('a rollback removes a new untracked file with any inherited name', async (t) => {
  const kept: string[] = [];
  for (const name of INHERITED_NAMES) {
    const { mainRoot, takeBaseline, rollBack } = await protectedRootFile(t, name);
    const baseline = await takeBaseline();
    writeFileSync(join(mainRoot, name), 'an agent wrote this');
    await rollBack(baseline);
    if (existsSync(join(mainRoot, name))) kept.push(name);
  }
  assert.deepEqual(kept, []);
});

test('a workflow file change is an integrity violation', async (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'main', '.git'));
  const fake = fakeGit();
  const { mainRoot, commonDir } = fake.init(root, { files: { '.github/workflows/ci.yml': 'on: push\n' } });
  const real = integrity.createIntegrity(fake.git);
  const executionRecord = integrityWorktrees.worktreeRecord(commonDir, 1, mainRoot);
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

// node:fs retries a removal on EBUSY and EPERM only when asked, and on Windows a scanner or an indexer holding the file
// for a moment is enough to raise them.
test('restore retries a busy file removal', async (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-restore-');
  const fake = fakeGit();
  const { mainRoot } = fake.init(root);
  mkdirSync(join(mainRoot, 'extra'));
  writeFileSync(join(mainRoot, 'extra', 'new.txt'), 'an agent wrote this');
  const removals: { maxRetries?: number }[] = [];
  const fs: integrity.RestoreFs = {
    ...fsPromises,
    rm: async (path, options) => {
      removals.push(options as { maxRetries?: number });
      return fsPromises.rm(path, options);
    },
  };
  await integrity.restoreUntracked(mainRoot, { files: {}, within: { paths: ['extra/'] } }, fake.git, fs);
  assert.equal(removals.length, 1);
  assert.ok(removals[0]!.maxRetries! > 0, JSON.stringify(removals));
});
