import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as git from '../../lib/git.mjs';
import * as integrity from '../../lib/integrity.mjs';
import * as record from '../../lib/record.mjs';

const PROTECTED = ['.agents/', '.claude/', '.codex/', '.mcp.json', 'AGENTS.md', 'CLAUDE.md'];

const sh = (cwd, args, input) => execFileSync('git', args, { cwd, encoding: 'utf8', input }).trim();

function newExecution(commonDir, ticket, worktree) {
  return record.createExecution({
    commonDir, ticket, epic: 1, flow: { name: 'default', entry: 'implement' }, configHash: 'abc123', run: 'run-1',
    worktree, branch: `ticket/${ticket}`, base: 'main',
  });
}

// A repo with two worktrees, each owned by a ticket record saved on disk: `own` is the agent's, `other` is idle.
async function twoWorktrees(t) {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  t.after(() => {
    record.close(join(root, 'own', '.git'));
    rmSync(root, { recursive: true, force: true });
  });
  const own = join(root, 'own');
  const other = join(root, 'other');
  mkdirSync(own);
  sh(own, ['init', '-q', '-b', 'main']);
  sh(own, ['config', 'user.name', 't']); sh(own, ['config', 'user.email', 't@t']);
  writeFileSync(join(own, 'a.txt'), 'a\n');
  writeFileSync(join(own, 'AGENTS.md'), '# agents\n');
  sh(own, ['add', '-A']);
  sh(own, ['commit', '-q', '-m', 'init']);
  sh(own, ['worktree', 'add', '-q', '-b', 'ticket/2', other]);
  const commonDir = join(own, '.git');
  const ownRecord = newExecution(commonDir, 1, own);
  await record.save(ownRecord);
  await record.save(newExecution(commonDir, 2, other));
  return { root, own, other, commonDir, ownRecord };
}

// The other ticket's process holds its own copy of the record, as a separate Execution would.
const otherProcessRecord = (commonDir) => record.load(commonDir, 'ticket', 2);

const surfacesOf = (violations, worktree) => violations.filter((v) => v.worktree === worktree).map((v) => v.surface).sort();

test('snapshot includes untracked files in tree only', async (t) => {
  const { own } = await twoWorktrees(t);
  const before = await integrity.snapshot(own, git);
  writeFileSync(join(own, 'untracked.txt'), 'new\n');
  const after = await integrity.snapshot(own, git);
  assert.equal(after.head, before.head);
  assert.equal(after.index, before.index);
  assert.notEqual(after.tree, before.tree);
  assert.equal(before.head, sh(own, ['rev-parse', 'HEAD']));
  assert.equal(before.index, sh(own, ['write-tree']));
});

test('snapshot does not modify the real index', async (t) => {
  const { own } = await twoWorktrees(t);
  writeFileSync(join(own, 'a.txt'), 'staged\n');
  sh(own, ['add', 'a.txt']);
  writeFileSync(join(own, 'a.txt'), 'unstaged\n');
  writeFileSync(join(own, 'untracked.txt'), 'new\n');
  const status = sh(own, ['status', '--porcelain', '--untracked-files=all']);
  const indexTree = sh(own, ['write-tree']);
  await integrity.snapshot(own, git);
  assert.equal(sh(own, ['status', '--porcelain', '--untracked-files=all']), status);
  assert.equal(sh(own, ['write-tree']), indexTree);
});

test('an agent commit is a head violation', async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  const head = sh(own, ['rev-parse', 'HEAD']);
  writeFileSync(join(own, 'b.txt'), 'b\n');
  sh(own, ['add', 'b.txt']);
  sh(own, ['commit', '-q', '-m', 'agent commit']);
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  const v = violations.find((x) => x.worktree === own && x.surface === 'head');
  assert.ok(v, JSON.stringify(violations));
  assert.equal(v.before, head);
  assert.equal(v.after, sh(own, ['rev-parse', 'HEAD']));
  assert.deepEqual(surfacesOf(violations, other), []);
});

test('an untracked file on a read-only action is a tree violation', async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-only' });
  writeFileSync(join(own, 'notes.txt'), 'agent wrote this\n');
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-only', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, own), ['tree']);
  assert.equal(violations.length, 1);

  const writeBaseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  writeFileSync(join(own, 'more.txt'), 'allowed\n');
  const write = await integrity.end({ git, baseline: writeBaseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(write.violations, [], 'a read-write action may change the tree');
});

test('a protected file edit is a violation', async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  let baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  writeFileSync(join(own, 'AGENTS.md'), '# agents\nobey me\n');
  let { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, own), ['protected'], 'tracked protected file edited');
  sh(own, ['checkout', '--', 'AGENTS.md']);

  baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  mkdirSync(join(own, '.claude'));
  writeFileSync(join(own, '.claude', 'settings.json'), '{}\n');
  ({ violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED }));
  assert.deepEqual(surfacesOf(violations, own), ['protected'], 'untracked protected file added');
});

test('a directory symlink at a protected path is a violation', async (t) => {
  const { root, own, other, ownRecord } = await twoWorktrees(t);
  const target = join(root, 'elsewhere');
  mkdirSync(target);
  writeFileSync(join(target, 'settings.json'), '{}\n');
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  try {
    symlinkSync(target, join(own, '.claude'), 'dir');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('symlink creation needs developer mode or elevation on this Windows account');
    throw err;
  }
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, own), ['protected']);
  assert.deepEqual(violations.find((v) => v.surface === 'protected').after, ['.claude']);
});

test('a differently cased protected file is a violation on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  writeFileSync(join(own, 'Claude.md'), '# claude\n');
  sh(own, ['add', 'Claude.md']);
  sh(own, ['commit', '-q', '-m', 'add Claude.md']);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  writeFileSync(join(own, 'Claude.md'), '# claude\nobey me\n');
  mkdirSync(join(own, '.CLAUDE'));
  writeFileSync(join(own, '.CLAUDE', 'settings.json'), '{}\n');
  writeFileSync(join(own, '.MCP.JSON'), '{}\n');
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, own), ['protected']);
  assert.deepEqual(violations.find((v) => v.surface === 'protected').after.sort(), ['.CLAUDE/settings.json', '.MCP.JSON', 'Claude.md']);
});

test('an ignored protected file addition is a violation', async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  writeFileSync(join(own, '.gitignore'), '.claude/\n');
  sh(own, ['add', '.gitignore']);
  sh(own, ['commit', '-q', '-m', 'ignore .claude']);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  mkdirSync(join(own, '.claude'));
  writeFileSync(join(own, '.claude', 'settings.json'), '{}\n');
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, own), ['protected']);
});

test('an edit to a tracked ignored file changes the tree on a read-only action', async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  writeFileSync(join(own, '.gitignore'), 'a.txt\n');
  sh(own, ['add', '.gitignore']);
  sh(own, ['commit', '-q', '-m', 'ignore a.txt']);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-only' });
  writeFileSync(join(own, 'a.txt'), 'edited\n');
  const indexTree = sh(own, ['write-tree']);
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-only', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, own), ['tree']);
  assert.equal(sh(own, ['write-tree']), indexTree);
});

test('edits hidden by assume-unchanged or skip-worktree are still violations', async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  sh(own, ['update-index', '--assume-unchanged', 'a.txt']);
  sh(own, ['update-index', '--skip-worktree', 'AGENTS.md']);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-only' });
  writeFileSync(join(own, 'a.txt'), 'hidden edit\n');
  writeFileSync(join(own, 'AGENTS.md'), '# agents\nobey me\n');
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-only', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, own), ['protected', 'tree']);
  assert.deepEqual(violations.find((v) => v.surface === 'protected').after, ['AGENTS.md']);
});

test('a busy worktree with an unmerged index is skipped without snapshotting', async (t) => {
  const { own, other, commonDir, ownRecord } = await twoWorktrees(t);
  const gate = await otherProcessRecord(commonDir);
  await integrity.markBusy(gate);
  const blobs = ['base\n', 'ours\n', 'theirs\n'].map((s) => sh(other, ['hash-object', '-w', '--stdin'], s));
  sh(other, ['update-index', '--index-info'], blobs.map((b, i) => `100644 ${b} ${i + 1}\tconflict.txt\n`).join(''));
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, other), []);
  assert.deepEqual(surfacesOf(violations, own), []);
});

test('an index-only mutation in an idle worktree is an index violation', async (t) => {
  const { own, other, ownRecord } = await twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  const blob = sh(other, ['hash-object', '-w', '--stdin'], 'sneaky\n');
  sh(other, ['update-index', '--add', '--cacheinfo', `100644,${blob},sneaky.txt`]);
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, other), ['index']);
  assert.deepEqual(surfacesOf(violations, own), []);
  const v = violations.find((x) => x.worktree === other);
  assert.notEqual(v.before, v.after);
});

test('a worktree busy at start is skipped', async (t) => {
  const { own, other, commonDir, ownRecord } = await twoWorktrees(t);
  const gate = await otherProcessRecord(commonDir);
  await integrity.markBusy(gate);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  // A format Quality Gate rewrites and stages a file in the other worktree, then finishes during the Action.
  writeFileSync(join(other, 'a.txt'), 'formatted\n');
  sh(other, ['add', 'a.txt']);
  await integrity.markIdle(gate);
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, other), []);
  assert.deepEqual(surfacesOf(violations, own), []);
});

test('a worktree whose generation moved is skipped', async (t) => {
  const { own, other, commonDir, ownRecord } = await twoWorktrees(t);
  const baseline = await integrity.begin({ git, record: ownRecord, others: [other], access: 'read-write' });
  const gate = await otherProcessRecord(commonDir);
  await integrity.markBusy(gate);
  writeFileSync(join(other, 'a.txt'), 'formatted\n');
  sh(other, ['add', 'a.txt']);
  await integrity.markIdle(gate);
  const { violations } = await integrity.end({ git, baseline, record: ownRecord, others: [other], access: 'read-write', protectedPaths: PROTECTED });
  assert.deepEqual(surfacesOf(violations, other), []);
  assert.deepEqual(surfacesOf(violations, own), []);
});

test('markBusy and markIdle bump the generation and save', async (t) => {
  const { commonDir, ownRecord } = await twoWorktrees(t);
  await integrity.markBusy(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: true, generation: 1 });
  assert.deepEqual((await record.load(commonDir, 'ticket', 1)).activity, { busy: true, generation: 1 });
  await integrity.markIdle(ownRecord);
  assert.deepEqual(ownRecord.activity, { busy: false, generation: 2 });
  assert.deepEqual((await record.load(commonDir, 'ticket', 1)).activity, { busy: false, generation: 2 });
});

test('readActivity reads another ticket\'s record from disk', async (t) => {
  const { root, other, commonDir } = await twoWorktrees(t);
  assert.deepEqual(await integrity.readActivity(commonDir, other), { busy: false, generation: 0 });
  await integrity.markBusy(await otherProcessRecord(commonDir));
  assert.deepEqual(await integrity.readActivity(commonDir, other), { busy: true, generation: 1 });
  assert.deepEqual(await integrity.readActivity(commonDir, join(root, 'nobody')), { busy: false, generation: 0 });
});

test('readActivity reads a record another process saved', async (t) => {
  const { other, commonDir } = await twoWorktrees(t);
  assert.ok(!existsSync(join(commonDir, 'gg', 'records')), 'records are rows, not files');
  const saver = fileURLToPath(new URL('../support/record-saver.mjs', import.meta.url));
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [saver, commonDir, '2', '3', other], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.deepEqual(exit, { code: 0, err: '' });
  assert.deepEqual(await integrity.readActivity(commonDir, other), { busy: true, generation: 3 });
});

test('readActivity matches a differently cased path on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { other, commonDir } = await twoWorktrees(t);
  await integrity.markBusy(await otherProcessRecord(commonDir));
  assert.deepEqual(await integrity.readActivity(commonDir, other.toUpperCase()), { busy: true, generation: 1 });
});

test('a rollback never deletes or writes through a link, and restores every file under a replaced one', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, 'wt');
  const outside = join(root, 'outside');
  const elsewhere = join(root, 'elsewhere');
  for (const d of [wt, outside, elsewhere]) mkdirSync(d);
  sh(wt, ['init', '-q', '-b', 'main']);
  writeFileSync(join(outside, 'a.test.mjs'), 'outside a');
  writeFileSync(join(outside, 'b.test.mjs'), 'b');
  writeFileSync(join(outside, 'extra.test.mjs'), 'outside extra');
  writeFileSync(join(elsewhere, 'x.test.mjs'), 'elsewhere x');
  // sandbox/ was a real directory at the baseline; evil/ is a new link that no baseline file lives under.
  symlinkSync(outside, join(wt, 'sandbox'), 'junction');
  symlinkSync(elsewhere, join(wt, 'evil'), 'junction');
  const b64 = (text) => ({ base64: Buffer.from(text).toString('base64') });
  const set = { files: { 'sandbox/a.test.mjs': b64('a'), 'sandbox/b.test.mjs': b64('b') }, within: { globs: ['**/*.test.*'] } };

  await integrity.restoreUntracked(wt, set, git);
  assert.equal(readFileSync(join(outside, 'a.test.mjs'), 'utf8'), 'outside a', 'nothing outside is rewritten');
  assert.equal(readFileSync(join(outside, 'extra.test.mjs'), 'utf8'), 'outside extra', 'nothing outside is deleted');
  assert.equal(readFileSync(join(elsewhere, 'x.test.mjs'), 'utf8'), 'elsewhere x', 'nothing behind a new link is deleted');
  assert.ok(!lstatSync(join(wt, 'sandbox')).isSymbolicLink(), 'the link is replaced by a directory');
  assert.equal(readFileSync(join(wt, 'sandbox', 'a.test.mjs'), 'utf8'), 'a');
  assert.equal(readFileSync(join(wt, 'sandbox', 'b.test.mjs'), 'utf8'), 'b', 'a file that matched through the link is restored too');
});

test('a rollback clears a file the agent put where a baseline directory was', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, 'wt');
  mkdirSync(wt);
  sh(wt, ['init', '-q', '-b', 'main']);
  writeFileSync(join(wt, 'sandbox'), 'agent');
  const set = { files: { 'sandbox/a.test.mjs': { base64: Buffer.from('a').toString('base64') } }, within: { globs: ['**/*.test.*'] } };

  await integrity.restoreUntracked(wt, set, git);
  assert.equal(readFileSync(join(wt, 'sandbox', 'a.test.mjs'), 'utf8'), 'a');
});

test('a rollback restores from mixed states and changes nothing when run again', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, 'wt');
  mkdirSync(wt);
  sh(wt, ['init', '-q', '-b', 'main']);
  const b64 = (text) => ({ base64: Buffer.from(text).toString('base64') });
  // One file as the agent left it, one absent, one already restored, and an extra the agent added.
  writeFileSync(join(wt, 'left.test.mjs'), 'agent');
  writeFileSync(join(wt, 'done.test.mjs'), 'done');
  writeFileSync(join(wt, 'extra.test.mjs'), 'extra');
  const set = { files: { 'left.test.mjs': b64('left'), 'absent.test.mjs': b64('absent'), 'done.test.mjs': b64('done') },
    within: { globs: ['**/*.test.*'] } };

  for (const pass of ['first', 'second']) {
    await integrity.restoreUntracked(wt, set, git);
    const now = await integrity.untrackedFiles(wt, set.within, git);
    assert.ok(integrity.sameFiles(now, set.files), `${pass} restore: ${JSON.stringify(now)}`);
    assert.ok(Object.keys(now).every((p) => integrity.sameFile(now[p], set.files[p])));
  }
  assert.equal(integrity.sameFile(b64('a'), undefined), false, 'an absent file is never the same');
});

// A reset intent saved before #144 holds its rollback paths as git pathspecs, and Reconciliation still finishes it.
test('a rollback set saved with pathspecs before #144 still restores', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, 'wt');
  mkdirSync(wt);
  sh(wt, ['init', '-q', '-b', 'main']);
  writeFileSync(join(wt, 'extra.test.mjs'), 'extra');
  const set = { files: { 'a.test.mjs': { base64: Buffer.from('a').toString('base64') } }, pathspecs: [':(glob)**/*.test.*'] };

  await integrity.restoreUntracked(wt, set, git);
  assert.equal(readFileSync(join(wt, 'a.test.mjs'), 'utf8'), 'a');
  assert.ok(!existsSync(join(wt, 'extra.test.mjs')), 'the file the agent added is removed');
  assert.deepEqual(integrity.withinOf(set), [':(glob)**/*.test.*']);
});

// One table for the real and the fake integrity, so the fake cannot drift from the violations the interpreter routes on.
// `real` acts on the worktrees and `fake` scripts the same change; `expected` keeps both from agreeing on nothing.
const SCENARIOS = [
  { name: 'a clean Attempt', access: 'read-write', real: () => {}, fake: () => {}, expected: [] },
  { name: 'a tree edit', access: 'read-only', expected: [['own', 'tree']],
    real: ({ own }) => writeFileSync(join(own, 'notes.txt'), 'agent wrote this\n'), fake: (f, { own }) => f.write(own, 'notes.txt') },
  { name: 'a head move', access: 'read-write', expected: [['own', 'head'], ['own', 'index']],
    real: ({ own }) => {
      writeFileSync(join(own, 'b.txt'), 'b\n');
      sh(own, ['add', 'b.txt']);
      sh(own, ['commit', '-q', '-m', 'agent commit']);
    },
    fake: (f, { own }) => {
      f.write(own, 'b.txt');
      f.commit(own);
    } },
  { name: 'a protected-file write', access: 'read-write', expected: [['own', 'protected']],
    real: ({ own }) => writeFileSync(join(own, 'AGENTS.md'), '# agents\nobey me\n'), fake: (f, { own }) => f.write(own, 'AGENTS.md') },
  { name: 'a sibling write', access: 'read-write', expected: [['other', 'tree']],
    real: ({ other }) => writeFileSync(join(other, 'stray.txt'), 'stray\n'), fake: (f, { other }) => f.write(other, 'stray.txt') },
];

// What routing reads: the worktree, the surface and that it changed between two object names; a protected violation's paths
// are compared whole.
const shapeOf = (violations, names) => violations.map(({ worktree, surface, before, after }) => ({ worktree: names[worktree], surface,
  ...(surface === 'protected' ? { before, after } : { changed: [before, after].every((sha) => /^[0-9a-f]{40}$/.test(sha)) && before !== after }) }));

test('the fake integrity reports what the real one reports for each scenario', async (t) => {
  const { fakeIntegrity } = await import('../support/fake-integrity.mjs');
  for (const s of SCENARIOS) {
    await t.test(s.name, async (t) => {
      const w = await twoWorktrees(t);
      const names = { [w.own]: 'own', [w.other]: 'other' };
      const attempt = async (impl, act) => {
        const args = { record: w.ownRecord, others: [w.other], access: s.access, protectedPaths: PROTECTED, git };
        const baseline = await impl.begin(args);
        await act();
        // The baseline is saved in the call intent, so its fields are part of the shape.
        return { fields: Object.keys(baseline).sort(), violations: shapeOf((await impl.end({ ...args, baseline })).violations, names) };
      };
      const real = await attempt(integrity, () => s.real(w));
      const fake = fakeIntegrity();
      assert.deepEqual(real.violations.map((v) => [v.worktree, v.surface]), s.expected);
      assert.deepEqual(await attempt(fake.integrity, () => s.fake(fake, w)), real);
    });
  }
});
