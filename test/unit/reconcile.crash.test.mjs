import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as interpreter from '../../lib/interpreter.mjs';
import * as marker from '../../lib/marker.mjs';
import * as golden from '../support/golden.mjs';
import {
  markerOf, stepsOf, branchMessages, originSha, withMarker, loadTicket, EFFECTS, POINTS, crashed,
} from '../support/reconcile.mjs';

// T18: crash-and-resume golden traces. Each side-effect Action of the one-Vertex Flow is crashed at one of three points
// by runExecution's test-only crashAt, then resumed by a second runExecution on a freshly loaded record.
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// An Action Marker without the Execution and Run every entry of one record shares.
const actionOf = (m) => {
  const { vertex, visit, phase, ordinal } = marker.parseMarker(marker.markerTrailer(m));
  return `${vertex}/${visit}/${phase}/${ordinal}`;
};

// Whatever the crash, the resumed record ends with one intent, one evidence and one completion per side-effect Action.
const FINAL_LOG = [
  'red/1/red/1 call intent', 'red/1/red/1 call evidence', 'red/1/red/1 call complete',
  'red/1/red/3 commit intent', 'red/1/red/3 commit evidence', 'red/1/red/3 commit complete',
  'green/1/green/1 call intent', 'green/1/green/1 call evidence', 'green/1/green/1 call complete',
  'green/1/green/3 commit intent', 'green/1/green/3 commit evidence', 'green/1/green/3 commit complete',
  'green/1/green/4 push intent', 'green/1/green/4 push evidence', 'green/1/green/4 push complete',
  'green/1/green/5 pr-upsert intent', 'green/1/green/5 pr-upsert evidence', 'green/1/green/5 pr-upsert complete',
  'done/1/done/1 pr-ready intent', 'done/1/done/1 pr-ready evidence', 'done/1/done/1 pr-ready complete',
  'done/1/done/2 comment intent', 'done/1/done/2 comment evidence', 'done/1/done/2 comment complete',
  'done/1/done/3 label intent', 'done/1/done/3 label evidence', 'done/1/done/3 label complete',
];
// One Action Event per Action: vertex/visit/phase/ordinal/attempt.
const ACTED = [
  'red/1/red/1/1', 'red/1/red/2/1', 'red/1/red/3/1', 'green/1/green/1/1', 'green/1/green/2/1',
  'green/1/green/3/1', 'green/1/green/4/1', 'green/1/green/5/1', 'done/1/done/1/1', 'done/1/done/2/1', 'done/1/done/3/1',
];

for (const [action, effect] of Object.entries(EFFECTS)) {
  for (const [point, expect] of Object.entries(POINTS)) {
    test(expect.name(action), async (t) => {
      const g = await golden.setup(t);
      const { m, loaded } = await crashed(g, effect.at, point);
      assert.equal(await effect.happened(g, m), expect.happened, `the crash came ${point}`);
      assert.deepEqual(stepsOf(loaded, m), expect.steps, `the log as the crash ${point} left it`);

      const result = await interpreter.runExecution({ ...g.options, record: loaded });
      assert.equal(result.outcome, 'done');
      const final = await loadTicket(g);
      assert.equal(final.state, 'done');
      assert.equal(g.harness.calls.length, 2, 'the resume continues at the cursor; no agent call is repeated');
      assert.deepEqual(g.readEvents().filter((e) => e.type === 'action').map((e) => `${e.vertex}/${e.visit}/${e.phase}/${e.ordinal}/${e.attempt}`), ACTED);
      assert.deepEqual(final.log.map((e) => `${actionOf(e.marker)} ${e.action} ${e.step}`), FINAL_LOG);

      assert.deepEqual((await branchMessages(g)).map((b) => marker.formatMarker(marker.parseMarker(b))),
        [markerOf(g.rec, 'green', 1, 'green', 3), markerOf(g.rec, 'red', 1, 'red', 3)], 'one commit per commit intent');
      assert.equal(await originSha(g), await g.options.git.headSha(g.worktree), 'the remote branch is at the last commit');

      assert.equal(g.gh.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length, 1, 'exactly one PR');
      const upsert = final.log.find((e) => e.action === 'pr-upsert' && e.step === 'intent');
      assert.ok(g.gh.pr().body.includes(marker.markerComment(upsert.marker)), 'the PR body carries the marker');
      assert.equal(sha256(g.gh.pr().body), upsert.payload.bodyHash, 'the PR body is the intended one');

      const done = markerOf(g.rec, ...EFFECTS.comment.at);
      const posted = withMarker(g.gh.comments.map((c) => c.body), done);
      assert.equal(posted.length, 1, 'exactly one comment with the marker');
      assert.equal(sha256(posted[0]), final.log.find((e) => e.marker === done && e.step === 'intent').payload.bodyHash);
    });
  }
}
