import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import type * as record from '../../lib/record.ts';
import * as golden from '../support/golden.ts';
import * as crashResume from '../support/crash-resume.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as keys from '../support/keys.ts';

// Crash-and-resume golden traces (T18). Each side-effect Action of the golden red, green and publish Flow is crashed at
// one of three points by runExecution's test-only crashAt, then resumed by a second runExecution on a freshly loaded
// record.
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
// An Action Marker without the Execution and Run every entry of one record shares.
const actionOf = (actionMarker: string) => marker.actionKeyOf(marker.partsOf(actionMarker));

// Whatever the crash, the resumed record ends with one intent, one evidence and one completion per side-effect Action.
const FINAL_LOG = [
  'red/1/red/0 call intent',
  'red/1/red/0 call evidence',
  'red/1/red/0 call complete',
  'red/1/commit/0 commit intent',
  'red/1/commit/0 commit evidence',
  'red/1/commit/0 commit complete',
  'green/1/green/0 call intent',
  'green/1/green/0 call evidence',
  'green/1/green/0 call complete',
  'green/1/commit/0 commit intent',
  'green/1/commit/0 commit evidence',
  'green/1/commit/0 commit complete',
  'green/1/push/0 push intent',
  'green/1/push/0 push evidence',
  'green/1/push/0 push complete',
  'green/1/pr/0 pr-upsert intent',
  'green/1/pr/0 pr-upsert evidence',
  'green/1/pr/0 pr-upsert complete',
  'publish/1/pr/0 pr-upsert intent',
  'publish/1/pr/0 pr-upsert evidence',
  'publish/1/pr/0 pr-upsert complete',
  'publish/1/pr-ready/0 pr-ready intent',
  'publish/1/pr-ready/0 pr-ready evidence',
  'publish/1/pr-ready/0 pr-ready complete',
  'ready-for-qa/1/end-comment/0 comment intent',
  'ready-for-qa/1/end-comment/0 comment evidence',
  'ready-for-qa/1/end-comment/0 comment complete',
  'ready-for-qa/1/end-label/0 label intent',
  'ready-for-qa/1/end-label/0 label evidence',
  'ready-for-qa/1/end-label/0 label complete',
];
// One Action Event per Action: vertex/visit/action/recovery/attempt.
const ACTED = [
  'red/1/red/0/1',
  'red/1/red-check/0/1',
  'red/1/commit/0/1',
  'green/1/green/0/1',
  'green/1/test/0/1',
  'green/1/commit/0/1',
  'green/1/push/0/1',
  'green/1/pr/0/1',
  'publish/1/test/0/1',
  'publish/1/pr/0/1',
  'publish/1/pr-ready/0/1',
  'ready-for-qa/1/end-comment/0/1',
  'ready-for-qa/1/end-label/0/1',
];

// The branch has one commit per commit intent, and the remote branch is at the last.
async function assertCommitsLanded(fixture: golden.GoldenFixture) {
  assert.deepEqual(
    (await executionReads.branchMessages(fixture)).map((body) =>
      marker.formatMarker(marker.parseMarker(body) as Record<marker.MarkerPart, string>),
    ),
    [
      golden.markerOf(fixture.executionRecord, 'red', 1, 'commit', 0),
      golden.markerOf(fixture.executionRecord, 'green', 1, 'commit', 0),
    ],
    'one commit per commit intent',
  );
  assert.equal(
    await executionReads.originSha(fixture),
    await fixture.options.deps.git.headSha(fixture.worktree),
    'the remote branch is at the last commit',
  );
}

// One PR, ready, whose body is the one publish intended and whose pr-ready targets the pushed commit.
async function assertOnePullRequest(fixture: golden.GoldenFixture, final: record.ExecutionRecord) {
  const pr = fixture.gh.pr();
  assert.equal(
    fixture.gh.calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'create').length,
    1,
    'exactly one PR',
  );
  // publish's re-render is the last PR body.
  const upsert = final.writeAheadLog.findLast((entry) => entry.effect === 'pr-upsert' && entry.step === 'intent');
  assert.ok(pr?.body?.includes(marker.markerComment(upsert?.actionMarker as string)), 'the PR body carries the marker');
  assert.equal(pr?.isDraft, false, 'the PR ends ready');
  assert.deepEqual(
    final.writeAheadLog.find((entry) => entry.effect === 'pr-ready' && entry.step === 'intent')?.payload,
    {
      number: pr?.number,
      sha: await fixture.options.deps.git.headSha(fixture.worktree),
      tree: await fixture.options.deps.git.treeOf(fixture.worktree),
    },
    'pr-ready targets the pushed commit and the tree its Check passed on',
  );
  assert.equal(
    sha256(pr?.body as string),
    (upsert?.payload as { bodyHash: string }).bodyHash,
    'the PR body is the intended one',
  );
}

// Exactly one done comment, the one its intent describes.
function assertOneDoneComment(fixture: golden.GoldenFixture, final: record.ExecutionRecord) {
  const done = golden.markerOf(fixture.executionRecord, ...crashResume.EFFECTS.comment.place);
  const posted = crashResume.withMarker(
    fixture.gh.comments.map((comment) => comment.body),
    done,
  );
  assert.equal(posted.length, 1, 'exactly one comment with the marker');
  assert.equal(
    sha256(posted[0] as string),
    (
      final.writeAheadLog.find((entry) => entry.actionMarker === done && entry.step === 'intent')?.payload as {
        bodyHash: string;
      }
    ).bodyHash,
  );
}

for (const [action, effect] of Object.entries(crashResume.EFFECTS)) {
  for (const [point, expect] of Object.entries(crashResume.POINTS)) {
    test(expect.name(action), async (t) => {
      const fixture = await golden.fixture(t);
      const crashPoint = point as keyof typeof crashResume.POINTS;
      const { actionMarker, loaded } = await crashResume.crashed(fixture, effect.place, crashPoint);
      assert.equal(await effect.happened(fixture, actionMarker), expect.happened, `the crash came ${point}`);
      assert.deepEqual(
        executionReads.writeAheadSteps(loaded, actionMarker),
        expect.steps,
        `the log as the crash ${point} left it`,
      );

      const result = await interpreter.runExecution({ ...fixture.options, record: loaded });
      assert.equal(result.outcome, 'ready-for-qa');
      const final = await executionReads.loadTicket(fixture);
      assert.equal(final.state, 'ready-for-qa');
      assert.equal(fixture.harness.calls.length, 2, 'the resume continues at the cursor; no agent call is repeated');
      assert.deepEqual(
        fixture
          .readEvents()
          .filter((event): event is events.ActionEvent => event.type === 'action')
          .map((event) => keys.eventKey(event)),
        ACTED,
      );
      assert.deepEqual(
        final.writeAheadLog.map((entry) => `${actionOf(entry.actionMarker)} ${entry.effect} ${entry.step}`),
        FINAL_LOG,
      );

      await assertCommitsLanded(fixture);
      await assertOnePullRequest(fixture, final);
      assertOneDoneComment(fixture, final);
    });
  }
}

// A Vertex id with whitespace: its markers would be written, but parseMarker reads back only parts with none (#269).
const SPACED = 'red tests';
function spaceTheRedVertex(configured: golden.GoldenConfig) {
  const { ticket } = configured.flows.golden;
  ticket.vertices[SPACED] = ticket.vertices.red;
  delete ticket.vertices.red;
  ticket.entry = SPACED;
  ticket.vertices.green.inputs = {
    testFiles: { from: `${SPACED}.commit.files` },
    red: { from: `${SPACED}.red-check.evidence` },
  };
  (ticket.vertices.publish.inputs as Record<string, unknown>).red = { from: `${SPACED}.red-check.evidence` };
}

// On main before #269 this Flow was admitted, and a resume after a crash past the commit held the ticket, its Terminal
// Reason saying the commit "was not made".
test('a Vertex whose id has whitespace, whose commit a crash could not find by its marker, is kept out', async (t) => {
  const fixture = await golden.fixture(t);
  assert.throws(
    () => golden.configure(fixture, spaceTheRedVertex),
    /vertices\.red tests: Vertex id "red tests" must be non-empty with no ":", "\.", "\/", "--" or whitespace/,
  );
});
