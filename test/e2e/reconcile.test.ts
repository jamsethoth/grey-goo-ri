import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as exec from '../../lib/exec.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as integrity from '../../lib/integrity.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as rescue from '../../lib/rescue.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as afterPhase from '../support/after-phase.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as gitShell from '../support/git-shell.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as interruptedCall from '../support/interrupted-call.ts';
import * as keys from '../support/keys.ts';
import * as rescueFlow from '../support/rescue-flow.ts';
import * as resetInterruption from '../support/reset-interruption.ts';

// red's Attempt writes a Protected File, an Integrity Violation whose reset is interrupted by a crash at `when`: before
// the reset, or after it.
async function crashedViolation(t: TestContext, when: 'before reset' | 'after reset') {
  const responses = structuredClone(golden.firstVisitResponses);
  (responses['red/1/red/1']?.files as Record<string, string>)['.agents/injected.json'] = '{}\n';
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real' });
  const git = fixture.options.deps.git;
  fixture.options.deps.git = resetInterruption.crashingReset(git, { after: when === 'after reset' });
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  return { ...fixture, loaded: executionReads.loadTicket(fixture), uncrashedGit: git };
}

test('a crash after the reset of an Integrity Violation keeps its History item exactly once', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  assert.deepEqual(crashed.loaded.history, [], 'the crash came before the History item was saved');
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent']);

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'continue');
  // Read again: the first assertion narrowed the record's own History to empty.
  const history: record.ExecutionRecord['history'] = crashed.loaded.history;
  assert.equal(history.length, 1);
  assert.equal(history[0]?.kind, 'integrity violation');
  assert.match(history[0]?.text as string, /changed protected/);
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent', 'evidence', 'complete']);
  assert.deepEqual(writeAhead.openIntents(crashed.loaded), []);

  const saved = executionReads.loadTicket(crashed);
  assert.deepEqual(saved.history, crashed.loaded.history, 'the History item is persisted');
  assert.equal(await reconcile.resets(saved, { git: crashed.options.deps.git }), 'continue');
  assert.equal(saved.history.length, 1, 'a second Reconciliation adds nothing');
});

test('a crash before the reset is finished by Reconciliation while the worktree is as the agent left it', async (t) => {
  const crashed = await crashedViolation(t, 'before reset');
  assert.notEqual(
    gitShell.sh(crashed.worktree, 'status', '--porcelain'),
    '',
    'the agent changes are still in the worktree',
  );

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.uncrashedGit }), 'continue');
  assert.equal(
    gitShell.sh(crashed.worktree, 'status', '--porcelain'),
    '',
    "the record proves the changes the agent's, so they are discarded",
  );
  assert.deepEqual(
    crashed.loaded.history.map((item) => item.kind),
    ['integrity violation'],
  );
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent', 'evidence', 'complete']);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a crash before the reset holds the Execution and discards nothing once a human changed the worktree', async (t) => {
  const crashed = await crashedViolation(t, 'before reset');
  writeFileSync(join(crashed.worktree, 'human.txt'), 'mine\n');
  const dirty = gitShell.sh(crashed.worktree, 'status', '--porcelain');

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'held');
  assert.equal(gitShell.sh(crashed.worktree, 'status', '--porcelain'), dirty, 'nothing is discarded at resume');
  assert.deepEqual(crashed.loaded.history, []);
  assert.equal(
    (writeAhead.openIntents(crashed.loaded)[0]?.payload as { history: { kind: string } }).history.kind,
    'integrity violation',
    'the reason waits in the open intent',
  );
});

test('an assume-unchanged edit left at the baseline does not prove the reset done', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  const [tracked] = gitShell.sh(crashed.worktree, 'ls-files').split('\n') as [string];
  gitShell.sh(crashed.worktree, 'update-index', '--assume-unchanged', tracked);
  writeFileSync(join(crashed.worktree, tracked), 'a hidden agent edit\n');
  assert.equal(gitShell.sh(crashed.worktree, 'status', '--porcelain'), '', 'git status cannot see it');

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'held');
  assert.deepEqual(crashed.loaded.history, []);
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent']);
});

test('an ignored test added after an interrupted reset holds the restore and is kept', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  writeFileSync(join(crashed.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  mkdirSync(join(crashed.worktree, 'test'), { recursive: true });
  writeFileSync(join(crashed.worktree, 'test', 'human.test.mjs'), 'mine\n');

  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'held');
  assert.equal(
    readFileSync(join(crashed.worktree, 'test', 'human.test.mjs'), 'utf8'),
    'mine\n',
    'the human file is untouched',
  );
  assert.deepEqual(crashResume.resetEntries(crashed.loaded), ['intent']);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a crash between the reset and the Protected File restore of an integrity violation is finished by Reconciliation', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  mkdirSync(join(fixture.worktree, '.claude'), { recursive: true });
  writeFileSync(join(fixture.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(fixture.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  afterPhase.afterPhase(fixture, 'red', () => writeFileSync(local, '{"agent":true}\n'));
  const git = fixture.options.deps.git;
  fixture.options.deps.git = resetInterruption.crashingReset(git, { after: true });
  await assert.rejects(interpreter.runExecution(fixture.options), (err) => err instanceof interpreter.CrashError);
  assert.equal(readFileSync(local, 'utf8'), '{"agent":true}\n', 'the crash came before the restore');

  const loaded = executionReads.loadTicket(fixture);
  assert.equal(await reconcile.resets(loaded, { git }), 'continue');
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', "the owner's bytes come back from the saved intent");
  assert.equal(loaded.history[0]?.kind, 'integrity violation');
  assert.deepEqual(writeAhead.openIntents(loaded), []);
});

test('Reconciliation uses an injected integrity', async (t) => {
  const crashed = await crashedViolation(t, 'after reset');
  // The real worktree is clean at the reset's baseline, so only the injected integrity can make it look a human's.
  const elsewhere = { head: 'elsewhere', index: 'elsewhere', tree: 'elsewhere' };
  const injected = {
    snapshot: async () => elsewhere,
    isCleanAt: async () => false,
    untrackedFiles: async () => ({}),
    ignoredFiles: async () => ({}),
  } as unknown as integrity.Integrity;
  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git, integrity: injected }), 'held');
  assert.deepEqual(
    await reconcile.dirtyState(null, {
      git: crashed.options.deps.git,
      worktree: crashed.worktree,
      integrity: injected,
    }),
    { conflicts: [], stat: '', rescueRef: null },
  );
  assert.equal(await reconcile.resets(crashed.loaded, { git: crashed.options.deps.git }), 'continue');
});

// Interrupted Attempts (#68, ADR 0011): red's call is cut short by gg's death, and the next Execution recovers it.
const terminalText = (fixture: golden.GoldenFixture) => executionReads.loadTicket(fixture).terminalReason?.text ?? '';
const inWorktree = (fixture: golden.GoldenFixture, path: string) => existsSync(join(fixture.worktree, path));

test('an interrupted attempt is rescued, reset and retried once', async (t) => {
  const fixture = await interruptedCall.interruptedFixture(t, { 1: 'job' });
  await interruptedCall.crashed(fixture);
  const result = await interruptedCall.resumed(fixture);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  const ref = interruptedCall.refOf(fixture, 1);
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref]);
  for (const [path, content] of Object.entries(interruptedCall.LEFT))
    assert.equal(`${rescueFlow.inRef(fixture, ref, path)}\n`, content, `the Rescue Ref holds ${path}`);
  assert.equal(inWorktree(fixture, 'notes.txt'), false, 'the worktree was reset');
  const calls = interruptedCall.redCalls(fixture);
  assert.deepEqual(
    calls.map((call) => call.marker?.split(':').at(-1)),
    ['1', '2'],
    'one retry, a new Attempt of the same Action',
  );
  assert.equal(calls[1]?.resume, null, 'the retry starts a fresh Session');
  assert.ok(calls[1]?.brief?.startsWith(calls[0]!.brief!.split('\n\n## ')[0]!), 'with the full Brief');
  assert.ok(calls[1]?.brief?.includes(ref), 'whose History names the Rescue Ref');
  assert.equal(interruptedCall.crashBudget(fixture), 1);
  const rescued = executionReads.loadTicket(fixture).history.filter((item) => item.kind === 'rescued');
  assert.equal(rescued.length, 1);
  assert.ok(rescued[0]?.text.includes(ref), 'the History names the Rescue Ref');
});

test('admission does not hold the worktree an interrupted attempt left', async (t) => {
  const fixture = await interruptedCall.interruptedFixture(t, { 1: 'job' });
  await interruptedCall.crashed(fixture);
  assert.equal(
    await reconcile.dirtyState(executionReads.loadTicket(fixture), {
      git: fixture.options.deps.git,
      worktree: fixture.worktree,
    }),
    null,
  );
});

test('a crash before the retry launches resumes at the retry', async (t) => {
  const fixture = await interruptedCall.interruptedFixture(t, { 1: 'job' });
  await interruptedCall.crashed(fixture);
  const retry = golden.markerOf(fixture.executionRecord, 'red', 1, 'red', 0, 2);
  await interruptedCall.crashed(fixture, { crashAt: { marker: retry, point: 'before-intent' } });
  const result = await interruptedCall.resumed(fixture);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [interruptedCall.refOf(fixture, 1)], 'no second Rescue Ref');
  assert.equal(executionReads.intents(executionReads.loadTicket(fixture), 'reset').length, 1, 'no repeated reset');
  assert.equal(interruptedCall.crashBudget(fixture), 1, 'no second budget charge');
  assert.equal(interruptedCall.redCalls(fixture).length, 2, 'the retry launched once');
});

test('a change after the last heartbeat is rescued, not held', async (t) => {
  const fixture = await interruptedCall.interruptedFixture(t, { 1: 'job' });
  await interruptedCall.crashed(fixture);
  writeFileSync(join(fixture.worktree, 'late.txt'), 'written after the last heartbeat\n');
  const result = await interruptedCall.resumed(fixture);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  const ref = interruptedCall.refOf(fixture, 1);
  assert.equal(rescueFlow.inRef(fixture, ref, 'late.txt'), 'written after the last heartbeat');
  const history = executionReads.loadTicket(fixture).history;
  assert.ok(
    history.some((item) => item.text.includes(ref)),
    'the History names the Rescue Ref',
  );
});

for (const [how, name] of [
  ['none', 'an uncontained interrupted attempt is rescued and held, not reset'],
  ['unsaved', 'a crash before the containment kind is saved is rescued and held'],
] as const) {
  test(name, async (t) => {
    const fixture = await interruptedCall.interruptedFixture(t, { 1: how });
    await interruptedCall.crashed(fixture);
    const result = await interruptedCall.resumed(fixture);

    assert.equal(result.held, true, JSON.stringify(result));
    const ref = interruptedCall.refOf(fixture, 1);
    assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref], 'the work is rescued');
    assert.equal(rescueFlow.inRef(fixture, ref, 'notes.txt'), 'what red tried');
    assert.equal(inWorktree(fixture, 'notes.txt'), true, 'and not reset');
    assert.deepEqual(executionReads.intents(executionReads.loadTicket(fixture), 'reset'), []);
    assert.ok(terminalText(fixture).includes(ref), 'the hold names the Rescue Ref');
    assert.equal(interruptedCall.redCalls(fixture).length, 1, 'nothing was retried');
  });
}

test("an interrupted later attempt is reset to the visit's first baseline and retried", async (t) => {
  // Attempt 1 leaves uncommitted work and a response that fails to parse, so Attempt 2's baseline holds that work.
  const parseFailure = { files: { 'first.txt': 'what attempt 1 left\n' }, response: 'not json' };
  const fixture = await interruptedCall.interruptedFixture(
    t,
    { 2: 'job' },
    { earlier: { [interruptedCall.callOf(1)]: parseFailure } },
  );
  await interruptedCall.crashed(fixture);
  const result = await interruptedCall.resumed(fixture);

  assert.equal(result.outcome, 'ready-for-qa', terminalText(fixture));
  const ref = interruptedCall.refOf(fixture, 2);
  assert.equal(rescueFlow.inRef(fixture, ref, 'first.txt'), 'what attempt 1 left', 'the earlier work is rescued');
  assert.equal(interruptedCall.redCalls(fixture).length, 3, 'and Attempt 3 retried it');
  assert.equal(interruptedCall.redCalls(fixture)[2]?.resume, null, 'Attempt 3 starts a fresh Session');
});

// The interrupted rescue and reset take Action ids of their own (D3 B), so the routed rescue after the retry's failure
// makes a second ref instead of finding the first.
test('an interrupted recovery pass and the routed failure after its retry keep their rescues apart', async (t) => {
  const responses = rescueFlow.failingRed({ 'notes.txt': 'first pass\n' });
  for (const [attempt, file] of [
    [1, 'interrupted.txt'],
    [2, 'retry.txt'],
  ] as const)
    responses[keys.responseKey('red', 1, 'recover', attempt)] = {
      files: { 'lib/add.mjs': goldenRun.RIGHT_ADD, [file]: `${file}\n` },
      response: golden.redResponse,
    };
  const fixture = await goldenRun.greenFixture(t, { responses, integrity: 'real', git: 'real' });
  golden.configure(fixture, rescueFlow.routeRedFailureToSenior);
  const run = fixture.harness.run as (...args: unknown[]) => Promise<unknown>;
  // gg dies during the recovery pass's first call, once the Harness has written its files.
  fixture.harness.run = (async (call: Record<string, unknown>, ...hooks: unknown[]) => {
    const result = await run(call, ...hooks);
    if (String(call.marker).includes(':red:1:red:1:') && call.attempt === 1)
      throw new interpreter.CrashError(`gg was killed during ${call.marker as string}`);
    return result;
  }) as typeof fixture.harness.run;
  await interruptedCall.crashed(fixture);
  await interruptedCall.resumed(fixture);

  const executionRecord = executionReads.loadTicket(fixture);
  const interrupted = rescue.rescueRef(golden.markerOf(executionRecord, 'red', 1, 'interrupted-rescue', 1, 1));
  const refs = rescueFlow.rescueRefs(fixture);
  assert.equal(refs.length, 2, `the interrupted and the routed rescue each made a ref: ${refs.join(', ')}`);
  assert.equal(rescueFlow.inRef(fixture, interrupted, 'interrupted.txt'), 'interrupted.txt');
  const routed = refs.find((ref) => ref !== interrupted)!;
  assert.equal(rescueFlow.inRef(fixture, routed, 'retry.txt'), 'retry.txt', "the routed ref keeps the retry's work");
});

test('a crash retry counts toward the Action Cap', async (t) => {
  const fixture = await interruptedCall.interruptedFixture(t, { 1: 'job' });
  golden.configure(fixture, (configured) => {
    configured.flows.golden!.actionCap = 1;
  });
  await interruptedCall.crashed(fixture);
  const result = await interruptedCall.resumed(fixture);

  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(interruptedCall.redCalls(fixture).length, 1, 'the retry did not launch past the cap');
  assert.equal(executionReads.loadTicket(fixture).attempts, 2, 'the retry was counted');
});

test("an interrupted attempt's rescue is not a vertex rescue output", async (t) => {
  const fixture = await interruptedCall.interruptedFixture(t, { 1: 'job' });
  await interruptedCall.crashed(fixture);
  await interruptedCall.resumed(fixture);

  assert.equal(rescueFlow.rescueRefs(fixture).length, 1, 'the Attempt was rescued');
  const { outputs } = executionReads.loadTicket(fixture);
  assert.deepEqual(
    // A rescue output carries its Rescue Ref (#118); none may come from the interrupted Attempt's rescue.
    outputs.filter((output) => 'ref' in output.value),
    [],
  );
});

test("a reset that cannot remove a locked file holds with the interrupted attempt's state rescued", async (t) => {
  const fixture = await interruptedCall.interruptedFixture(t, { 1: 'job' });
  await interruptedCall.crashed(fixture);
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    resetTo: async () => {
      throw new exec.CommandError('git reset failed', {
        code: 1,
        stdout: '',
        stderr: "error: unable to unlink old 'package.json': Permission denied",
      });
    },
  };
  const result = await interruptedCall.resumed(fixture);

  assert.equal(result.held, true, JSON.stringify(result));
  const ref = interruptedCall.refOf(fixture, 1);
  assert.deepEqual(rescueFlow.rescueRefs(fixture), [ref], 'the work is in the ref');
  assert.equal(rescueFlow.inRef(fixture, ref, 'notes.txt'), 'what red tried');
  assert.equal(inWorktree(fixture, 'notes.txt'), true, 'and still in the worktree');
  assert.ok(terminalText(fixture).includes(ref), 'the hold names the Rescue Ref');
});
