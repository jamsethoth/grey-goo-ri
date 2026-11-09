import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as afterPhase from '../support/after-phase.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as fakeGh from '../support/fake-gh.ts';

const { NEEDS_HUMAN_LABEL } = executionContext;
type GoldenFixture = golden.GoldenFixture;

// An Action Marker without the Execution and Run every entry of one record shares.
const actionOf = (actionMarker: string) => marker.actionKeyOf(marker.partsOf(actionMarker));
const ticketEnds = (fixture: GoldenFixture) => fixture.readEvents().filter((event) => event.type === 'ticket_end');

// A misscoped green ends at needs-replan through the Flow's routes, whose Terminal posts the diagnosis on the ticket
// and the epic.
const DIAGNOSIS = 'The ticket asks add to both sum and concatenate.';
const REPLAN_LOG = [
  'red/1/red/0 call intent',
  'red/1/red/0 call evidence',
  'red/1/red/0 call complete',
  'red/1/commit/0 commit intent',
  'red/1/commit/0 commit evidence',
  'red/1/commit/0 commit complete',
  'green/1/green/0 call intent',
  'green/1/green/0 call evidence',
  'green/1/green/0 call complete',
  'needs-replan/1/end-comment/0 comment intent',
  'needs-replan/1/end-comment/0 comment evidence',
  'needs-replan/1/end-comment/0 comment complete',
  'needs-replan/1/end-epic-comment/0 comment intent',
  'needs-replan/1/end-epic-comment/0 comment evidence',
  'needs-replan/1/end-epic-comment/0 comment complete',
  'needs-replan/1/end-label/0 label intent',
  'needs-replan/1/end-label/0 label evidence',
  'needs-replan/1/end-label/0 label complete',
];
for (const point of Object.keys(crashResume.POINTS) as (keyof typeof crashResume.POINTS)[]) {
  test(`a crash ${point} of the epic diagnosis comment resumes the same needs-replan Actions`, async (t) => {
    const fixture = await golden.fixture(t, {
      responses: {
        ...structuredClone(golden.firstVisitResponses),
        'green/1/green/1': {
          files: {},
          response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: DIAGNOSIS },
        },
      },
    });
    await crashResume.crashed(fixture, ['needs-replan', 1, 'end-epic-comment', 0], point);

    const result = await interpreter.runExecution({
      ...fixture.options,
      record: executionReads.loadTicket(fixture),
    });
    assert.equal(result.outcome, 'needs-replan');
    const onEpic = fixture.gh.comments.filter(
      (comment) => comment.target === 'issue' && comment.number === fixture.executionRecord.epic,
    );
    assert.equal(onEpic.length, 1, 'exactly one diagnosis on the epic');
    assert.ok(onEpic[0]?.body.includes(DIAGNOSIS));
    const onTicket = fixture.gh.comments.filter(
      (comment) => comment.target === 'issue' && comment.number === golden.TICKET,
    );
    assert.equal(onTicket.length, 1);
    assert.ok(onTicket[0]?.body.includes(DIAGNOSIS));
    assert.ok(fixture.gh.labels.has('gg:state:needs-replan'), 'the label Action keeps its own payload');
    const final = executionReads.loadTicket(fixture);
    assert.equal(final.state, 'needs-replan');
    assert.deepEqual(
      final.writeAheadLog.map((entry) => `${actionOf(entry.actionMarker)} ${entry.effect} ${entry.step}`),
      REPLAN_LOG,
      'one intent, one evidence and one completion per Action',
    );
  });
}

// The red call writes a Protected File, an Integrity Violation: the worktree is rolled back and the ticket goes to
// needs-human. On the fake integrity the write is only scripted, for a test whose subject is what follows the
// violation.
async function violating(t: TestContext) {
  const fixture = await golden.fixture(t);
  afterPhase.afterPhase(fixture, 'red', () => fixture.fakeIntegrity?.write(fixture.worktree, 'CLAUDE.md'));
  return fixture;
}

const LANDED_POINTS = ['after-effect', 'after-completion'] as const;
for (const point of LANDED_POINTS) {
  test(`a crash ${point} of gg's own needs-human label finishes the Terminal`, async (t) => {
    const fixture = await violating(t);
    await crashResume.crashed(fixture, ['needs-human', 1, 'end-label', 0], point);
    assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'gg applied the label before the crash');

    const result = await interpreter.runExecution({
      ...fixture.options,
      record: executionReads.loadTicket(fixture),
    });
    assert.equal(result.outcome, 'needs-human');
    const final = executionReads.loadTicket(fixture);
    assert.equal(final.state, 'needs-human', 'not mistaken for a human override');
    assert.deepEqual(writeAhead.openIntents(final), []);
    assert.equal(ticketEnds(fixture).length, 1);
  });
}

const labelEdits = (fixture: GoldenFixture) =>
  fixture.gh.calls.filter((call) => call.args[0] === 'issue' && call.args[1] === 'edit').length;

// GitHub keeps the repository's spelling of a label gg adds, and the prefix's case may change between Runs.
for (const point of LANDED_POINTS) {
  test(`gg-owned mixed-case needs-human completes without abandonment or replay, crash ${point}`, async (t) => {
    const fixture = await violating(t);
    const spelled = 'Gg:state:needs-human';
    fixture.gh = fakeGh.fakeGh({ branch: golden.BRANCH, ticket: golden.TICKET, repoLabels: [spelled] });
    fixture.options.deps.gh = github.createGh(fixture.gh.gh);
    await crashResume.crashed(fixture, ['needs-human', 1, 'end-label', 0], point);
    assert.deepEqual([...fixture.gh.labels], [spelled], 'GitHub shows the repository spelling');
    assert.equal(labelEdits(fixture), 1);

    const result = await interpreter.runExecution({
      ...fixture.options,
      labelPrefix: 'Gg',
      record: executionReads.loadTicket(fixture),
    });
    assert.equal(result.outcome, 'needs-human');
    const final = executionReads.loadTicket(fixture);
    assert.equal(final.state, 'needs-human', 'not mistaken for a human override');
    assert.deepEqual(writeAhead.openIntents(final), []);
    assert.equal(labelEdits(fixture), 1, 'the label is not applied again');
    assert.equal(ticketEnds(fixture).length, 1);
  });
}

// gg's needs-human label Action, crashed after GitHub applied it: Reconciliation checks the labels GitHub then shows.
async function crashedLabel(t: TestContext) {
  const fixture = await violating(t);
  const crashed = await crashResume.crashed(fixture, ['needs-human', 1, 'end-label', 0], 'after-effect');
  const editsBefore = labelEdits(fixture);
  fixture.gh.labels.clear();
  return { fixture, actionMarker: crashed.actionMarker, editsBefore };
}

// A found effect has its evidence saved; the interpreter completes it with its Event.
const evidenced = async (fixture: GoldenFixture, actionMarker: string) =>
  executionReads
    .loadTicket(fixture)
    .writeAheadLog.some((entry) => entry.actionMarker === actionMarker && entry.step === 'evidence');
const terminalEffects = async (fixture: GoldenFixture, actionMarker: string) =>
  (
    await reconcile.terminalEffects(executionReads.loadTicket(fixture), {
      gh: fixture.options.deps.gh,
      labelPrefix: 'gg',
      cwd: fixture.mainRoot,
      markers: [actionMarker],
    })
  ).next;

test('label reconciliation leaves a removal still shown differently cased open', async (t) => {
  const { fixture, actionMarker, editsBefore } = await crashedLabel(t);
  fixture.gh.labels.add(NEEDS_HUMAN_LABEL);
  fixture.gh.labels.add('GG:STATE:IN-PROGRESS');
  assert.equal(await terminalEffects(fixture, actionMarker), 'continue');
  assert.equal(await evidenced(fixture, actionMarker), false);
  assert.equal(labelEdits(fixture), editsBefore, 'Reconciliation makes no label edit');
});

test('label reconciliation leaves an absent addition open', async (t) => {
  const { fixture, actionMarker, editsBefore } = await crashedLabel(t);
  assert.equal(await terminalEffects(fixture, actionMarker), 'continue');
  assert.equal(await evidenced(fixture, actionMarker), false);
  assert.equal(labelEdits(fixture), editsBefore, 'Reconciliation makes no label edit');
});

test('label reconciliation completes a differently cased addition with the removal absent', async (t) => {
  const { fixture, actionMarker, editsBefore } = await crashedLabel(t);
  fixture.gh.labels.add('GG:State:Needs-Human');
  assert.equal(await terminalEffects(fixture, actionMarker), 'continue');
  assert.equal(await evidenced(fixture, actionMarker), true);
  assert.equal(labelEdits(fixture), editsBefore, 'Reconciliation makes no label edit');
});
