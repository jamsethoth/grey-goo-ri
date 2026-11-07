// The await-approval Action through the interpreter: an Approval Request, the Run it ends, and the Decision a later Run
// reads (request 3.5, X1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as approvalFlow from '../support/approval-flow.ts';
import { loadTicket } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as golden from '../support/golden.ts';
import * as keys from '../support/keys.ts';
import { editRuns } from '../support/suite-runs.ts';

const {
  APPROVED_LABEL,
  AWAIT_LABEL,
  OWNER,
  REJECTED_LABEL,
  approvalFixture,
  laterRun,
  requestComments,
  timelineReads,
} = approvalFlow;

const SECOND_GREEN = {
  [keys.responseKey('green', 2, 'green', 1)]: {
    files: { 'lib/add.mjs': 'export const add = (a, b) => b + a;\n' },
    response: golden.greenResponse,
  },
};

// An Approval Request's Actions, each at its request's number.
const requestTrace = (attempt: number) =>
  ['ask.retire', 'ask.await', 'ask.comment'].map((action) => ({
    vertex: 'approve',
    action,
    recovery: 0,
    attempt,
    outcome: 'ok',
  }));

test('golden: an approval request ends the run and a later approval routes on', async (t) => {
  const fixture = await approvalFixture(t);

  const first = await interpreter.runExecution(fixture.options);
  assert.equal(first.outcome, 'pending');
  const pending = await loadTicket(fixture);
  assert.equal(pending.state, 'active');
  assert.deepEqual(pending.cursor, { vertex: 'approve', visit: 1, action: 'ask', recovery: 0, attempt: 1 });
  const instance = pending.approvalRequest!;
  assert.equal(instance.id, `${pending.execution}:approve:1:1`);
  assert.ok(fixture.gh.labels.has(AWAIT_LABEL), 'the Await Label asks');
  const [comment, ...others] = requestComments(fixture);
  assert.deepEqual(others, [], 'one comment');
  assert.ok(comment!.includes(instance.id), comment);
  assert.ok(comment!.includes(instance.digest), comment);
  assert.ok(comment!.includes(APPROVED_LABEL), comment);
  assert.ok(comment!.includes(REJECTED_LABEL), comment);
  assert.deepEqual(approvalFlow.approveTrace(fixture), requestTrace(1));
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_end').length, 0, 'the Execution goes on');

  const waiting = await laterRun(fixture);
  assert.equal(waiting.outcome, 'pending');
  assert.equal(requestComments(fixture).length, 1, 'a waiting Run asks nothing more');

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const approved = await laterRun(fixture);
  assert.equal(approved.outcome, 'ready-for-qa');
  const ended = await loadTicket(fixture);
  assert.equal(ended.approvalRequest, null);
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false, 'the Decide Label is consumed');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), false, 'the Await Label is taken down');
  assert.deepEqual(approvalFlow.approveTrace(fixture), [
    ...requestTrace(1),
    { vertex: 'approve', action: 'ask', recovery: 0, attempt: 1, outcome: 'approved' },
  ]);
  assert.equal(fixture.gh.pr()?.isDraft, false, 'publish ran after the Decision');
  const consumption = ended.writeAheadLog.find(
    (entry) => entry.step === 'intent' && entry.actionMarker === golden.markerOf(ended, 'approve', 1, 'ask.consume'),
  );
  const { decision } = consumption!.payload as { decision: Record<string, unknown> };
  assert.equal(decision.instance, instance.id);
  assert.equal(decision.actor, OWNER);
  assert.equal(decision.outcome, 'approved');
  assert.equal(decision.next, 'publish');
  assert.equal(typeof decision.event, 'number');
  assert.equal(typeof decision.time, 'string');
});

test('a rejected decision routes back', async (t) => {
  const fixture = await approvalFixture(t, { responses: firstVisitWith(SECOND_GREEN) });
  await interpreter.runExecution(fixture.options);

  fixture.gh.humanAddsLabel(REJECTED_LABEL, OWNER);
  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'pending', 'green ran again and the next Visit asks again');
  const saved = await loadTicket(fixture);
  assert.equal(saved.visits.green, 2);
  assert.equal(saved.visits.approve, 2);
  assert.equal(saved.traversals['approve->green:rejected'], 1);
  assert.equal(saved.approvalRequest!.id, `${saved.execution}:approve:2:1`);
  assert.equal(fixture.gh.labels.has(REJECTED_LABEL), false);
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true);
  assert.equal(requestComments(fixture).length, 2);
});

test('a stale approval is re-requested', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  const digest = (await loadTicket(fixture)).approvalRequest?.digest;
  assert.ok(digest, 'the request was made');

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const result = await laterRun(fixture, { ticket: { ...fixture.options.ticket, body: 'The body, edited.' } });
  assert.equal(result.outcome, 'pending');
  const saved = await loadTicket(fixture);
  assert.equal(saved.approvalRequest!.id, `${saved.execution}:approve:1:2`);
  assert.notEqual(saved.approvalRequest!.digest, digest);
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false, 'the stale Decision is retired');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true, 'the Await Label asks again');
  assert.equal(requestComments(fixture).length, 2);
  assert.ok(requestComments(fixture).at(-1)!.includes(saved.approvalRequest!.digest));
  assert.deepEqual(approvalFlow.approveTrace(fixture), [...requestTrace(1), ...requestTrace(2)]);
});

test('a changed Config Hash makes an approval stale', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  assert.equal((await laterRun(fixture, { configHash: 'another-hash' })).outcome, 'pending');
  assert.equal((await loadTicket(fixture)).approvalRequest!.id.endsWith(':2'), true);
});

test('two surviving Decisions are retired and re-requested', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  fixture.gh.humanAddsLabel(REJECTED_LABEL, OWNER);
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false);
  assert.equal(fixture.gh.labels.has(REJECTED_LABEL), false);
  assert.equal(requestComments(fixture).length, 2);
});

test('an Await Label a human removed is re-requested', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.humanRemovesLabel(AWAIT_LABEL, OWNER);
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true);
  assert.equal(requestComments(fixture).length, 2);
});

test('a Decide Label for an Outcome the Action does not declare is no Decision', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.humanAddsLabel('gg:decide:approve:maybe', OWNER);
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(requestComments(fixture).length, 1);
});

test('a Decision by an actor below write permission is not read', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.permissions.set('a-triager', 'read');
  fixture.gh.humanAddsLabel(APPROVED_LABEL, 'a-triager');
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), true, 'it is left for a human to see');
});

test('a Decision by an actor GitHub does not know as a collaborator is not read', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.humanAddsLabel(APPROVED_LABEL, 'a-stranger');
  assert.equal((await laterRun(fixture)).outcome, 'pending');
});

test('a listed approver below write permission is accepted', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.permissions.set('a-triager', 'read');
  fixture.gh.humanAddsLabel(APPROVED_LABEL, 'a-triager');
  const result = await laterRun(fixture, { approvers: ['A-Triager'] });
  assert.equal(result.outcome, 'ready-for-qa');
});

test('a crash after consumption is not read twice', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.consume');
  await assert.rejects(
    laterRun(fixture, { crashAt: { marker: actionMarker, point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false, 'gg removed the Decide Label before the crash');
  const reads = timelineReads(fixture);

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'ready-for-qa', 'the unlabeled event gg made cannot undo the Decision');
  assert.equal(timelineReads(fixture), reads, 'the recorded consumption is completed, not read again');
});

test('golden: a crash before the decide label is removed completes the recorded consumption', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.consume');
  await assert.rejects(
    laterRun(fixture, { crashAt: { marker: actionMarker, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), true, 'the record came first');
  const reads = timelineReads(fixture);

  // A human takes the Decide Label away after gg consumed it: the record decides.
  fixture.gh.humanRemovesLabel(APPROVED_LABEL, OWNER);
  fixture.gh.humanAddsLabel(REJECTED_LABEL, OWNER);
  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'ready-for-qa');
  assert.equal(timelineReads(fixture), reads);
  assert.equal(approvalFlow.approveTrace(fixture).at(-1)!.outcome, 'approved');
});

test('a crash after the consumption completed routes the saved Decision', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.consume');
  await assert.rejects(
    laterRun(fixture, { crashAt: { marker: actionMarker, point: 'after-completion' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const reads = timelineReads(fixture);
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
  assert.equal(timelineReads(fixture), reads);
  const decided = approvalFlow.approveTrace(fixture).filter((event) => event.action === 'ask');
  assert.equal(decided.length, 1, 'its Event is written once');
});

for (const step of ['retire', 'await', 'comment']) {
  for (const point of ['before-effect', 'after-effect', 'after-completion'] as const) {
    test(`a crash ${point} of the request's ${step} finishes one request`, async (t) => {
      const fixture = await approvalFixture(t);
      const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, `ask.${step}`);
      await assert.rejects(
        interpreter.runExecution({ ...fixture.options, crashAt: { marker: actionMarker, point } }),
        (err) => err instanceof interpreter.CrashError,
      );
      const { approvalRequest } = await loadTicket(fixture);
      assert.ok(approvalRequest, 'the Pending Instance is saved before any label moves');

      assert.equal((await laterRun(fixture)).outcome, 'pending');
      const saved = await loadTicket(fixture);
      assert.deepEqual(saved.approvalRequest, approvalRequest, 'the same request goes on');
      assert.equal(requestComments(fixture).length, 1);
      assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true);
      assert.equal(writeAhead.openIntents(saved).length, 0);
    });
  }
}

test('an Await Label that cannot be written leaves the request to the next Run', async (t) => {
  const fixture = await approvalFixture(t);
  fixture.gh.fail({ matches: (args) => args.includes('--add-label') && args.includes(AWAIT_LABEL), status: 502 });
  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.outcome, 'pending');
  assert.equal(requestComments(fixture).length, 0);

  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true);
  assert.equal(requestComments(fixture).length, 1);
});

test('a timeline that cannot be read leaves the Ticket Pending', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  approvalFlow.failTimelineRead(fixture);

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'pending');
  assert.equal((await loadTicket(fixture)).state, 'active');
  assert.equal(requestComments(fixture).length, 1);
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa', 'the next Run reads it');
});

test('a human needs-human label abandons a Pending Execution through its next Run', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel('gg:state:needs-human', OWNER);
  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'abandoned');
});

test('a failed Check before the request gives failed, and no human is asked', async (t) => {
  const fixture = await approvalFixture(t);
  golden.configure(fixture, (configured) => {
    configured.procedures.approval = {
      actions: [
        { id: 'gate', do: 'check', kind: 'command', command: 'gate' },
        { id: 'ask', do: 'await-approval', decisions: ['approved', 'rejected'] },
      ],
    };
    configured.commands.gate = 'npm run gate';
  });
  fixture.options.commands = fixture.config.commands;
  editRuns(fixture, (run, command) => (command === 'npm run gate' ? { ...run, code: 1, output: 'gate failed' } : run));

  const result = await interpreter.runExecution(fixture.options);
  assert.equal(result.outcome, 'needs-human');
  assert.equal(fixture.executionRecord.terminalReason!.outcome, 'failed');
  assert.equal(requestComments(fixture).length, 0);
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), false);
});

test('a passed Check before the request runs once however many Runs the Ticket waits', async (t) => {
  const fixture = await approvalFixture(t);
  golden.configure(fixture, (configured) => {
    configured.procedures.approval = {
      actions: [
        { id: 'gate', do: 'check', kind: 'command', command: 'gate' },
        { id: 'ask', do: 'await-approval', decisions: ['approved', 'rejected'] },
      ],
    };
    configured.commands.gate = 'npm run gate';
  });
  fixture.options.commands = fixture.config.commands;
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(fixture.shells.filter(({ command }) => command === 'npm run gate').length, 1);
});
