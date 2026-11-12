import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as effects from '../../lib/effects.ts';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as terminalReport from '../../lib/terminal-report.ts';
import * as support from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';
import * as remoteFailures from '../support/remote-failures.ts';

const ticketEnds = (commonDir: string, execution: string) =>
  eventRead.executionEvents(commonDir, execution).filter((event) => event.type === 'ticket_end');

const PUSH_EVENT = {
  flow: 'default',
  configHash: 'abc123',
  launchProfile: null,
  confinement: null,
  ticket: support.TICKET,
  run: 'run-1',
  execution: 'e1',
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
} satisfies events.EventInput<'action'>;

// An Event as the State Database gives it back: its header, then its body.
const saved = <Body extends object>(body: Body) => ({ schemaVersion: 2 as const, time: 't', ...body });

test("an Execution's run stop is its first Action Event whose class reaches the run", () => {
  const event = (action: string, failureClass: string | null) =>
    saved(events.actionEvent({ ...PUSH_EVENT, action, failureClass }));
  const harnessAuth = event('red', 'auth');
  const remoteAuth = event('push', 'auth');
  const permission = event('push', 'permission');
  const ticketEnd = saved(events.lifecycleEvent('ticket_end', { run: 'run-1', execution: 'e1', ticket: 7 }));
  assert.equal(
    terminalReport.runStopEvent([event('red-check', null), harnessAuth, remoteAuth]),
    harnessAuth,
    'a Harness auth',
  );
  assert.equal(terminalReport.runStopEvent([permission, remoteAuth, ticketEnd]), remoteAuth, 'a remote auth');
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
  const { context, executionRecord, logs } = await support.executionContext(t);
  assert.equal(terminalReport.runStopOf(executionRecord, context.log), null);
  context.events('action', { ...PUSH_EVENT, execution: executionRecord.execution, failureClass: 'auth' });
  assert.deepEqual(terminalReport.runStopOf(executionRecord, context.log), { failureClass: 'auth' });
  assert.deepEqual(logs, []);
});

// The ticket_end rows, counted by their type column, so the refused row is not read.
const ticketEndRows = (commonDir: string) =>
  Number(stateDatabase.open(commonDir).prepare("SELECT count(*) AS n FROM events WHERE type = 'ticket_end'").get()?.n);

const NOT_JSON_REASON = 'Unexpected end of JSON input';

// A row of the Execution in the events table that no Event declaration accepts.
const plantCorrupt = (commonDir: string, execution: string) =>
  stateDatabase
    .open(commonDir)
    .prepare("INSERT INTO events (ts, type, run, execution, ticket, json) VALUES ('t', 'action', 'run-1', ?, ?, ?)")
    .run(execution, support.TICKET, '{"type":"action","failureClass":');

test('a refused row of the Execution is skipped and logged by name; the others give the run stop', async (t) => {
  const { context, executionRecord, logs, commonDir } = await support.executionContext(t);
  plantCorrupt(commonDir, executionRecord.execution);
  context.events('action', { ...PUSH_EVENT, execution: executionRecord.execution, failureClass: 'auth' });
  let runStop: ReturnType<typeof terminalReport.runStopOf> = null;
  assert.doesNotThrow(() => {
    runStop = terminalReport.runStopOf(executionRecord, context.log);
  });
  assert.deepEqual(runStop, { failureClass: 'auth' });
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(
    logs[0],
    new RegExp(`^#${support.TICKET} run stop: skipped corrupt event 1 \\(action\\): its JSON does not parse: .+`),
  );
});

test('a Terminal lands once beside a refused row of its Execution, and the log names the row', async (t) => {
  const fixture = await golden.fixture(t);
  plantCorrupt(fixture.commonDir, fixture.executionRecord.execution);
  const result = await interpreter.runExecution(fixture.options).catch((err: unknown) => ({ rejected: String(err) }));

  assert.deepEqual(result, { outcome: 'ready-for-qa' });
  assert.equal(executionReads.loadTicket(fixture).state, 'ready-for-qa');
  assert.equal(ticketEndRows(fixture.commonDir), 1);
  assert.deepEqual([...fixture.gh.labels], ['gg:state:ready-for-qa']);
  assert.deepEqual(
    fixture.logs.filter((line) => line.includes('corrupt event')),
    [`#${golden.TICKET} run stop: skipped corrupt event 1 (action): its JSON does not parse: ${NOT_JSON_REASON}`],
  );
});

test('a run stop beside a refused row of its Execution is still reported', async (t) => {
  const fixture = await golden.fixture(t);
  plantCorrupt(fixture.commonDir, fixture.executionRecord.execution);
  remoteFailures.pushThrough(fixture, () =>
    Promise.reject(remoteFailures.refusedPush("fatal: Authentication failed for 'https://github.com/o/r.git/'\n")),
  );
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  const result = await interpreter
    .runExecution({ ...fixture.options, runState })
    .catch((err: unknown) => ({ rejected: String(err) }));

  assert.deepEqual(result, { outcome: 'needs-human', runStop: { failureClass: 'auth' } });
  assert.equal(executionReads.loadTicket(fixture).state, 'needs-human');
  assert.equal(ticketEndRows(fixture.commonDir), 1);
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
