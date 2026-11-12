import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as reset from '../../lib/effects/reset.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as effectFixture from '../support/effect-fixture.ts';

type Fixture = Awaited<ReturnType<typeof effectFixture.effectFixture>>;

const HISTORY = { kind: 'integrity violation', text: 'The agent wrote outside its scope.' };
const AGENT_PACKAGE = '{ "agent": true }\n';

// The agent's work: a tracked file changed and an untracked file added. The reset's intent saves the worktree as the
// agent left it, and the baseline it resets to.
async function agentLeft(given: Fixture) {
  const original = readFileSync(join(given.worktree, 'package.json'), 'utf8');
  given.write('package.json', AGENT_PACKAGE);
  given.write('extra.txt', 'left by the agent\n');
  const left = await given.context.integrity.snapshot(given.worktree);
  const payload: reset.Payload = {
    baseline: given.fixture.base,
    history: HISTORY,
    left: { head: left.head, index: left.index, tree: left.tree, files: {} },
  };
  const actionMarker = given.markerOf('reset');
  given.database.intent(given.executionRecord, actionMarker, reset.effect.name, payload);
  return { entry: given.intent(reset.effect, actionMarker, payload), payload, original };
}

// The agent's tracked change undone, as git's hard reset leaves it, and its untracked file cleaned or not yet.
function hardReset(given: Fixture, original: string, { cleaned }: { cleaned: boolean }) {
  given.write('package.json', original);
  if (cleaned) rmSync(join(given.worktree, 'extra.txt'));
}

test('a reset made resets the worktree to its baseline and adds its History item', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const { payload } = await agentLeft(given);
  assert.deepEqual(await reset.effect.perform(given.context, payload, { redo: false }), { head: given.fixture.base });
  assert.equal(await given.context.integrity.isCleanAt(given.worktree), true);
  assert.deepEqual(given.executionRecord.history, [HISTORY]);
});

// Where an open reset can be found, and whether Reconciliation finishes it from there: as the agent left it, partway
// through (tracked files back, its untracked file not yet cleaned), once the git reset landed, or a human's.
const STATES: [string, (given: Fixture, original: string) => void, 'finished' | 'held'][] = [
  ['the worktree as the agent left it', () => {}, 'finished'],
  [
    'the tracked files back and the untracked file left',
    (given, original) => hardReset(given, original, { cleaned: false }),
    'finished',
  ],
  ['the reset landed', (given, original) => hardReset(given, original, { cleaned: true }), 'finished'],
  ["a human's change", (given) => given.write('package.json', '{ "human": true }\n'), 'held'],
];
for (const [state, arrange, finished] of STATES) {
  test(`an open reset found with ${state} is ${finished}`, async (t) => {
    const given = await effectFixture.effectFixture(t);
    const { entry, original } = await agentLeft(given);
    arrange(given, original);
    assert.equal(await given.proven(entry), finished === 'finished', 'its worktree proof agrees');
    const context = { git: given.git, integrity: given.context.integrity, database: given.database };
    assert.equal(await reset.finish(given.executionRecord, entry, context), finished);
    if (finished === 'held') {
      assert.deepEqual(executionReads.writeAheadSteps(given.executionRecord, entry.actionMarker), ['intent']);
      assert.deepEqual(given.executionRecord.history, [], 'nothing is discarded or added');
      return;
    }
    assert.equal(await given.context.integrity.isCleanAt(given.worktree), true);
    assert.deepEqual(executionReads.writeAheadSteps(given.executionRecord, entry.actionMarker), ['intent', 'evidence']);
    assert.deepEqual(given.executionRecord.history, [HISTORY]);
  });
}

test('the open resets are the reset intents not yet complete', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const { entry } = await agentLeft(given);
  assert.deepEqual(
    reset.openResets(given.executionRecord).map((open) => open.actionMarker),
    [entry.actionMarker],
  );
  given.database.complete(given.executionRecord, entry.actionMarker);
  assert.deepEqual(reset.openResets(given.executionRecord), []);
});
