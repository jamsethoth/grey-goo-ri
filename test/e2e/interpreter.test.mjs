import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.mjs';
import * as marker from '../../lib/marker.mjs';
import * as golden from '../support/golden.mjs';
import {
  TDD_VERTICES, FIRST_VISIT, actionMarker, actionEvent, loadTicket, ticketComments, contendRepoLock, lockedSetup, terminalReasonOf, intents,
} from '../support/interpreter.mjs';

// The deterministic Actions of a first visit, each an advance at Attempt 1 of its Vertex's first Visit: red runs tests-fail
// and green runs implement.
const deterministic = (vertex, action, rule) => {
  const procedure = vertex === 'red' ? 'tests-fail' : 'implement';
  return { action, recovery: 0, schema: 2, vertex, visit: 1, procedure, attempt: 1, direction: 'advance', rule, agent: undefined };
};

test('golden: a first-visit pass ends at ready-for-qa through publish', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  let draft;
  const { markReady } = g.options.gh;
  g.options.gh = { ...g.options.gh, markReady: async (...args) => { draft = g.gh.pr().isDraft; return markReady(...args); } };
  await interpreter.runExecution(g.options);
  g.events = g.readEvents();

  assert.deepEqual(golden.trace(g.events).filter((e) => TDD_VERTICES.includes(e.vertex)), FIRST_VISIT);
  const end = g.events.at(-1);
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'ready-for-qa');
  assert.equal(end.ticket, golden.TICKET);
  // publish has no Agent: its test Check, the PR body re-render and pr-ready, each at Recovery Number 0.
  assert.deepEqual(golden.trace(g.events).filter((e) => e.vertex === 'publish'), ['test', 'pr', 'pr-ready']
    .map((action) => ({ vertex: 'publish', action, recovery: 0, attempt: 1, outcome: 'ok' })));
  assert.deepEqual(g.events.filter((e) => e.type === 'action' && e.vertex === 'publish').map((e) => [e.action, e.agent, e.procedure]),
    [['test', undefined, 'publish'], ['pr', undefined, 'publish'], ['pr-ready', undefined, 'publish']]);
  assert.equal(g.shells.length, 3, "publish runs the test command again, on the tree pr-ready publishes");

  const fields = ({ action, recovery, schema, vertex, visit, procedure, attempt, direction, rule, agent }) =>
    ({ action, recovery, schema, vertex, visit, procedure, attempt, direction, rule, agent });
  const actions = g.events.filter((e) => e.type === 'action' && TDD_VERTICES.includes(e.vertex));
  assert.deepEqual(actions.map(fields), [
    { ...deterministic('red', 'red', 'ok'), agent: true }, deterministic('red', 'red-check', 'ok'), deterministic('red', 'commit', 'effect-completed'),
    { ...deterministic('green', 'green', 'ok'), agent: true }, deterministic('green', 'test', 'ok'), deterministic('green', 'commit', 'effect-completed'),
    deterministic('green', 'push', 'effect-completed'), deterministic('green', 'pr', 'effect-completed'),
  ]);
  assert.deepEqual(actions.filter((e) => e.signals == null).map((e) => `${e.action}/${e.recovery}`), [], 'every Action carries its signals');

  const red = actionEvent(g, 'red', 'red');
  assert.equal(red.sessionId, 'fake-session-1');
  assert.equal(red.lineage, null, 'red starts a fresh session');
  assert.match(red.transcriptPath, /fake-session-1\.jsonl$/);
  assert.equal(red.usage.cumulative.costUsd, null, 'red: absent cost capability is null');
  assert.equal(red.usage.cumulative.reasoning, null, 'red: absent reasoning capability is null');
  assert.equal(typeof red.usage.cumulative.input, 'number');
  const green = actionEvent(g, 'green', 'green');
  assert.equal(green.sessionId, 'fake-session-2');
  assert.equal(green.lineage, null, 'green starts a fresh session');
  assert.match(green.transcriptPath, /fake-session-2\.jsonl$/);
  assert.equal(green.usage.cumulative.costUsd, null, 'green: absent cost capability is null');
  assert.equal(green.usage.cumulative.reasoning, null, 'green: absent reasoning capability is null');
  assert.equal(typeof green.usage.cumulative.input, 'number');

  // Two commits on the branch, each carrying both trailers.
  const messages = golden.sh(g.worktree, 'log', '--format=%B%x00', `${g.base}..HEAD`).split('\0').map((m) => m.trim()).filter(Boolean).reverse();
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^test: /);
  assert.ok(messages[0].includes('Feature-Flow-Stage: red fake/model-x/high'), messages[0]);
  assert.ok(messages[0].includes(`Gg-Action: ${actionMarker(g, 'red', 'commit')}`), messages[0]);
  assert.match(messages[1], /^feat: /);
  assert.ok(messages[1].includes('Feature-Flow-Stage: green fake/model-x/high'), messages[1]);
  assert.ok(messages[1].includes(`Gg-Action: ${actionMarker(g, 'green', 'commit')}`), messages[1]);
  assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0], golden.sh(g.worktree, 'rev-parse', 'HEAD'));

  // The draft PR body carries the marker line, the red Evidence and the provenance row.
  assert.equal(draft, true, 'the PR is opened as a draft');
  const body = g.gh.pr().body;
  assert.ok(body.includes("Cannot find module 'lib/add.mjs'"), 'red evidence in the PR body');
  assert.match(body, /^\| red \| fake \| model-x \| high \| /m);
  assert.match(body, /^\| green \| fake \| model-x \| high \| /m);
  assert.equal(g.gh.pr().isDraft, false, "publish's pr-ready marks the PR ready");
  assert.ok(g.gh.pr().body.includes(marker.markerComment(actionMarker(g, 'publish', 'pr'))), 'publish re-renders the PR body');

  assert.deepEqual(g.rec.cursor, { vertex: 'ready-for-qa', visit: 1, action: 'end-label', recovery: 0, attempt: 1 });
  assert.deepEqual(g.rec.visits, { red: 1, green: 1, publish: 1 });
  assert.equal(g.rec.state, 'ready-for-qa');
  assert.ok(g.gh.labels.has('gg:state:ready-for-qa'));
  assert.equal(g.rec.terminalReason.text,
    `publish visit 1 completed every publish Action: test passed. PR #${g.rec.pr} is ready for review.`);
});

// R2d: red committed its tests, then a human edited a tracked file before green started.
test("a write Vertex on a dirty worktree gg's records do not explain is held", async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  const { commitStaged } = g.options.git;
  let edited = null;
  g.options.git = { ...g.options.git, commitStaged: async (...args) => {
    const sha = await commitStaged(...args);
    [edited] = golden.sh(g.worktree, 'ls-files').split('\n');
    writeFileSync(join(g.worktree, edited), 'a human edit\n');
    return sha;
  } };
  const { outcome } = await interpreter.runExecution(g.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(g.harness.calls.map((c) => c.marker), [actionMarker(g, 'red', 'red')], 'no green agent runs over unknown changes');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), `M ${edited}`, 'the human edit survives');
  assert.match(golden.sh(g.worktree, 'log', '-1', '--format=%s'), /^test: /, "red's commit stays");
  assert.deepEqual(intents(g.rec, 'reset'), []);
  assert.equal(g.rec.history.at(-1)?.kind, 'held');
  assert.deepEqual(g.rec.visits, { red: 1, green: 1 });
  const reason = terminalReasonOf(g);
  assert.deepEqual(reason.decidedBy, { hold: 'dirty-worktree' });
  assert.match(reason.text, /uncommitted changes before green/);
});

// A gh call that changes GitHub: a comment, a label, a label definition or a pull request.
const ghWrite = (args) => golden.isCommentPost(args) || (args[0] === 'issue' && args[1] === 'edit')
  || (args[0] === 'label' && args[1] === 'create') || (args[0] === 'pr' && ['create', 'edit', 'ready'].includes(args[1]));

test('a run stop during a repo-lock wait skips the queued effect and only needs-human reporting follows', async (t) => {
  const g = await golden.setup(t, { integrity: 'real' });
  const runState = { stop: null, remoteNotBefore: 0 };
  let before;
  let written;
  // Another Ticket stops the run while this one's push waits for the repo lock.
  const lock = contendRepoLock(t, g.commonDir, () => {
    runState.stop = { failureClass: 'auth', ticket: 21 };
    before = g.gh.calls.length;
    written = { ...counts };
  });
  const counts = lockedSetup(g, (verb, n) => { if (verb === 'commitStaged' && n === 2) lock.arm(); });
  const result = await interpreter.runExecution({ ...g.options, runState });

  assert.equal(lock.state(), 'released', 'the push waited for the lock');
  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
  assert.deepEqual(counts, written, 'no git write follows the stop');
  assert.equal(golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`), '');
  const final = await loadTicket(g);
  assert.equal(final.state, 'needs-human');
  assert.equal(final.terminalReason.rule, 'run-stopped');
  assert.equal(final.terminalReason.text, 'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this '
    + 'Execution stopped before push.');
  const writes = g.gh.calls.slice(before).filter((c) => ghWrite(c.args));
  assert.equal(writes.length, 2, JSON.stringify(writes.map((c) => c.args)));
  assert.ok(golden.isCommentPost(writes[0].args, golden.TICKET), 'the needs-human comment');
  assert.ok(ticketComments(g).at(-1).body.startsWith('### gg: needs-human'));
  assert.ok(writes[1].args.join(' ').includes('--add-label gg:state:needs-human'), 'the needs-human label');
});
