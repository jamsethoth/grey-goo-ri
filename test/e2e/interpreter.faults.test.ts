import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as events from '../../lib/events.ts';
import type * as integrity from '../../lib/integrity.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as golden from '../support/golden.ts';
import { actionEvent } from '../support/execution-reads.ts';
import { WRONG_ADD, greenFixture, greenWrites, stopReason } from '../support/golden-run.ts';
import * as gitShell from '../support/git-shell.ts';
import * as harnessRuns from '../support/harness-runs.ts';
import * as keys from '../support/keys.ts';

const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);
const GREEN_RECOVERY = keys.responseKey('green', 1, 'recover', 1);
const violationsOf = (event: events.ActionEvent) => event.integrityViolations as integrity.IntegrityViolation[];

test('golden: an integrity violation restores the baseline and stops at needs-human', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  let agentCommit: string | undefined;
  harnessRuns.afterEachCall(fixture, (call) => {
    if (call.phase === 'red') {
      gitShell.sh(fixture.worktree, 'add', '-A');
      gitShell.sh(fixture.worktree, 'commit', '-q', '-m', 'agent commit');
      agentCommit = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
    }
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(fixture, 'red', 'red')!;
  assert.equal(red.outcome, 'integrity-violation');
  assert.equal(red.direction, 'stop');
  assert.ok(
    violationsOf(red).some((violation) => violation.surface === 'head'),
    JSON.stringify(red.integrityViolations),
  );
  assert.notEqual(agentCommit, fixture.base);
  assert.equal(
    gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'),
    fixture.base,
    'the branch is back at the baseline head',
  );
  assert.equal(
    gitShell.sh(fixture.worktree, 'branch', '--contains', agentCommit!),
    '',
    'the agent commit is gone from the branch',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), '');
  assert.equal(fixture.harness.calls.length, 1, 'no retry after a violation');
  const reason = stopReason(fixture, {
    vertex: 'red',
    action: 'red',
    recovery: 0,
    outcome: 'integrity-violation',
    rule: { table: 'fixed', row: 'integrity-violation' },
  });
  assert.match(reason.text, /integrity/i);
  assert.match(fixture.gh.comments[0].body, /\bhead\b/, 'the comment names the surface');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:needs-human'], 'the ticket is at needs-human');
});

test('an integrity violation removes an injected ignored Protected File and restores a pre-existing one', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  mkdirSync(join(fixture.worktree, '.claude', 'skills', 'injected'), { recursive: true });
  writeFileSync(join(fixture.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(fixture.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  harnessRuns.afterEachCall(fixture, (call) => {
    if (call.phase === 'red') {
      writeFileSync(join(fixture.worktree, '.claude', 'skills', 'injected', 'SKILL.md'), 'injected\n');
      writeFileSync(local, '{"agent":true}\n');
    }
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(fixture, 'red', 'red')!;
  assert.equal(red.outcome, 'integrity-violation');
  const protectedFiles = violationsOf(red).find((violation) => violation.surface === 'protected')!;
  assert.deepEqual((protectedFiles.after as string[]).sort(), [
    '.claude/settings.local.json',
    '.claude/skills/injected/SKILL.md',
  ]);
  assert.ok(
    !existsSync(join(fixture.worktree, '.claude', 'skills', 'injected', 'SKILL.md')),
    'the injected skill is removed',
  );
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', 'the pre-existing file keeps its baseline bytes');
});
test('a recovery pass that changes the committed test is rolled back to its baseline and stops', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': WRONG_ADD, 'test/add.test.mjs': '// weakened\n' }),
    },
    integrity: 'real',
    git: 'real',
  });
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  const call = actionEvent(fixture, 'green', 'green', 1)!;
  assert.equal(call.outcome, 'integrity-violation');
  assert.deepEqual(call.integrityViolations, [
    { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] },
  ]);
  assert.equal(
    gitShell.sh(fixture.worktree, 'status', '--porcelain'),
    '',
    'no forbidden edit or implementation file survives',
  );
  assert.ok(
    !readFileSync(join(fixture.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'),
    'the committed test bytes are restored',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'rev-list', '--count', 'HEAD'), '2', 'the red commit survives');
});

// Ignored paths survive git clean, so the rollback removes the ignored tests the agent added and only those.
function excludeTests(fixture: golden.GoldenFixture, ...paths: string[]) {
  writeFileSync(
    resolve(fixture.worktree, gitShell.sh(fixture.worktree, 'rev-parse', '--git-path', 'info/exclude')),
    paths.join('\n'),
  );
}

test('a recovery pass that adds an ignored test file has it removed by the rollback', async (t) => {
  const fixture = await greenFixture(t, {
    responses: {
      [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
      [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': WRONG_ADD, 'test/injected.test.mjs': 'injected' }),
    },
    integrity: 'real',
    git: 'real',
  });
  excludeTests(fixture, 'test/injected.test.mjs');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(fixture, 'green', 'green', 1)!.integrityViolations, [
    { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['test/injected.test.mjs'] },
  ]);
  assert.ok(
    !existsSync(join(fixture.worktree, 'test', 'injected.test.mjs')),
    'the ignored test the agent added is removed',
  );
});

test(
  'a recovery pass that adds an ignored file under a declared test path outside the default globs ' +
    'has it removed by the rollback',
  async (t) => {
    const fixture = await greenFixture(t, {
      responses: {
        [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
        [GREEN_RECOVERY]: greenWrites({ 'lib/add.mjs': WRONG_ADD, 'spec/injected.mjs': 'injected' }),
      },
      integrity: 'real',
      git: 'real',
    });
    fixture.options.pinned.configuration.testPaths = ['test/**', 'spec/**'];
    excludeTests(fixture, 'spec/injected.mjs');
    const { outcome } = await interpreter.runExecution(fixture.options);

    assert.equal(outcome, 'needs-human');
    assert.deepEqual(actionEvent(fixture, 'green', 'green', 1)!.integrityViolations, [
      { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['spec/injected.mjs'] },
    ]);
    assert.ok(
      !existsSync(join(fixture.worktree, 'spec', 'injected.mjs')),
      'the ignored test the agent added is removed',
    );
  },
);

test('an ignored test file that was there before the call gets its bytes back from the rollback', async (t) => {
  const fixture = await greenFixture(t, {
    responses: { [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD, 'test/owner.test.mjs': 'agent' }) },
    integrity: 'real',
    git: 'real',
  });
  excludeTests(fixture, 'test/owner.test.mjs');
  mkdirSync(join(fixture.worktree, 'test'), { recursive: true });
  writeFileSync(join(fixture.worktree, 'test', 'owner.test.mjs'), 'owner');
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(fixture, 'green', 'green')!.integrityViolations, [
    { worktree: fixture.worktree, surface: 'committed tests', before: null, after: ['test/owner.test.mjs'] },
  ]);
  assert.equal(readFileSync(join(fixture.worktree, 'test', 'owner.test.mjs'), 'utf8'), 'owner');
});

test(
  'an integrity violation on a Protected File also removes ' + 'an ignored test file the same Attempt added',
  async (t) => {
    const fixture = await greenFixture(t, {
      responses: {
        [GREEN_CALL]: greenWrites({ 'lib/add.mjs': WRONG_ADD }),
        [GREEN_RECOVERY]: greenWrites({ 'test/injected.test.mjs': 'injected', 'AGENTS.md': 'agent' }),
      },
      integrity: 'real',
      git: 'real',
    });
    excludeTests(fixture, 'test/injected.test.mjs');
    const { outcome } = await interpreter.runExecution(fixture.options);

    assert.equal(outcome, 'needs-human');
    assert.equal(actionEvent(fixture, 'green', 'green', 1)!.outcome, 'integrity-violation');
    assert.ok(
      !existsSync(join(fixture.worktree, 'test', 'injected.test.mjs')),
      'the ignored test the agent added is removed',
    );
  },
);
