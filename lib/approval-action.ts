// The await-approval Action (X1, request 3.5, ADR 0003): an Approval Request's write-ahead Actions, which end the Run
// for the Ticket, and at a later Run the Decision read from the issue's timeline, consumed write-ahead, whose value is
// the Visit's Outcome. Nothing here reads the timeline once its consumption is recorded.
import * as approval from './approval.ts';
import * as bounds from './bounds.ts';
import * as effects from './effects.ts';
import * as labels from './labels.ts';
import * as pendingReport from './pending-report.ts';
import * as procedures from './procedures.ts';
import * as render from './render.ts';
import type { RunContext } from './run-context.ts';
import type * as visit from './visit.ts';
import type * as visitScope from './visit-scope.ts';
import * as writeAhead from './write-ahead.ts';

type Running = visitScope.Running;
type PendingInstance = approval.PendingInstance;
type ReportAction = 'retire' | 'await' | 'comment' | 'consume';

// What a consumed Decision's intent saves before its label is removed, so a resume completes it without reading the
// timeline, whose unlabeled event gg itself made could no longer show it (request 3.5).
export interface Consumption extends pendingReport.LabelPayload {
  decision: { instance: string; event: number; actor: string | undefined; time: string; outcome: string; next: string };
}

const namesOf = (runContext: RunContext) => labels.labelsFor(runContext.labelPrefix ?? labels.DEFAULT_PREFIX);

// One of a request's own Actions, outside the Procedure: `<action>.<part>.<request number>`, which no
// declared Action id can name, since an id holds no "." (3.3). The number is in the name, not the Attempt: an Action's
// remote retry budget is kept by its name, and each request has its own.
const reportActionOf = ({ actionIdentity }: Running, instance: PendingInstance, part: ReportAction) => ({
  vertex: actionIdentity.vertex,
  visit: actionIdentity.visit,
  procedure: null,
  action: `${actionIdentity.action}.${part}.${instance.nonce}`,
  recovery: actionIdentity.recovery,
});

// The Approval Digest's inputs as they are now: what a Decision covers (request 3.5).
const digestInput = async (runContext: RunContext): Promise<approval.DigestInput> => ({
  head: await runContext.git.headSha(runContext.record.worktree),
  body: runContext.ticket?.body ?? '',
  configHash: runContext.configHash ?? runContext.record.configHash,
});

// The labels this Vertex's earlier requests left: its Await Label, and every Decide Label for it, a Decision no request
// declared included, so no stale Decision can follow a new request.
async function earlierLabels(runContext: RunContext, vertex: string): Promise<string[]> {
  const names = namesOf(runContext);
  const issue = await runContext.gh.viewIssue(runContext.record.ticket, runContext.cwd);
  return runContext.gh.labelNames(issue).filter((label) => {
    const parsed = names.parse(label);
    return (parsed?.family === 'await' || parsed?.family === 'decide') && labels.hasLabel([parsed.vertex], vertex);
  });
}

function requestBody(runContext: RunContext, running: Running, instance: PendingInstance): Promise<string> {
  const { vertex } = running.actionIdentity;
  const names = namesOf(runContext);
  return render.publicBody(
    render.engineTemplate('approval-request.md'),
    {
      vertex,
      id: instance.id,
      digest: instance.digest,
      decideLabels: procedures.decisionsOf(running.action).map((decision) => names.decide(vertex, decision)),
      replaces: Number(instance.nonce) > 1,
    },
    runContext.markerOf(reportActionOf(running, instance, 'comment')),
    runContext.publicText,
  );
}

// Each of the request's Actions not yet complete, in order; a resume finds the ones that landed through Reconciliation.
async function finishRequest(runContext: RunContext, running: Running, instance: PendingInstance): Promise<never> {
  const { vertex } = running.actionIdentity;
  const complete = (part: ReportAction) =>
    writeAhead.findEntry(runContext.record, runContext.markerOf(reportActionOf(running, instance, part)), 'complete');
  if (!complete('retire'))
    await pendingReport.labelAction(runContext, reportActionOf(running, instance, 'retire'), {
      remove: await pendingReport.keepPendingIfUnread(runContext, `The labels of request ${instance.id}`, () =>
        earlierLabels(runContext, vertex),
      ),
    });
  if (!complete('await'))
    await pendingReport.labelAction(runContext, reportActionOf(running, instance, 'await'), {
      add: [namesOf(runContext).await(vertex)],
    });
  if (!complete('comment'))
    await pendingReport.commentAction(
      runContext,
      reportActionOf(running, instance, 'comment'),
      await requestBody(runContext, running, instance),
    );
  throw pendingReport.pending(`Vertex ${vertex} waits for a Decision on request ${instance.id}.`);
}

// A new request on the digest as it is now, its Pending Instance saved before any label moves. The nonce is the
// request's number in this Visit, which also names its Actions.
async function request(runContext: RunContext, running: Running, previous: PendingInstance | null): Promise<never> {
  const { record: executionRecord } = runContext;
  const { vertex, visit: visitNumber } = running.actionIdentity;
  const instance = approval.request({
    execution: executionRecord.execution,
    vertex,
    visit: visitNumber,
    nonce: String(Number(previous?.nonce ?? 0) + 1),
    ...(await digestInput(runContext)),
  });
  executionRecord.approvalRequest = instance;
  await runContext.database.save(executionRecord);
  return finishRequest(runContext, running, instance);
}

// The record first, then the label; the Decision's value is saved as the Action's result, in one write with its
// completion and Event. A retried label write is the same intent, so the Decision stands.
async function consume(
  runContext: RunContext,
  running: Running,
  instance: PendingInstance,
  found: approval.Decision | null,
): Promise<visitScope.ActionResolution> {
  const { record: executionRecord } = runContext;
  const { actionIdentity } = running;
  const startedAt = runContext.clock.now();
  const consumption = reportActionOf(running, instance, 'consume');
  const actionMarker = runContext.markerOf(consumption);
  const intended = writeAhead.findEntry(executionRecord, actionMarker, 'intent')?.payload as Consumption | undefined;
  const payload: Consumption = intended ?? consumptionOf(runContext, running, instance, found as approval.Decision);
  await effects.whileBusy(runContext, () =>
    effects.sideEffect<Consumption>(runContext, {
      actionMarker,
      effect: 'label',
      payload,
      perform: pendingReport.performLabels(runContext),
      deferred: true,
    }),
  );
  executionRecord.approvalRequest = null;
  const resolution: visit.DecisionResolution = {
    outcome: payload.decision.outcome,
    direction: 'stop',
    row: 'decision',
    rule: { table: 'fixed', row: 'decision' },
  };
  return effects.saveResolution(runContext, {
    actionIdentity,
    startedAt,
    resolution,
    fields: { decision: payload.decision },
    actionMarker,
  });
}

function consumptionOf(
  runContext: RunContext,
  { actionIdentity }: Running,
  instance: PendingInstance,
  { event, actor, time, outcome }: approval.Decision,
): Consumption {
  const names = namesOf(runContext);
  const { vertex } = actionIdentity;
  return {
    ticket: runContext.record.ticket,
    add: [],
    remove: [names.decide(vertex, outcome), names.await(vertex)],
    decision: {
      instance: instance.id,
      event,
      actor,
      time,
      outcome,
      next: bounds.edge(runContext, outcome).next,
    },
  };
}

// What the issue shows now. A login GitHub does not know has no permission (github.collaboratorPermission).
async function readDecision(runContext: RunContext, running: Running, instance: PendingInstance) {
  const { gh, record: executionRecord, cwd } = runContext;
  const prefix = runContext.labelPrefix ?? labels.DEFAULT_PREFIX;
  const timeline = await gh.issueEvents(executionRecord.ticket, cwd);
  const issueLabels = gh.labelNames(await gh.viewIssue(executionRecord.ticket, cwd));
  const permissions: Record<string, string> = {};
  for (const login of approval.decidingActors({ vertex: instance.vertex, timeline, prefix }))
    permissions[login] = await gh.collaboratorPermission(login, cwd);
  return approval.read({
    approvalRequest: instance,
    issueLabels,
    timeline,
    digest: approval.digest(await digestInput(runContext)),
    permissions,
    approvers: runContext.approvers,
    prefix,
    decisions: procedures.decisionsOf(running.action),
  });
}

// A run stop ends an Execution before it starts new work (request 3.4). A request already made starts none, and ending
// the Execution would lose it, so it waits on to the next Run as it was. One not yet made is new work.
export function waitThroughStop(runContext: RunContext, running: Running, settled: unknown) {
  const stop = runContext.runState.stop;
  const given = runContext.record.approvalRequest;
  const { vertex, visit: visitNumber } = running.actionIdentity;
  if (settled || !stop || running.action.do !== 'await-approval' || given?.vertex !== vertex) return;
  if (given.visit === visitNumber)
    throw pendingReport.pending(
      `The run stopped on class ${stop.failureClass}, so request ${given.id} waits for the next Run.`,
    );
}

// Under the ticket lock, so no other Run reads or consumes this request (request 3.5): a recorded consumption finishes,
// an unfinished request finishes, and only then is the timeline read. A stale, ambiguous or missing request is retired
// and asked again without ending the Visit (X1c).
export async function awaitApproval(runContext: RunContext, running: Running): Promise<visitScope.ActionResolution> {
  const { record: executionRecord } = runContext;
  const { vertex, visit: visitNumber } = running.actionIdentity;
  const given = executionRecord.approvalRequest;
  const instance = given?.vertex === vertex && given.visit === visitNumber ? given : null;
  if (!instance) return request(runContext, running, null);
  if (
    writeAhead.findEntry(executionRecord, runContext.markerOf(reportActionOf(running, instance, 'consume')), 'intent')
  )
    return consume(runContext, running, instance, null);
  if (
    !writeAhead.findEntry(
      executionRecord,
      runContext.markerOf(reportActionOf(running, instance, 'comment')),
      'complete',
    )
  )
    return finishRequest(runContext, running, instance);
  const read = await pendingReport.keepPendingIfUnread(runContext, `The Decision on request ${instance.id}`, () =>
    readDecision(runContext, running, instance),
  );
  if (read.kind === 'consume') return consume(runContext, running, instance, read.decision);
  if (read.kind === 'waiting')
    throw pendingReport.pending(`Vertex ${vertex} waits for a Decision on request ${instance.id}.`);
  runContext.log(`#${executionRecord.ticket} request ${instance.id} is ${read.kind}, so it is retired and asked again`);
  return request(runContext, running, instance);
}
