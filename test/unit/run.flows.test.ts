import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as approvalFlow from '../support/approval-flow.ts';
import * as executionContext from '../support/execution-context.ts';
import type * as golden from '../support/golden.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

const { BRANCH, TICKET } = runFixture;
const { IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL } = executionContext;

// The fixture's red, green and publish Flow as default, and as `asking` that Flow with an approve Vertex after green.
function askingFlow(t: TestContext, options: runFixture.RunFixtureOptions = {}) {
  const fixture = runFixture.fixture(t, options);
  fixture.options.config.procedures.approval = {
    actions: [{ id: 'ask', do: 'await-approval', decisions: ['approved', 'rejected'] }],
  };
  const asking = runFixture.testConfig(fixture.root).flows.default as golden.ConfiguredFlow;
  asking.ticket.vertices.green!.route = { ok: 'approve' };
  asking.ticket.vertices.approve = {
    procedure: 'approval',
    route: { approved: 'publish', rejected: { end: 'needs-replan' } },
  };
  fixture.options.config.flows.asking = asking;
  return fixture;
}

// The Approval Digest hashes the Config Hash, so a Decision taken under the pinned Flow is consumed only when the
// resumed Execution runs with that Flow's hash, not the Run's.
test("a resumed Execution's Decision is consumed under its pinned Flow's Config Hash", async (t) => {
  const fixture = askingFlow(t);
  assert.equal((await run.runTarget({ ...fixture.options, flow: 'asking' }))[0]!.outcome, 'pending');
  fixture.gh.permissions.set(approvalFlow.OWNER, 'write');
  fixture.gh.humanAddsLabel('gg:decide:approve:approved', approvalFlow.OWNER);

  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', fixture.logs.join('\n'));
  assert.ok(!fixture.logs.some((line) => line.includes(' is stale, ')), 'the request is not retired as stale');
});

test("a Run under one Flow ensures another declared Flow's Await and Decide Labels", async (t) => {
  const fixture = askingFlow(t);
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  for (const label of ['gg:await:approve', 'gg:decide:approve:approved', 'gg:decide:approve:rejected'])
    assert.ok(fixture.gh.repoLabels.has(label), label);
});

test('preflight names a Harness that fails in a Flow --flow does not name', async (t) => {
  const fixture = runFixture.fixture(t);
  const other = runFixture.testConfig(fixture.root).flows.default as golden.ConfiguredFlow;
  fixture.options.config.agents.other = { ...fixture.options.config.agents.implementer, harness: 'claude' };
  (other.ticket.vertices.red as { use: string }).use = 'other';
  fixture.options.config.flows.other = other;
  fixture.options.harnesses.claude = await import('../../lib/harnesses/claude.ts');
  await assert.rejects(run.runTarget({ ...fixture.options, flow: 'default' }), (err: Error) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: flows.other.ticket.vertices.red: vertex red: harness claude: not implemented [harness-preflight-failed]',
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
});

// A hold an earlier Run decided, whose report has not landed, is finished though its Flow is no longer declared: the
// Terminal runs no Vertex.
test('a decided hold whose Flow is no longer declared finishes its report', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL] });
  const { mainRoot, worktree } = fixture;
  await fixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  const executionRecord = unvisitedExecution.unvisitedExecution(fixture);
  executionRecord.flow = 'gone';
  executionRecord.admissionStop = {
    kind: 'hold',
    name: 'branch-mismatch',
    terminalReasonText: 'An earlier Run held the Ticket.',
    fresh: false,
    advice: 'Look at the branch.',
    detail: null,
    inProgress: false,
    error: null,
  };
  await record.save(executionRecord);

  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'needs-human', JSON.stringify(results));
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
  assert.ok(
    fixture.comments().some((body) => body.includes('An earlier Run held the Ticket.')),
    JSON.stringify(fixture.comments()),
  );
  const actionFlows = fixture.readEvents().flatMap((event) => (event.type === 'action' ? [event.flow] : []));
  assert.deepEqual([...new Set(actionFlows)], ['gone']);
});
