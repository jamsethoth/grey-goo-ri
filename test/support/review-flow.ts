// The review and fix Procedures on an inline Flow matching request 3.3's illustration (T17): red(tests-fail) ->
// green(implement) -> reviewer(review); ok -> publish; changes -> {implementer-fix, max 2, exhausted needs-human};
// repeat -> {senior-dev, max 1, exhausted needs-human}; implementer-fix(fix) and senior-dev(fix, max 1, exhausted
// needs-human) -> reviewer. `reviewFixture` builds it and runs nothing; `runReviewFlow` runs it.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as executionReads from './execution-reads.ts';
import * as fakeGh from './fake-gh.ts';
import type * as fakeHarness from './fake-harness.ts';
import * as golden from './golden.ts';
import * as goldenRun from './golden-run.ts';
import * as keys from './keys.ts';

type GoldenFixture = golden.GoldenFixture;

export const REVIEWER_PERSONA = '# reviewer\nJudge the diff.\n';
export const finding = (severity: string, file: string, issue: string) => ({
  severity,
  file,
  issue,
  fix: 'Make it right.',
});
export const review = (claim: string, findings: object[] = [], extra = {}) => ({
  claim,
  summary: `The review says ${claim}.`,
  definitionOfDoneMet: true,
  redGreenEvidenceOk: true,
  findings,
  diagnosis: '',
  ...extra,
});
export const reviewed = (response: unknown, files = {}): fakeHarness.ScriptedResponse => ({ files, response });
export const fixed = (files: Record<string, string>): fakeHarness.ScriptedResponse => ({
  files,
  response: { ...golden.greenResponse, summary: 'Address the findings.' },
});

export const MAJOR = finding('major', 'lib/add.mjs', 'add ignores non-number input at line 1');

export const REVIEW_INPUTS = golden.implementationInputs(['green', 'implementer-fix', 'senior-dev']);
// The fix reads the latest review's Findings, their file paths as its named tests, and the Red Evidence for the PR
// body.
export const FIX_INPUTS = {
  findings: { from: 'reviewer.review.response.findings' },
  testFiles: { from: 'reviewer.review.response.findings', pick: 'file' },
  red: { from: 'red.red-check.evidence' },
};

// Adds the reviewer, the fix Vertices and their routes to the golden configuration.
function withReview(configured: golden.GoldenConfig) {
  configured.files['reviewer.md'] = golden.layerFile(REVIEWER_PERSONA);
  configured.agents.reviewer = { ...golden.implementerAgent('reviewer.md'), model: 'model-r', access: 'read-only' };
  const { vertices } = configured.flows.golden!.ticket;
  vertices.green!.route = { ok: 'reviewer' };
  vertices.reviewer = {
    use: 'reviewer',
    procedure: 'review',
    inputs: REVIEW_INPUTS,
    route: {
      ok: 'publish',
      changes: { to: 'implementer-fix', max: 2, exhausted: { end: 'needs-human' } },
      repeat: { to: 'senior-dev', max: 1, exhausted: { end: 'needs-human' } },
    },
  };
  vertices['implementer-fix'] = { use: 'implementer', procedure: 'fix', inputs: FIX_INPUTS, route: { ok: 'reviewer' } };
  vertices['senior-dev'] = {
    use: 'implementer',
    procedure: 'fix',
    max: 1,
    exhausted: { end: 'needs-human' },
    inputs: FIX_INPUTS,
    route: { ok: 'reviewer' },
  };
  vertices.publish!.inputs = REVIEW_INPUTS;
}

export interface ReviewOptions extends Omit<golden.GoldenOptions, 'responses'> {
  exec?: runContext.Deps['exec'];
  // Edits the review configuration further.
  configure?: (configured: golden.GoldenConfig) => void;
}

// The review Flow's golden fixture over the first Visit's responses and `responses`. It runs nothing.
export async function reviewFixture(
  t: TestContext,
  responses: fakeHarness.ScriptedResponses,
  { exec, integrity, git, configure }: ReviewOptions = {},
): Promise<GoldenFixture> {
  const fixture = await golden.fixture(t, {
    responses: { ...structuredClone(golden.firstVisitResponses), ...responses },
    integrity,
    git,
  });
  golden.configure(fixture, withReview);
  if (configure) golden.configure(fixture, configure);
  if (exec) fixture.options.deps.exec = exec;
  return fixture;
}

// The review fixture once its Execution has run, with its declared Actions' Events, and `actionsAt(vertex, visit,
// action, recovery)` the Events of one Visit of an Action.
export type ReviewRun = goldenRun.GoldenRun & {
  actions: events.ActionEvent[];
  actionsAt: (vertex: string, visit: number, action: string, recovery?: number) => events.ActionEvent[];
};

// Builds the review fixture and runs its Execution.
export async function runReviewFlow(
  t: TestContext,
  responses: fakeHarness.ScriptedResponses,
  options?: ReviewOptions,
): Promise<ReviewRun> {
  const ran = await goldenRun.ranToEnd(await reviewFixture(t, responses, options));
  const actions = ran.events.filter(
    (event): event is events.ActionEvent => event.type === 'action' && !!event.procedure,
  );
  const actionsAt = (vertex: string, visit: number, action: string, recovery = 0) =>
    actions.filter((event) => event.visit === visit && executionReads.isAction(event, vertex, action, recovery));
  return { ...ran, actions, actionsAt };
}

export const prReviewComments = (fixture: GoldenFixture) =>
  fixture.gh.comments.filter(
    (comment) => comment.number === fixture.gh.pr()?.number && /### gg review/.test(comment.body),
  );
export const ticketComments = (fixture: GoldenFixture) =>
  fixture.gh.comments.filter((comment) => comment.target === 'issue' && comment.number === golden.TICKET);

// A review or fix stop ends with one Terminal Reason in the record, on ticket_end and in exactly one ticket comment.
export function reviewStopReason(fixture: goldenRun.GoldenRun) {
  const reason = fixture.executionRecord.terminalReason;
  assert.ok(reason, 'the record holds a Terminal Reason');
  const ticketEnd = fixture.events.at(-1) as { terminalReason?: unknown };
  assert.deepEqual(ticketEnd.terminalReason, reason, 'ticket_end carries the same Terminal Reason');
  const posted = ticketComments(fixture).filter((comment) =>
    comment.body.includes(`**Terminal Reason:** ${reason.text}`),
  );
  assert.equal(posted.length, 1, 'the Terminal Reason is posted once on the ticket');
  assert.match(posted[0]?.body ?? '', /^<!-- gg-action gg:\S+ -->$/m);
  return reason;
}

// GitHub writes and push retry recognised transient failures inside the Action, through the marker lookup (#66).
export const PR = 7;
export const okReview = { [keys.responseKey('reviewer', 1, 'review', 1)]: reviewed(review('ok')) };
export const REVIEW_COMMENT = keys.retryKey({ vertex: 'reviewer', visit: 1, action: 'comment', recovery: 0 });
export const commentPosts = (fixture: GoldenFixture, pr = PR) =>
  fixture.gh.calls.filter((call) => fakeGh.isCommentPost(call.args, pr));
export const onPr = (fields: Omit<fakeGh.GhFailure, 'matches'>): fakeGh.GhFailure => ({
  matches: (args) => fakeGh.isCommentPost(args, PR),
  ...fields,
});

// Crashes the `nth` review-comment POST as it launches, after the queued failures before it.
export function crashPost(fixture: GoldenFixture, nth: number): () => number {
  const counted = { posts: 0 };
  const crashing = fakeGh.ghThrough(fixture.gh, async ({ args }, next) => {
    if (fakeGh.isCommentPost(args, PR) && ++counted.posts === nth)
      throw new interpreter.CrashError('crash as the POST launched');
    return next();
  });
  fixture.options.deps.gh = github.createGh(crashing);
  return () => counted.posts;
}
