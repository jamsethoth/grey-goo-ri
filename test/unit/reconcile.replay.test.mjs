import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from '../support/golden.ts';
import { POINTS, crashed } from '../support/crash-resume.ts';
import { NEEDS_HUMAN_LABEL } from '../support/execution-context.ts';
import { loadTicket } from '../support/execution-reads.ts';
import * as fakeGhModule from '../support/fake-gh.ts';

// An Action Marker without the Execution and Run every entry of one record shares.
const actionOf = (m) => marker.actionKeyOf(marker.partsOf(m));

// A misscoped green ends at needs-replan through the Flow's routes, whose Terminal posts the diagnosis on the ticket and the epic.
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
for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of the epic diagnosis comment resumes the same needs-replan Actions`, async (t) => {
    const g = await golden.fixture(t, {
      responses: {
        ...structuredClone(golden.firstVisitResponses),
        'green/1/green/1': {
          files: {},
          response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: DIAGNOSIS },
        },
      },
    });
    await crashed(g, ['needs-replan', 1, 'end-epic-comment', 0], point);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-replan');
    const onEpic = g.gh.comments.filter((c) => c.target === 'issue' && c.number === g.executionRecord.epic);
    assert.equal(onEpic.length, 1, 'exactly one diagnosis on the epic');
    assert.ok(onEpic[0].body.includes(DIAGNOSIS));
    const onTicket = g.gh.comments.filter((c) => c.target === 'issue' && c.number === golden.TICKET);
    assert.equal(onTicket.length, 1);
    assert.ok(onTicket[0].body.includes(DIAGNOSIS));
    assert.ok(g.gh.labels.has('gg:state:needs-replan'), 'the label Action keeps its own payload');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-replan');
    assert.deepEqual(
      final.writeAheadLog.map((e) => `${actionOf(e.actionMarker)} ${e.effect} ${e.step}`),
      REPLAN_LOG,
      'one intent, one evidence and one completion per Action',
    );
  });
}

// The red call writes a Protected File, an Integrity Violation: the worktree is rolled back and the ticket goes to
// needs-human. On the fake integrity the write is only scripted, for a test whose subject is what follows the violation.
async function violating(t) {
  const g = await golden.fixture(t);
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red') g.fakeIntegrity.write(g.worktree, 'CLAUDE.md');
    return out;
  };
  return g;
}

for (const point of ['after-effect', 'after-completion']) {
  test(`a crash ${point} of gg's own needs-human label finishes the Terminal`, async (t) => {
    const g = await violating(t);
    await crashed(g, ['needs-human', 1, 'end-label', 0], point);
    assert.ok(g.gh.labels.has(NEEDS_HUMAN_LABEL), 'gg applied the label before the crash');

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-human', 'not mistaken for a human override');
    assert.deepEqual(writeAhead.openIntents(final), []);
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
  });
}

// GitHub keeps the repository's spelling of a label gg adds, and the prefix's case may change between Runs.
for (const point of ['after-effect', 'after-completion']) {
  test(`gg-owned mixed-case needs-human completes without abandonment or replay, crash ${point}`, async (t) => {
    const g = await violating(t);
    const spelled = 'Gg:state:needs-human';
    g.gh = fakeGhModule.fakeGh({ branch: golden.BRANCH, ticket: golden.TICKET, repoLabels: [spelled] });
    g.options.deps.gh = github.createGh(g.gh.gh);
    const edits = () => g.gh.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit').length;
    await crashed(g, ['needs-human', 1, 'end-label', 0], point);
    assert.deepEqual([...g.gh.labels], [spelled], 'GitHub shows the repository spelling');
    assert.equal(edits(), 1);

    const result = await interpreter.runExecution({ ...g.options, labelPrefix: 'Gg', record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-human', 'not mistaken for a human override');
    assert.deepEqual(writeAhead.openIntents(final), []);
    assert.equal(edits(), 1, 'the label is not applied again');
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
  });
}

// gg's needs-human label Action, crashed after GitHub applied it: Reconciliation checks the labels GitHub then shows.
async function crashedLabel(t) {
  const g = await violating(t);
  const { actionMarker: m } = await crashed(g, ['needs-human', 1, 'end-label', 0], 'after-effect');
  const edits = () => g.gh.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit').length;
  const editsBefore = edits();
  g.gh.labels.clear();
  return { g, m, edits, editsBefore };
}

// A found effect has its evidence saved; the interpreter completes it with its Event.
const evidenced = async (g, m) =>
  (await loadTicket(g)).writeAheadLog.some((e) => e.actionMarker === m && e.step === 'evidence');
const terminalEffects = async (g, m) =>
  (
    await reconcile.terminalEffects(await loadTicket(g), {
      gh: g.options.deps.gh,
      labelPrefix: 'gg',
      cwd: g.mainRoot,
      markers: [m],
    })
  ).next;

test('label reconciliation leaves a removal still shown differently cased open', async (t) => {
  const { g, m, edits, editsBefore } = await crashedLabel(t);
  g.gh.labels.add(NEEDS_HUMAN_LABEL);
  g.gh.labels.add('GG:STATE:IN-PROGRESS');
  assert.equal(await terminalEffects(g, m), 'continue');
  assert.equal(await evidenced(g, m), false);
  assert.equal(edits(), editsBefore, 'Reconciliation makes no label edit');
});

test('label reconciliation leaves an absent addition open', async (t) => {
  const { g, m, edits, editsBefore } = await crashedLabel(t);
  assert.equal(await terminalEffects(g, m), 'continue');
  assert.equal(await evidenced(g, m), false);
  assert.equal(edits(), editsBefore, 'Reconciliation makes no label edit');
});

test('label reconciliation completes a differently cased addition with the removal absent', async (t) => {
  const { g, m, edits, editsBefore } = await crashedLabel(t);
  g.gh.labels.add('GG:State:Needs-Human');
  assert.equal(await terminalEffects(g, m), 'continue');
  assert.equal(await evidenced(g, m), true);
  assert.equal(edits(), editsBefore, 'Reconciliation makes no label edit');
});
