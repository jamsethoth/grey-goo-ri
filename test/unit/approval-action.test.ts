// The await-approval Action through the interpreter: an Approval Request, the Run it ends, and the Decision a later Run
// reads (request 3.5, X1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as approvalAction from '../../lib/approval-action.ts';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as approvalFlow from '../support/approval-flow.ts';
import { loadTicket } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as fakeGh from '../support/fake-gh.ts';
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

// An Approval Request's Actions, each named with its request's number.
const requestTrace = (request: number) =>
  [`ask.retire.${request}`, `ask.await.${request}`, `ask.comment.${request}`].map((action) => ({
    vertex: 'approve',
    action,
    recovery: 0,
    attempt: 1,
    outcome: 'ok',
  }));

test('golden: an approval request ends the run and a later approval routes on', async (t) => {
  const fixture = await approvalFixture(t);

  const first = await interpreter.runExecution(fixture.options);
  assert.equal(first.outcome, 'pending');
  const pending = loadTicket(fixture);
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
  assert.ok(comment!.includes('reply in one or more comments on this Ticket'), 'it asks for answers in a comment');
  assert.deepEqual(approvalFlow.approveTrace(fixture), requestTrace(1));
  assert.equal(fixture.readEvents().filter((event) => event.type === 'ticket_end').length, 0, 'the Execution goes on');

  const waiting = await laterRun(fixture);
  assert.equal(waiting.outcome, 'pending');
  assert.equal(requestComments(fixture).length, 1, 'a waiting Run asks nothing more');

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const approved = await laterRun(fixture);
  assert.equal(approved.outcome, 'ready-for-qa');
  const ended = loadTicket(fixture);
  assert.equal(ended.approvalRequest, null);
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false, 'the Decide Label is consumed');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), false, 'the Await Label is taken down');
  assert.deepEqual(approvalFlow.approveTrace(fixture), [
    ...requestTrace(1),
    { vertex: 'approve', action: 'ask', recovery: 0, attempt: 1, outcome: 'approved' },
    golden.visitEnded('approve', 'publish', { outcome: 'approved', rule: { table: 'fixed', row: 'decision' } }),
  ]);
  assert.equal(fixture.gh.pr()?.isDraft, false, 'publish ran after the Decision');
  const consumption = ended.writeAheadLog.find(
    (entry) => entry.step === 'intent' && entry.actionMarker === golden.markerOf(ended, 'approve', 1, 'ask.consume.1'),
  );
  const { decision } = consumption!.payload as approvalAction.Consumption;
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
  const saved = loadTicket(fixture);
  assert.equal(saved.visits.get('green'), 2);
  assert.equal(saved.visits.get('approve'), 2);
  assert.equal(saved.traversals.get('approve->green:rejected'), 1);
  assert.equal(saved.approvalRequest!.id, `${saved.execution}:approve:2:1`);
  assert.equal(fixture.gh.labels.has(REJECTED_LABEL), false);
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true);
  assert.equal(requestComments(fixture).length, 2);
});

test('a stale approval is re-requested', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  const digest = loadTicket(fixture).approvalRequest?.digest;
  assert.ok(digest, 'the request was made');

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const result = await laterRun(fixture, { ticket: { ...fixture.options.ticket, body: 'The body, edited.' } });
  assert.equal(result.outcome, 'pending');
  const saved = loadTicket(fixture);
  assert.equal(saved.approvalRequest!.id, `${saved.execution}:approve:1:2`);
  assert.notEqual(saved.approvalRequest!.digest, digest);
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false, 'the stale Decision is retired');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true, 'the Await Label asks again');
  assert.equal(requestComments(fixture).length, 2);
  assert.ok(requestComments(fixture).at(-1)!.includes(saved.approvalRequest!.digest));
  assert.deepEqual(approvalFlow.approveTrace(fixture), [...requestTrace(1), ...requestTrace(2)]);
});

// The consumption intent's Decision in the record as saved now.
const consumedDecision = (fixture: golden.GoldenFixture) => {
  const saved = loadTicket(fixture);
  const actionMarker = golden.markerOf(saved, 'approve', 1, 'ask.consume.1');
  const intent = writeAhead.findEntry(saved, actionMarker, 'intent');
  return (intent?.payload as { decision?: Record<string, unknown> } | undefined)?.decision;
};

test('a consumed Decision saves its reply in the consumption intent', async (t) => {
  const fixture = await approvalFixture(t);
  fixture.gh.humanComments('A comment before the request.', OWNER);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanComments('1. A', OWNER);
  fixture.gh.humanComments('Not the approver.', 'someone-else');
  fixture.gh.humanComments('2. C', OWNER);

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
  assert.equal(consumedDecision(fixture)?.reply, '1. A\n\n2. C');
  const decided = fixture.readEvents().findLast((event) => event.type === 'action' && event.action === 'ask');
  assert.equal((decided as unknown as { decision: { reply: string } }).decision.reply, '1. A\n\n2. C');
  const output = loadTicket(fixture).outputs.find((each) => each.vertex === 'approve' && each.action === 'ask');
  assert.deepEqual(output?.value, { decision: { outcome: 'approved', actor: OWNER, reply: '1. A\n\n2. C' } });
});

test("a comment gg recorded posting is not in the reply, and an answer that pastes gg's marker is", async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  // A comment gg posted after the request under the owner's login, as gg posts, which its write-ahead log records.
  const executionRecord = loadTicket(fixture);
  const ggMarker = golden.markerOf(executionRecord, 'approve', 1, 'ask.note.1');
  const ggComment = fixture.gh.humanComments(`gg's note\n\n<!-- gg-action ${ggMarker} -->`, OWNER);
  executionRecord.writeAheadLog.push(
    writeAhead.entryOf('intent', ggMarker, 'comment', { payload: { branch: 'ticket/8', sha: 'abc' } }),
    writeAhead.entryOf('evidence', ggMarker, 'comment', { evidence: { id: ggComment } }),
    writeAhead.entryOf('complete', ggMarker, 'comment'),
  );
  const pasted = `My answer, with a line copied from gg's comment:\n<!-- gg-action ${ggMarker} -->`;
  fixture.gh.humanComments(pasted, OWNER);

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const result = await interpreter.runExecution({ ...fixture.options, record: executionRecord });
  assert.equal(result.outcome, 'ready-for-qa');
  assert.equal(consumedDecision(fixture)?.reply, pasted);
});

test('a resumed consumption keeps the recorded reply and reads no comments', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanComments('The first answer.', OWNER);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.consume.1');
  await assert.rejects(
    laterRun(fixture, { crashAt: { marker: actionMarker, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), true, 'the Decide Label is not yet removed');
  const reads = approvalFlow.commentReads(fixture);

  fixture.gh.comments.at(-1)!.body = 'The first answer, edited.';
  fixture.gh.humanComments('A second answer.', OWNER);
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
  assert.equal(approvalFlow.commentReads(fixture), reads, 'the resume reads no comments');
  assert.equal(consumedDecision(fixture)?.reply, 'The first answer.');
  const output = loadTicket(fixture).outputs.find((each) => each.vertex === 'approve' && each.action === 'ask');
  assert.equal((output?.value.decision as { reply: string }).reply, 'The first answer.');
});

test('a body edit after the request still re-requests', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanComments('The answers, in a comment.', OWNER);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);

  const result = await laterRun(fixture, { ticket: { ...fixture.options.ticket, body: 'The answers, in the body.' } });
  assert.equal(result.outcome, 'pending', 'a reply does not cover a body edit');
  const saved = loadTicket(fixture);
  assert.equal(saved.approvalRequest!.id, `${saved.execution}:approve:1:2`);
  assert.equal(consumedDecision(fixture), undefined, 'nothing is consumed');
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false, 'the stale Decision is retired');
});

test('a changed Config Hash makes an approval stale', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);

  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const pinned = { ...fixture.options.pinned!, hash: 'another-hash' };
  assert.equal((await laterRun(fixture, { pinned })).outcome, 'pending');
  assert.equal(loadTicket(fixture).approvalRequest!.id.endsWith(':2'), true);
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
  const given = fixture.options.pinned!;
  const pinned = { ...given, configuration: { ...given.configuration, approvers: ['A-Triager'] } };
  const result = await laterRun(fixture, { pinned });
  assert.equal(result.outcome, 'ready-for-qa');
});

test('a crash after consumption is not read twice', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.consume.1');
  await assert.rejects(
    laterRun(fixture, { crashAt: { marker: actionMarker, point: 'after-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  assert.equal(fixture.gh.labels.has(APPROVED_LABEL), false, 'gg removed the Decide Label before the crash');
  const reads = timelineReads(fixture);
  const commentsRead = approvalFlow.commentReads(fixture);
  fixture.gh.humanComments('A comment after the crash.', OWNER);

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'ready-for-qa', 'the unlabeled event gg made cannot undo the Decision');
  assert.equal(timelineReads(fixture), reads, 'the recorded consumption is completed, not read again');
  assert.equal(approvalFlow.commentReads(fixture), commentsRead, 'nor are the comments');
  assert.equal(consumedDecision(fixture)?.reply, null);
});

test('golden: a crash before the decide label is removed completes the recorded consumption', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.consume.1');
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
  const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.consume.1');
  await assert.rejects(
    laterRun(fixture, { crashAt: { marker: actionMarker, point: 'after-completion' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const reads = timelineReads(fixture);
  const commentsRead = approvalFlow.commentReads(fixture);
  fixture.gh.humanComments('A comment after the crash.', OWNER);
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
  assert.equal(timelineReads(fixture), reads);
  assert.equal(approvalFlow.commentReads(fixture), commentsRead);
  const output = loadTicket(fixture).outputs.find((each) => each.vertex === 'approve' && each.action === 'ask');
  assert.equal((output?.value.decision as { reply: unknown }).reply, null, 'the saved reply stands');
  const decided = approvalFlow
    .approveTrace(fixture)
    .filter((event) => golden.isTracedAction(event) && event.action === 'ask');
  assert.equal(decided.length, 1, 'its Event is written once');
});

for (const step of ['retire', 'await', 'comment']) {
  for (const point of ['before-effect', 'after-effect', 'after-completion'] as const) {
    test(`a crash ${point} of the request's ${step} finishes one request`, async (t) => {
      const fixture = await approvalFixture(t);
      const actionMarker = golden.markerOf(fixture.executionRecord, 'approve', 1, `ask.${step}.1`);
      await assert.rejects(
        interpreter.runExecution({ ...fixture.options, crashAt: { marker: actionMarker, point } }),
        (err) => err instanceof interpreter.CrashError,
      );
      const { approvalRequest } = loadTicket(fixture);
      assert.ok(approvalRequest, 'the Pending Instance is saved before any label moves');

      assert.equal((await laterRun(fixture)).outcome, 'pending');
      const saved = loadTicket(fixture);
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
  assert.equal(loadTicket(fixture).state, 'active');
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

// A request's comment leaves its retry budget started; a later request must not read that as its own launch.
test('each re-request has its own retry budget', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  const edited = (body: string) => ({ ticket: { ...fixture.options.ticket, body } });

  assert.equal((await laterRun(fixture, edited('second'))).outcome, 'pending');
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  assert.equal((await laterRun(fixture, edited('third'))).outcome, 'pending');
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  assert.equal((await laterRun(fixture, edited('fourth'))).outcome, 'pending');
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  assert.equal((await laterRun(fixture, edited('fifth'))).outcome, 'pending');
  assert.equal(requestComments(fixture).length, 5);
});

// The nth issue view of the Runs that follow fails as gh does, once.
function failIssueView(fixture: Pick<golden.GoldenFixture, 'gh'>, nth: number) {
  let views = 0;
  fixture.gh.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'view' && ++views === nth, status: 502 });
}

test('an issue that cannot be read at Reconciliation leaves a Pending request as it was', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  failIssueView(fixture, 1);

  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(loadTicket(fixture).state, 'active');
  fixture.gh.humanAddsLabel(APPROVED_LABEL, OWNER);
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa', 'the next Run goes on');
});

test("an issue that cannot be read for a re-request's labels leaves the Ticket Pending", async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanRemovesLabel(AWAIT_LABEL, OWNER);
  // Reconciliation's view, the Decision's, then the labels the new request retires.
  failIssueView(fixture, 3);

  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(loadTicket(fixture).state, 'active');
  assert.equal((await laterRun(fixture)).outcome, 'pending');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true);
  assert.equal(requestComments(fixture).length, 2);
});

test("a request leaves another Vertex's labels alone", async (t) => {
  const fixture = await approvalFixture(t);
  fixture.gh.humanAddsLabel('gg:await:other', OWNER);
  fixture.gh.humanAddsLabel('gg:decide:other:approved', OWNER);
  await interpreter.runExecution(fixture.options);
  assert.equal(fixture.gh.labels.has('gg:await:other'), true);
  assert.equal(fixture.gh.labels.has('gg:decide:other:approved'), true);
});

// A gh that cannot start is not GitHub's answer: it is no blip, and a Pending Ticket faults on it as any other does.
test("a gh that cannot start at a Pending Ticket's Reconciliation is a fault", async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  const transport = fakeGh.ghThrough(fixture.gh, async ({ args }, next) => {
    if (args[0] === 'issue' && args[1] === 'view') throw missing;
    return next();
  });
  const result = await laterRun(fixture, { deps: { ...fixture.options.deps, gh: github.createGh(transport) } });
  assert.equal(result.fault, true);
  assert.equal(loadTicket(fixture).state, 'fault');
});

// Only a Pending Ticket waits out a failed read: another Execution's Reconciliation faults on it, as before.
test('a failed issue read at the Reconciliation of an Execution that is not Pending is a fault', async (t) => {
  const fixture = await golden.fixture(t);
  const commit = golden.markerOf(fixture.executionRecord, 'green', 1, 'commit');
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: commit, point: 'before-effect' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  fixture.gh.fail({ matches: (args) => args[0] === 'issue' && args[1] === 'view', status: 502 });
  const result = await laterRun(fixture);
  assert.equal(result.fault, true);
});

test('an abandoned Pending request takes its Await Label down', async (t) => {
  const fixture = await approvalFixture(t);
  await interpreter.runExecution(fixture.options);
  fixture.gh.humanAddsLabel('gg:state:needs-human', OWNER);

  assert.equal((await laterRun(fixture)).outcome, 'abandoned');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), false, 'nothing waits for a Decision any more');
  assert.equal(fixture.gh.labels.has('gg:state:needs-human'), true, "the human's label stays");
});

// A run stop met in Reconciliation's wait for a saved retry deadline ends no Pending request either.
test("a run stop met in Reconciliation's cooldown leaves a Pending request as it was", async (t) => {
  const fixture = await approvalFixture(t);
  const comment = golden.markerOf(fixture.executionRecord, 'approve', 1, 'ask.comment.1');
  fixture.gh.fail({ matches: (args) => fakeGh.isCommentPost(args), status: 502 });
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: comment, point: 'after-retry-saved' } }),
    (err) => err instanceof interpreter.CrashError,
  );
  const crashed = loadTicket(fixture);
  const runState = { stop: { failureClass: 'auth', ticket: 99 }, remoteNotBefore: 0 };

  const result = await laterRun(fixture, { runState });
  assert.equal(result.outcome, 'pending');
  const saved = loadTicket(fixture);
  assert.equal(saved.state, 'active');
  assert.deepEqual(saved.approvalRequest, crashed.approvalRequest);
  assert.deepEqual(saved.retries, crashed.retries, 'its retry budget and deadline stand');
  assert.equal(fixture.gh.labels.has(AWAIT_LABEL), true);
});
