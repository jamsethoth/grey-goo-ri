import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as events from '../../lib/events.ts';
import * as terminalReport from '../../lib/terminal-report.ts';
import * as support from '../support/execution-context.ts';

const ticketEnds = (commonDir: string, execution: string) =>
  events.executionEvents(commonDir, execution).filter((event) => event.type === 'ticket_end');

test("an Execution's run stop is its first Action Event whose class reaches the run", () => {
  const event = (action: string, failureClass: string | null, agent = false) => ({
    type: 'action',
    action,
    agent,
    failureClass,
  });
  const harnessAuth = event('red', 'auth', true);
  const remoteAuth = event('push', 'auth');
  const permission = event('push', 'permission');
  assert.equal(
    terminalReport.runStopEvent([event('red-check', null), harnessAuth, remoteAuth]),
    harnessAuth,
    'a Harness auth',
  );
  assert.equal(
    terminalReport.runStopEvent([permission, remoteAuth, { type: 'ticket_end' }]),
    remoteAuth,
    'a remote auth',
  );
  assert.equal(terminalReport.runStopEvent([permission]), null, 'a permission failure faults only its Ticket');
  assert.equal(terminalReport.runStopEvent([]), null, 'none');
});

test('a declared stop holds every field, the flags false and the rest null', () => {
  assert.deepEqual(terminalReport.declaredStop({ outcome: 'fault', error: 'boom' }), {
    outcome: 'fault',
    response: null,
    actionRef: null,
    held: false,
    abandoned: false,
    inProgress: false,
    fresh: false,
    stopped: false,
    commentTemplate: null,
    advice: null,
    detail: null,
    error: 'boom',
    failureClass: null,
    interrupted: null,
  });
});

test("an Execution's run stop is read from its Action Events in the State Database", async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  assert.equal(terminalReport.runStopOf(executionRecord), null);
  context.events('action', {
    flow: 'default',
    configHash: 'abc123',
    launchProfile: null,
    confinement: null,
    ticket: support.TICKET,
    run: 'run-1',
    execution: executionRecord.execution,
    vertex: 'green',
    visit: 1,
    procedure: 'implement',
    action: 'push',
    recovery: 0,
    attempt: 1,
    durationMs: 0,
    outcome: 'run-stop',
    direction: 'stop',
    signals: {},
    rule: { table: 'fixed', row: 'run-stop' },
    agent: false,
    failureClass: 'auth',
  });
  assert.deepEqual(terminalReport.runStopOf(executionRecord), { failureClass: 'auth' });
});

test("a Terminal's Actions are named for its report: end, fault, hold or abandon", () => {
  assert.deepEqual(terminalReport.terminalActionIdentity('ready-for-qa', null)('comment'), {
    vertex: 'ready-for-qa',
    visit: 1,
    procedure: null,
    action: 'end-comment',
    recovery: 0,
  });
  assert.equal(
    terminalReport.terminalActionIdentity('needs-human', { error: 'boom', held: true })('label').action,
    'fault-label',
  );
  assert.equal(terminalReport.terminalActionIdentity('needs-human', { held: true })('label').action, 'hold-label');
  assert.deepEqual(terminalReport.terminalActionIdentity('abandoned', { abandoned: true })('label'), {
    vertex: 'needs-human',
    visit: 1,
    procedure: null,
    action: 'abandon-label',
    recovery: 0,
  });
});

test('a fault report whose comment cannot be rendered fails, rather than landing without its comment', async (t) => {
  const { context, executionRecord, fakeGh, commonDir } = await support.executionContext(t);
  executionRecord.terminalReason = { decidedBy: { hold: null }, outcome: null, rule: null, text: 'It faulted.' };
  const stop = {
    outcome: 'fault',
    error: 'boom',
    stopped: true,
    response: { claim: 'blocked' },
    commentTemplate: 'stopped.md',
    actionRef: { vertex: 'green', visit: 1, action: 'green', recovery: 0 },
  };
  await assert.rejects(terminalReport.report(context, 'needs-human', stop), /no source names file "stopped\.md"/);
  assert.deepEqual(fakeGh.comments, []);
  assert.equal(executionRecord.state, 'active', 'the fault has not landed');
  assert.deepEqual(ticketEnds(commonDir, executionRecord.execution), []);
});

test('a Terminal posts its reason, sets its end label and lands that state with ticket_end', async (t) => {
  const { context, executionRecord, fakeGh, commonDir } = await support.executionContext(t);
  executionRecord.terminalReason = { decidedBy: { hold: null }, outcome: 'replan', rule: null, text: 'Replan it.' };
  const result = await terminalReport.report(context, 'needs-replan', { outcome: 'replan' });
  assert.deepEqual(result, { outcome: 'needs-replan' });
  assert.equal(executionRecord.state, 'needs-replan');
  assert.ok(fakeGh.comments[0].body.startsWith('### gg: needs-replan\n\n**Terminal Reason:** Replan it.'));
  assert.deepEqual([...fakeGh.labels], ['gg:state:needs-replan']);
  assert.deepEqual(
    ticketEnds(commonDir, executionRecord.execution).map((event) => event.outcome),
    ['needs-replan'],
  );
});
