import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as interpreter from '../../lib/interpreter.mjs';
import * as golden from '../support/golden.mjs';
import { actionEvent, WRONG_ADD, ok, greenSetup, stopReason } from '../support/interpreter.mjs';

test('golden: an integrity violation restores the baseline and stops at needs-human', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') {
      golden.sh(g.worktree, 'add', '-A');
      golden.sh(g.worktree, 'commit', '-q', '-m', 'agent commit');
      g.agentCommit = golden.sh(g.worktree, 'rev-parse', 'HEAD');
    }
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(g, 'red', 'red');
  assert.equal(red.outcome, 'integrity-violation');
  assert.equal(red.direction, 'stop');
  assert.ok(red.violations.some((v) => v.surface === 'head'), JSON.stringify(red.violations));
  assert.notEqual(g.agentCommit, g.base);
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), g.base, 'the branch is back at the baseline head');
  assert.equal(golden.sh(g.worktree, 'branch', '--contains', g.agentCommit), '', 'the agent commit is gone from the branch');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '');
  assert.equal(g.harness.calls.length, 1, 'no retry after a violation');
  const reason = stopReason(g, { vertex: 'red', action: 'red', recovery: 0, outcome: 'integrity-violation', rule: { table: 'fixed', row: 'integrity-violation' } });
  assert.match(reason.text, /integrity/i);
  assert.match(g.gh.comments[0].body, /\bhead\b/, 'the comment names the surface');
  assert.deepEqual([...g.gh.labels], ['gg:state:needs-human'], 'the ticket is at needs-human');
});

test('an integrity violation removes an injected ignored Protected File and restores a pre-existing one', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  mkdirSync(join(g.worktree, '.claude', 'skills', 'injected'), { recursive: true });
  writeFileSync(join(g.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(g.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') {
      writeFileSync(join(g.worktree, '.claude', 'skills', 'injected', 'SKILL.md'), 'injected\n');
      writeFileSync(local, '{"agent":true}\n');
    }
    return out;
  };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const red = actionEvent(g, 'red', 'red');
  assert.equal(red.outcome, 'integrity-violation');
  assert.deepEqual(red.violations.find((v) => v.surface === 'protected').after.sort(),
    ['.claude/settings.local.json', '.claude/skills/injected/SKILL.md']);
  assert.ok(!existsSync(join(g.worktree, '.claude', 'skills', 'injected', 'SKILL.md')), 'the injected skill is removed');
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', 'the pre-existing file keeps its baseline bytes');
});
test('a recovery pass that changes the committed test is rolled back to its baseline and stops', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/add.test.mjs': '// weakened\n' }),
  }, 'real');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  const call = actionEvent(g, 'green', 'green', 1);
  assert.equal(call.outcome, 'integrity-violation');
  assert.deepEqual(call.violations, [{ worktree: g.worktree, surface: 'committed tests', before: null, after: ['test/add.test.mjs'] }]);
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), '', 'no forbidden edit or implementation file survives');
  assert.ok(!readFileSync(join(g.worktree, 'test', 'add.test.mjs'), 'utf8').includes('weakened'), 'the committed test bytes are restored');
  assert.equal(golden.sh(g.worktree, 'rev-list', '--count', 'HEAD'), '2', 'the red commit survives');
});

// Ignored paths survive git clean, so the rollback removes the ignored tests the agent added and only those.
function excludeTests(g, ...paths) {
  writeFileSync(resolve(g.worktree, golden.sh(g.worktree, 'rev-parse', '--git-path', 'info/exclude')), paths.join(String.fromCharCode(10)));
}

test('a recovery pass that adds an ignored test file has it removed by the rollback', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/injected.test.mjs': 'injected' }),
  }, 'real');
  excludeTests(g, 'test/injected.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(g, 'green', 'green', 1).violations, [{ worktree: g.worktree, surface: 'committed tests', before: null, after: ['test/injected.test.mjs'] }]);
  assert.ok(!existsSync(join(g.worktree, 'test', 'injected.test.mjs')), 'the ignored test the agent added is removed');
});

test('a recovery pass that adds an ignored file under a declared test path outside the default globs has it removed by the rollback', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'lib/add.mjs': WRONG_ADD, 'spec/injected.mjs': 'injected' }),
  }, 'real');
  g.options.testPaths = ['test/**', 'spec/**'];
  excludeTests(g, 'spec/injected.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(g, 'green', 'green', 1).violations, [{ worktree: g.worktree, surface: 'committed tests', before: null, after: ['spec/injected.mjs'] }]);
  assert.ok(!existsSync(join(g.worktree, 'spec', 'injected.mjs')), 'the ignored test the agent added is removed');
});

test('an ignored test file that was there before the call gets its bytes back from the rollback', async (t) => {
  const g = await greenSetup(t, { 'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD, 'test/owner.test.mjs': 'agent' }) }, 'real');
  excludeTests(g, 'test/owner.test.mjs');
  mkdirSync(join(g.worktree, 'test'), { recursive: true });
  writeFileSync(join(g.worktree, 'test', 'owner.test.mjs'), 'owner');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(actionEvent(g, 'green', 'green').violations, [{ worktree: g.worktree, surface: 'committed tests', before: null, after: ['test/owner.test.mjs'] }]);
  assert.equal(readFileSync(join(g.worktree, 'test', 'owner.test.mjs'), 'utf8'), 'owner');
});

test('an integrity violation on a Protected File also removes an ignored test file the same Attempt added', async (t) => {
  const g = await greenSetup(t, {
    'green/1/green/1': ok({ 'lib/add.mjs': WRONG_ADD }),
    'green/1/recover/1': ok({ 'test/injected.test.mjs': 'injected', 'AGENTS.md': 'agent' }),
  }, 'real');
  excludeTests(g, 'test/injected.test.mjs');
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.equal(actionEvent(g, 'green', 'green', 1).outcome, 'integrity-violation');
  assert.ok(!existsSync(join(g.worktree, 'test', 'injected.test.mjs')), 'the ignored test the agent added is removed');
});