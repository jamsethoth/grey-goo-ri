import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../../lib/config.ts';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as runFlows from '../../lib/run-flows.ts';
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
  fixture.options.config.repository.procedures.approval = {
    actions: [{ id: 'ask', do: 'await-approval', decisions: ['approved', 'rejected'] }],
  };
  const asking = runFixture.testConfig(fixture.root).flows.default as golden.ConfiguredFlow;
  asking.ticket.vertices.green!.route = { ok: 'approve' };
  asking.ticket.vertices.approve = {
    procedure: 'approval',
    route: { approved: 'publish', rejected: { end: 'needs-replan' } },
  };
  fixture.options.config.repository.flows.asking = asking;
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
  fixture.options.config.repository.agents.other = {
    ...fixture.options.config.repository.agents.implementer,
    harness: 'claude',
  };
  (other.ticket.vertices.red as { use: string }).use = 'other';
  fixture.options.config.repository.flows.other = other;
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
  record.save(executionRecord);

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

// The user's directory with `flows`, beside the fixture's repository source: a copy of its Agents, Procedures and
// files, and the machine settings.
function withUserFlows(fixture: runFixture.RunFixture, flows: Record<string, golden.ConfiguredFlow>) {
  const { repository, user } = fixture.options.config;
  const { agents, procedures, files } = structuredClone(repository);
  Object.assign(user, { flows, agents, procedures, files });
  return user as typeof user & { agents: typeof agents; procedures: typeof procedures };
}

test('--flow user:<name> runs the Flow the user declares', async (t) => {
  const fixture = runFixture.fixture(t, { fullFlow: true });
  withUserFlows(fixture, { light: runFixture.testConfig(fixture.root).flows.default! });
  const results = await run.runTarget({ ...fixture.options, flow: 'user:light' });
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  const vertexOf = (call: { marker?: string }) => marker.parseMarker(marker.markerTrailer(call.marker!))?.vertex;
  assert.deepEqual(fixture.harness.calls.map(vertexOf), ['red', 'green'], "the user's Flow has no reviewer");
  assert.equal((JSON.parse(fixture.loadRow()!) as { flow: string }).flow, 'user:light', 'the record pins user:light');
  assert.ok(
    fixture.logs.some((line) => line.includes(" under Flow user:light from the user's directory ")),
    JSON.stringify(fixture.logs),
  );
});

// A user Flow serves every repository, so it fails preflight only when selected (Q21).
test('preflight refuses a selected user Flow that names a command the repository does not declare', async (t) => {
  const fixture = runFixture.fixture(t);
  const user = withUserFlows(fixture, { strict: runFixture.testConfig(fixture.root).flows.default! });
  user.procedures.publish!.actions[0]!.command = 'lint';
  await assert.rejects(run.runTarget({ ...fixture.options, flow: 'user:strict' }), (err: Error) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: user:flows.strict: Flow user:strict names command "lint", which ' +
        `${fixture.options.config.repositoryFile} does not declare, so it cannot run in this repository ` +
        '[undeclared-command]',
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', 'the default Flow still runs');
});

// The Config Hash fingerprints a Flow's content, not its source (Q25): the same Flow, with files only another Agent
// names beside it, hashes alike from either source.
test("a user Flow's Config Hash equals the same Flow's declared in the repository", async (t) => {
  const fixture = runFixture.fixture(t);
  const user = withUserFlows(fixture, { default: runFixture.testConfig(fixture.root).flows.default! });
  user.agents.spare = { ...user.agents.implementer, persona: 'spare.md' };
  user.files['spare.md'] = { bytes: '# spare\n', hash: config.sha256('# spare\n') };
  const { flows } = await runFlows.admitConfiguration({
    config: fixture.options.config,
    harnesses: fixture.options.harnesses,
  });
  assert.ok(flows.get('user:default'), 'the user Flow is admitted');
  assert.equal(flows.get('user:default')?.hash, flows.get('default')?.hash);
});
