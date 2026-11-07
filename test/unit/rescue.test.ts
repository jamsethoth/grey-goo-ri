// The rescue's decisions over the fake git and the fake integrity: a test-writing Vertex's failure routed on, whose
// untracked test file the fake models. What real files and real git do with a rescue is in
// test/e2e/interpreter.rescue.test.ts.
import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../../lib/interpreter.ts';
import * as rescue from '../../lib/rescue.ts';
import { actionEvent, intents, loadTicket } from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';
import { terminalReasonOf } from '../support/golden-run.ts';
import * as rescueFlow from '../support/rescue-flow.ts';

const TEST_FILE = 'test/extra.test.mjs';
const inWorktree = (fixture: golden.GoldenFixture, path: string) => existsSync(join(fixture.worktree, path));
const rescueMarker = (fixture: golden.GoldenFixture) =>
  golden.markerOf(fixture.executionRecord, 'red', 1, 'rescue', 1, 1);
const resetMarker = (fixture: golden.GoldenFixture) =>
  golden.markerOf(fixture.executionRecord, 'red', 1, 'reset', 1, 1);
const refOf = (fixture: golden.GoldenFixture) => rescue.rescueRef(rescueMarker(fixture));

// red's tests pass before any implementation, so its Check fails in both passes and its failure routes to senior-red,
// which stops.
async function failedRed(t: TestContext) {
  const fixture = await golden.fixture(t, { responses: rescueFlow.failingRed({ [TEST_FILE]: 'a test\n' }) });
  golden.configure(fixture, rescueFlow.routeRedFailureToSenior);
  return fixture;
}

const heldNaming = (fixture: golden.GoldenFixture, ref: string) => {
  assert.deepEqual(terminalReasonOf(fixture).decidedBy, { hold: 'rescue' });
  assert.ok(terminalReasonOf(fixture).text.includes(ref), terminalReasonOf(fixture).text);
};

test('a failure routed to a Vertex moves its work to a Rescue Ref and leaves the rescue output', async (t) => {
  const fixture = await failedRed(t);
  const { outcome } = await interpreter.runExecution(fixture.options);
  assert.equal(outcome, 'needs-human', 'senior-red stopped');
  const ref = refOf(fixture);
  const { git } = fixture.options.deps;
  const commit = (await git.refTarget(fixture.worktree, ref)) as string;
  assert.deepEqual(await git.changedPaths(fixture.worktree, fixture.base, commit), ['lib/add.mjs', TEST_FILE]);
  assert.equal(inWorktree(fixture, TEST_FILE), false, 'the reset removed it');
  assert.deepEqual(fixture.executionRecord.outputs.find((output) => output.action === 'rescue')?.value, {
    ref,
    diffStat: { files: 2, insertions: 2, deletions: 0, testFiles: 1, testInsertions: 1 },
    output: golden.GREEN_OUTPUT,
  });
  assert.equal(actionEvent(fixture, 'red', 'rescue', 1)?.outcome, 'ok');
  assert.ok(fixture.executionRecord.history.some((item) => item.kind === 'rescued' && String(item.text).includes(ref)));
});

test('a worktree at its baseline makes no ref and no reset', async (t) => {
  const fixture = await golden.fixture(t, { responses: rescueFlow.failingRed({}) });
  golden.configure(fixture, rescueFlow.routeRedFailureToSenior);
  await interpreter.runExecution(fixture.options);
  assert.equal(await fixture.options.deps.git.refTarget(fixture.worktree, refOf(fixture)), null);
  assert.deepEqual(intents(fixture.executionRecord, 'rescue'), []);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(fixture.executionRecord.visits['senior-red'], 1, 'the route is still taken');
});

test('a ref already holding another commit holds, with nothing overwritten or reset', async (t) => {
  const fixture = await failedRed(t);
  const { git } = fixture.options.deps;
  await git.createRef(fixture.worktree, refOf(fixture), fixture.base);
  const { held } = await interpreter.runExecution(fixture.options);
  assert.equal(held, true);
  assert.equal(await git.refTarget(fixture.worktree, refOf(fixture)), fixture.base);
  assert.equal(inWorktree(fixture, TEST_FILE), true);
  heldNaming(fixture, refOf(fixture));
});

test('a worktree that changes once the ref is made holds before any reset', async (t) => {
  const fixture = await failedRed(t);
  const { git } = fixture.options.deps;
  fixture.options.deps.git = {
    ...git,
    createRef: async (...args) => {
      const made = await git.createRef(...args);
      writeFileSync(join(fixture.worktree, 'late.txt'), 'a writer nobody knew of\n');
      return made;
    },
  };
  const { held } = await interpreter.runExecution(fixture.options);
  assert.equal(held, true);
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  heldNaming(fixture, refOf(fixture));
});

test('HEAD moved since the Visit began holds, with no ref made', async (t) => {
  const fixture = await failedRed(t);
  // The last Check's run moves it, after the Attempts' Integrity Assertions.
  const { runShell } = fixture.options.deps.exec;
  fixture.options.deps.exec = {
    runShell: (...args) => {
      if (fixture.executionRecord.cursor.recovery === 1) fixture.fakeIntegrity!.commit(fixture.worktree);
      return runShell(...args);
    },
  };
  const { held } = await interpreter.runExecution(fixture.options);
  assert.equal(held, true);
  assert.deepEqual(terminalReasonOf(fixture).decidedBy, { hold: 'rescue' });
  assert.deepEqual(intents(fixture.executionRecord, 'rescue'), []);
  assert.equal(inWorktree(fixture, TEST_FILE), true);
});

test('a reset that fails holds with the state rescued', async (t) => {
  const fixture = await failedRed(t);
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    resetTo: async () => {
      throw new Error('unable to unlink');
    },
  };
  const { held } = await interpreter.runExecution(fixture.options);
  assert.equal(held, true);
  assert.notEqual(await fixture.options.deps.git.refTarget(fixture.worktree, refOf(fixture)), null);
  assert.equal(inWorktree(fixture, TEST_FILE), true);
  heldNaming(fixture, refOf(fixture));
  assert.match(terminalReasonOf(fixture).text, /unable to unlink/);
});

test('a reset that leaves the worktree unlike its baseline holds', async (t) => {
  const fixture = await failedRed(t);
  const { git } = fixture.options.deps;
  fixture.options.deps.git = {
    ...git,
    resetTo: async (...args) => {
      await git.resetTo(...args);
      fixture.fakeIntegrity!.write(fixture.worktree, 'stray.txt');
    },
  };
  const { held } = await interpreter.runExecution(fixture.options);
  assert.equal(held, true);
  heldNaming(fixture, refOf(fixture));
});

const CRASHES: Record<string, (fixture: golden.GoldenFixture) => NonNullable<interpreter.ExecutionOptions['crashAt']>> =
  {
    'before its ref is made': (fixture) => ({ marker: rescueMarker(fixture), point: 'before-effect' }),
    'before the reset is intended': (fixture) => ({ marker: resetMarker(fixture), point: 'before-intent' }),
    'after the rescue completes': (fixture) => ({ marker: rescueMarker(fixture), point: 'after-completion' }),
  };
for (const [place, crashAt] of Object.entries(CRASHES)) {
  test(`a crash resumes at the next step with one History item: ${place}`, async (t) => {
    const fixture = await failedRed(t);
    await assert.rejects(
      interpreter.runExecution({ ...fixture.options, crashAt: crashAt(fixture) }),
      (err) => err instanceof interpreter.CrashError,
    );
    const { outcome } = await interpreter.runExecution({ ...fixture.options, record: await loadTicket(fixture) });
    assert.equal(outcome, 'needs-human', 'senior-red stopped');
    const saved = await loadTicket(fixture);
    assert.equal(saved.history.filter((item) => item.kind === 'rescued').length, 1);
    assert.equal(saved.visits['senior-red'], 1);
    assert.equal(saved.outputs.filter((output) => output.action === 'rescue').length, 1);
  });
}
