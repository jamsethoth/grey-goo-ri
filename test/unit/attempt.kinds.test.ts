// Each Action kind's Attempt declarations to lib/attempt.ts (decision 8 of #360, #376): whether its work runs busy,
// what it reads only for an Attempt not yet complete, and what a complete one resumes to. The mechanism itself is
// test/unit/attempt.test.ts's; these cases hold each kind to what it declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as agentAction from '../../lib/agent-action.ts';
import * as approval from '../../lib/approval.ts';
import * as approvalAction from '../../lib/approval-action.ts';
import * as attempt from '../../lib/attempt.ts';
import * as cleanupHold from '../../lib/cleanup-hold.ts';
import * as effectActions from '../../lib/effect-actions.ts';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as effects from '../../lib/effects/index.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as pendingReport from '../../lib/pending-report.ts';
import * as procedures from '../../lib/procedures.ts';
import * as record from '../../lib/record.ts';
import type * as visit from '../../lib/visit.ts';
import type * as visitScope from '../../lib/visit-scope.ts';
import type * as writeAhead from '../../lib/write-ahead.ts';
import * as approvalFlow from '../support/approval-flow.ts';
import * as caseDatabase from '../support/case-database.ts';
import * as exampleRun from '../support/example-run.ts';
import * as support from '../support/execution-context.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as rescueFlow from '../support/rescue-flow.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const IDENTITY = support.PUSH_ACTION_IDENTITY;

// A Visit's state as runVisit starts it, whose claimed ok token requires no Check: what a kind reads of it before its
// Attempt.
function runningVisit(): visitScope.RunningVisit {
  const state: visit.VisitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: new Map(),
    checks: new Map(),
    checkFollows: false,
    settled: null,
    unconfirmedCleanup: null,
  };
  Object.defineProperty(state, 'claimTokens', { value: new Map([['ok', { requires: [] }]]), enumerable: false });
  return state as visitScope.RunningVisit;
}

// Each site that hands lib/attempt.ts an Attempt, or a pending report's change or body for one, in source order, with
// what it declares (decision 8 of #360): whether its work runs busy (a Check's only when its kind reads the tree), what
// it reads only for an Attempt not yet complete, and what a complete one resumes to when not effect-completed. `seen`
// names the Actions whose intents the observed runs below write from it.
interface Declared {
  site: string;
  busy?: boolean | 'tree';
  lazy?: string;
  resumed?: string;
  seen?: string[];
}
const DECLARED: Declared[] = [
  {
    site: 'lib/agent-action.ts callAttempt',
    busy: true,
    lazy: 'the Brief',
    resumed: 'its evidence',
    seen: ['green/green', 'red/red', 'reviewer/review', 'senior-red/red'],
  },
  {
    site: 'lib/approval-action.ts finishRequest',
    lazy: "the issue's labels",
    seen: ['approve/ask.retire.1', 'approve/ask.retire.2'],
  },
  { site: 'lib/approval-action.ts finishRequest', seen: ['approve/ask.await.1', 'approve/ask.await.2'] },
  { site: 'lib/approval-action.ts finishRequest', seen: ['approve/ask.comment.1', 'approve/ask.comment.2'] },
  {
    site: 'lib/approval-action.ts consume',
    busy: true,
    resumed: 'its Decision',
    seen: ['approve/ask.consume.1', 'approve/ask.consume.2'],
  },
  { site: 'lib/check-action.ts check', busy: 'tree' },
  // A cleanup hold's report reads nothing, and it runs while the held call keeps the worktree busy (L11).
  { site: 'lib/cleanup-hold.ts report' },
  { site: 'lib/cleanup-hold.ts report' },
  { site: 'lib/cleanup-hold.ts awaitConfirmation' },
  { site: 'lib/effect-actions.ts commitAction', busy: true, seen: ['green/commit', 'red/commit'] },
  { site: 'lib/effect-actions.ts pushAction', busy: true, seen: ['green/push'] },
  { site: 'lib/effect-actions.ts postComment', busy: true, seen: ['reviewer/comment'] },
  { site: 'lib/effect-actions.ts upsertPr', busy: true, seen: ['green/pr', 'publish/pr', 'reviewer/pr'] },
  { site: 'lib/effect-actions.ts markReady', busy: true, seen: ['publish/pr-ready'] },
  { site: 'lib/pending-report.ts labelAction', busy: true, lazy: 'the label change' },
  { site: 'lib/pending-report.ts commentAction', busy: true, lazy: 'the comment body' },
  { site: 'lib/rescue.ts rescueAndReset', busy: false, seen: ['red/rescue'] },
  {
    site: 'lib/terminal-report.ts terminalAction',
    busy: true,
    seen: ['needs-human/end-comment', 'needs-human/end-label', 'ready-for-qa/end-comment', 'ready-for-qa/end-label'],
  },
];

// Each call that declares an Attempt, with or without type arguments, named by its module and the top-level function
// it is in. lib/attempt.ts's own `run` inside `effectAction` is the mechanism, not a kind.
const DECLARING = /\b(?:attempt\.(?:run|effectAction)|pendingReport\.(?:labelAction|commentAction))[<(]/g;
const TOP_LEVEL = /^(?:export )?(?:async )?(?:function (\w+)|const (\w+)\s*=)/gm;
function sitesOf(path: string, text: string): string[] {
  const starts = [...text.matchAll(TOP_LEVEL)].map((found) => ({ offset: found.index, name: found[1] ?? found[2] }));
  return [...text.matchAll(DECLARING)].map(
    (call) => `${path} ${starts.findLast((start) => start.offset < call.index)?.name}`,
  );
}

test('every site that declares an Attempt to lib/attempt.ts has its row of declarations', () => {
  assert.deepEqual(
    sitesOf(
      'lib/sample.ts',
      [
        'export async function newKind(runContext) {',
        '  return attempt.run(runContext, {});',
        '}',
        'export const typedKind = (runContext) =>',
        '  attempt.run<undefined, undefined, never>(runContext, {});',
      ].join('\n'),
    ),
    ['lib/sample.ts newKind', 'lib/sample.ts typedKind'],
    'a new site is found, with type arguments or without',
  );
  const sites = readdirSync(`${root}lib`, { recursive: true, encoding: 'utf8' })
    .map((file) => `lib/${file.split('\\').join('/')}`)
    .filter((path) => path.endsWith('.ts'))
    .sort()
    .flatMap((path) => sitesOf(path, readFileSync(root + path, 'utf8')));
  assert.deepEqual(
    sites,
    DECLARED.map(({ site }) => site),
  );
});

type Bracket = 'none' | 'one' | 'nested';
interface Observed {
  // The Action and recovery pass the cursor was on as each bracket opened.
  opens: string[];
  // Each write-ahead intent's Action and Effect, and the bracket it was written in.
  intents: { action: string; effect: string; bracket: Bracket }[];
}
// Watches the busy bracket through every save of `fixture`'s record: markBusy and markIdle each flip the flag and save,
// and a markBusy on a busy worktree opens a bracket inside another.
function observeBrackets(t: Parameters<typeof golden.fixture>[0], fixture: golden.GoldenFixture): Observed {
  const observed: Observed = { opens: [], intents: [] };
  let { generation } = fixture.executionRecord.activity;
  let logged = fixture.executionRecord.writeAheadLog.length;
  let bracket: Bracket = 'none';
  caseDatabase.onSave(t, (next) => {
    // The case's other fixtures save through the same hooks, each under its own repository.
    if (!('execution' in next) || next.commonDir !== fixture.commonDir) return;
    const { activity, cursor, writeAheadLog } = next;
    if (activity.generation !== generation) {
      generation = activity.generation;
      if (activity.busy) observed.opens.push(`${cursor.vertex}/${cursor.action} recovery ${cursor.recovery}`);
      const opened: Bracket = bracket === 'none' ? 'one' : 'nested';
      bracket = activity.busy ? opened : 'none';
    }
    const last = writeAheadLog.at(-1);
    if (writeAheadLog.length > logged && last?.step === 'intent') {
      const { vertex, action } = marker.partsOf(last.actionMarker);
      observed.intents.push({ action: `${vertex}/${action}`, effect: last.effect!, bracket });
    }
    logged = writeAheadLog.length;
  });
  return observed;
}

test("every Attempt's intent is written inside one bracket, its kind's or its step's, never nested", async (t) => {
  const example = await exampleRun.exampleFixture(t);
  const observed = observeBrackets(t, example);
  await goldenRun.ranToEnd(example);
  const asked = await approvalFlow.approvalFixture(t);
  const approving = observeBrackets(t, asked);
  await interpreter.runExecution(asked.options);
  asked.gh.humanAddsLabel(approvalFlow.APPROVED_LABEL, approvalFlow.OWNER);
  await approvalFlow.laterRun(asked);
  // A request asked again, once the issue's body changed under it, is the Visit's second, and its own consumption.
  const askedAgain = await approvalFlow.approvalFixture(t);
  const reapproving = observeBrackets(t, askedAgain);
  await interpreter.runExecution(askedAgain.options);
  const edited = { ticket: { ...askedAgain.options.ticket!, body: 'An edited body.' } };
  askedAgain.gh.humanAddsLabel(approvalFlow.APPROVED_LABEL, approvalFlow.OWNER);
  await approvalFlow.laterRun(askedAgain, edited);
  askedAgain.gh.humanAddsLabel(approvalFlow.APPROVED_LABEL, approvalFlow.OWNER);
  await approvalFlow.laterRun(askedAgain, edited);
  const rescued = await golden.fixture(t, { responses: rescueFlow.failingRed({ 'test/extra.test.mjs': 'a test\n' }) });
  golden.configure(rescued, rescueFlow.routeRedFailureToSenior);
  const rescuing = observeBrackets(t, rescued);
  await interpreter.runExecution(rescued.options);
  const intents = [...observed.intents, ...approving.intents, ...reapproving.intents, ...rescuing.intents];

  assert.deepEqual(
    intents.filter(({ bracket }) => bracket !== 'one'),
    [],
    'no intent outside a bracket, and none inside a bracket nested in another',
  );
  assert.deepEqual(
    [...new Set(intents.map(({ action }) => action))].sort(),
    [...DECLARED.flatMap(({ seen = [] }) => seen), 'red/reset'].sort(),
    "each site's Actions write intents, and every intent is a site's or the rescue's reset",
  );
  assert.deepEqual(
    [...new Set(intents.map(({ effect }) => effect))].sort(),
    ['call', ...effects.all().map(({ name }) => name)].sort(),
    'the runs make every Effect and the agent call',
  );
});

// Each Check the fixture's Execution runs, by its Action and recovery pass, with its kind and the brackets opened while
// the cursor was on it.
async function checkBrackets(t: Parameters<typeof golden.fixture>[0], fixture: golden.GoldenFixture) {
  const observed = observeBrackets(t, fixture);
  await goldenRun.ranToEnd(fixture);
  return support
    .actionEvents(fixture.executionRecord)
    .filter((event) => event.check)
    .map(({ vertex, action, recovery, signals }) => {
      const place = `${vertex}/${action} recovery ${recovery}`;
      const { kind } = (signals.checks as visit.CheckSignal[])[0]!;
      return { place, kind, brackets: observed.opens.filter((open) => open === place).length };
    });
}

test('a Check opens one bracket when its kind reads the tree and none otherwise, in any recovery pass', async (t) => {
  const example = await checkBrackets(t, await exampleRun.exampleFixture(t));
  // green's Check fails, its recover call fixes the sum, and the Check runs again in recovery pass 1.
  const recovered = await checkBrackets(
    t,
    await goldenRun.greenFixture(t, {
      responses: {
        [rescueFlow.GREEN_CALL]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
        [rescueFlow.GREEN_RECOVERY]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.RIGHT_ADD }),
      },
    }),
  );
  assert.deepEqual(example, [
    { place: 'baseline/test recovery 0', kind: 'command', brackets: 1 },
    { place: 'red/red-check recovery 0', kind: 'tests-fail', brackets: 1 },
    { place: 'green/test recovery 0', kind: 'command', brackets: 1 },
    { place: 'reviewer/review-pass recovery 0', kind: 'response', brackets: 0 },
    { place: 'reviewer/repeat recovery 0', kind: 'repeat', brackets: 0 },
    { place: 'publish/test recovery 0', kind: 'command', brackets: 1 },
  ]);
  assert.deepEqual(recovered, [
    { place: 'red/red-check recovery 0', kind: 'tests-fail', brackets: 1 },
    { place: 'green/test recovery 0', kind: 'command', brackets: 1 },
    { place: 'green/test recovery 1', kind: 'command', brackets: 1 },
    { place: 'publish/test recovery 0', kind: 'command', brackets: 1 },
  ]);
  assert.deepEqual(
    [...new Set(example.map(({ kind }) => kind))].sort(),
    Object.keys(procedures.CHECK_KEYS).sort(),
    'every Check kind runs',
  );
});

// An Action outside the Procedure at an approve Vertex, as a request names its own.
const requestIdentity = (action: string) => ({ vertex: 'approve', visit: 1, procedure: null, action, recovery: 0 });
const APPROVAL_RUNNING = {
  actionIdentity: { vertex: 'approve', visit: 1, procedure: 'approval', action: 'ask', recovery: 0 },
  action: { id: 'ask', do: 'await-approval', decisions: ['approved', 'rejected'] },
  state: runningVisit(),
} satisfies visitScope.Running;

// The intent of `effect` under the Attempt's marker, completed with `evidence`, as a Run before this one left it.
function completeBefore(
  context: support.ExecutionContext,
  actionIdentity: Parameters<support.ExecutionContext['markerOf']>[0],
  { effect, payload, evidence }: { effect: string; payload: unknown; evidence: unknown },
) {
  const actionMarker = context.markerOf(actionIdentity);
  record.intent(context.record, actionMarker, effect, payload as writeAhead.Payload);
  record.complete(context.record, actionMarker, { evidence: evidence as writeAhead.Evidence });
}

const LABEL_LANDED = { ok: true };

test('a complete pending report label Action resumes to effect-completed without reading its change', async (t) => {
  const { context } = await support.executionContext(t);
  const actionIdentity = requestIdentity('ask.await.1');
  completeBefore(context, actionIdentity, {
    effect: 'label',
    payload: { ticket: support.TICKET, add: ['gg:await:approve'], remove: [] },
    evidence: LABEL_LANDED,
  });
  const reads: string[] = [];
  const resolution = await pendingReport.labelAction(context, actionIdentity, async () => {
    reads.push('the change');
    return {};
  });
  assert.deepEqual(resolution, attempt.EFFECT_COMPLETED);
  assert.deepEqual(reads, [], 'a complete Action reads no change');
});

test('a complete pending report comment Action resumes to effect-completed without rendering its body', async (t) => {
  const { context } = await support.executionContext(t);
  const actionIdentity = requestIdentity('ask.comment.1');
  completeBefore(context, actionIdentity, {
    effect: 'comment',
    payload: { target: { kind: 'issue', number: support.TICKET }, body: 'A request.', bodyHash: 'hash' },
    evidence: { id: 7 },
  });
  const reads: string[] = [];
  const resolution = await pendingReport.commentAction(context, actionIdentity, async () => {
    reads.push('the body');
    return 'A request.';
  });
  assert.deepEqual(resolution, attempt.EFFECT_COMPLETED);
  assert.deepEqual(reads, [], 'a complete Action renders no body');
});

// A later Run finishes a hold's report a crash cut short, and every later Run of a held Ticket reports again.
test('a cleanup hold whose label and comment landed renders no comment body when it reports again', async (t) => {
  const { context } = await support.executionContext(t);
  const held = { vertex: 'green', visit: 1, action: 'test', recovery: 0 };
  const unconfirmed = {
    confirmed: false,
    survivors: [],
    reason: 'termination refused',
    containment: { kind: 'none' as const },
  };
  context.record.visitState = { ...runningVisit(), unconfirmedCleanup: unconfirmed };
  const reportAction = (part: string) => ({ ...held, procedure: null, action: `test.cleanup-${part}.1` });
  completeBefore(context, reportAction('label'), {
    effect: 'label',
    payload: { ticket: support.TICKET, add: ['gg:await:cleanup'], remove: [] },
    evidence: LABEL_LANDED,
  });
  completeBefore(context, reportAction('comment'), {
    effect: 'comment',
    payload: { target: { kind: 'issue', number: support.TICKET }, body: 'A hold.', bodyHash: 'hash' },
    evidence: { id: 7 },
  });
  const published: string[] = [];
  context.publicText = (text) => {
    published.push(text);
    return text;
  };
  const ended = await support.rejection(cleanupHold.holdTicket(context, held));
  assert.ok(ended instanceof effectErrors.EarlyTerminalError, String(ended));
  assert.deepEqual(published, [], 'a complete comment Action renders no body for publishing');
});

// A request saved as the Approval Request a Visit waits on, as `request` saves it before any label moves.
function waitingRequest(context: support.ExecutionContext) {
  const instance = approval.request({
    execution: context.record.execution,
    vertex: 'approve',
    visit: 1,
    nonce: '1',
    head: 'abc',
    body: '',
    configHash: 'abc123',
  });
  context.record.approvalRequest = instance;
  return instance;
}

test("a request whose retire label landed does not read the issue's labels again", async (t) => {
  const { context, fakeGh } = await support.executionContext(t);
  waitingRequest(context);
  completeBefore(context, requestIdentity('ask.retire.1'), {
    effect: 'label',
    payload: { ticket: support.TICKET, add: [], remove: [] },
    evidence: LABEL_LANDED,
  });
  const ended = await support.rejection(approvalAction.awaitApproval(context, APPROVAL_RUNNING));
  assert.ok(ended instanceof effectErrors.EarlyTerminalError, String(ended));
  assert.ok(fakeGh.labels.has('gg:await:approve'), 'the request goes on to its Await Label');
  assert.deepEqual(
    fakeGh.calls.filter(({ args }) => args[0] === 'issue' && args[1] === 'view'),
    [],
    "the retire label's labels are read only while it is not complete",
  );
});

// No Run leaves this state, since a consumption's completion clears the request and settles the Visit in one save: the
// case seeds it to reach the result a complete consumption declares.
test('a complete consumption resumes to its Decision, not effect-completed', async (t) => {
  const { context } = await support.executionContext(t);
  const instance = waitingRequest(context);
  const decision = { instance: instance.id, event: 1, actor: 'the-owner', time: 't', outcome: 'approved' };
  completeBefore(context, requestIdentity('ask.consume.1'), {
    effect: 'label',
    payload: { ticket: support.TICKET, add: [], remove: [], decision: { ...decision, next: 'publish', reply: null } },
    evidence: LABEL_LANDED,
  });
  const resolution = await approvalAction.awaitApproval(context, APPROVAL_RUNNING);
  assert.deepEqual(resolution, {
    outcome: 'approved',
    direction: 'stop',
    row: 'decision',
    rule: { table: 'fixed', row: 'decision' },
  });
});

test('a complete agent Attempt resumes to the result its evidence saved, and makes no Brief', async (t) => {
  const { context } = await support.executionContext(t);
  const reads: string[] = [];
  context.pinned.configuration.files = {
    get greenBrief() {
      reads.push('greenBrief');
      return golden.layerFile('The Brief.');
    },
  };
  const actionIdentity = { vertex: 'green', visit: 1, procedure: 'implement', action: 'green', recovery: 0 };
  const saved: visit.TableResolution = {
    outcome: 'ok',
    direction: 'advance',
    rule: { table: 'passed', row: 2 },
    row: null,
    check: null,
    retryAfterMs: null,
    retryKind: null,
    failureClass: null,
  };
  completeBefore(
    context,
    { ...actionIdentity, attempt: 1 },
    { effect: 'call', payload: { baseline: {} }, evidence: saved },
  );
  const resolution = await agentAction.agent(context, {
    actionIdentity,
    action: { id: 'green', do: 'agent', brief: 'greenBrief', schema: 'implement.schema.json' },
    state: runningVisit(),
  });
  assert.deepEqual(resolution, saved);
  assert.deepEqual(reads, [], 'a complete Attempt makes no Brief');
});

test('each complete effect Action resumes to effect-completed', async (t) => {
  const { context } = await support.executionContext(t);
  // A complete Attempt reads nothing more of the snapshot than what its kind reads before the Attempt.
  context.record.configurationSnapshot = { agent: null } as unknown as visit.ConfigurationSnapshot;
  const state = runningVisit();
  const resumed: Record<string, visitScope.ActionResolution> = {};
  for (const [kind, act] of Object.entries(effectActions.EFFECT_KINDS)) {
    const actionIdentity = { ...IDENTITY, action: kind };
    completeBefore(context, actionIdentity, { effect: kind, payload: {}, evidence: { sha: 'abc' } });
    resumed[kind] = await act(context, {
      actionIdentity,
      action: { id: kind, do: kind as procedures.ActionKind },
      state,
    });
  }
  assert.deepEqual(resumed, {
    commit: attempt.EFFECT_COMPLETED,
    push: attempt.EFFECT_COMPLETED,
    comment: attempt.EFFECT_COMPLETED,
    'pr-upsert': attempt.EFFECT_COMPLETED,
    'pr-ready': attempt.EFFECT_COMPLETED,
  });
});
