import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type * as events from '../../lib/events.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as golden from '../support/golden.ts';
import { laterRun } from '../support/approval-flow.ts';
import { actionEvent, actionMarker, intents, loadTicket } from '../support/execution-reads.ts';
import { firstVisitWith } from '../support/first-visit.ts';
import * as keys from '../support/keys.ts';
import { FIRST_VISIT, TDD_VERTICES, terminalReasonOf } from '../support/golden-run.ts';
import { contendRepoLock, onLockedGit } from '../support/repo-lock-contention.ts';
import { ticketComments } from '../support/review-flow.ts';
import * as fakeGhModule from '../support/fake-gh.ts';
import * as gitShell from '../support/git-shell.ts';

// The deterministic Actions of a first visit, each an advance at Attempt 1 of its Vertex's first Visit: red runs
// tests-fail and green runs implement. A call and a Check whose pass passed hand the Claim over (claimed); an effect
// completed.
const deterministic = (vertex: string, action: string, row: string) => {
  const procedure = vertex === 'red' ? 'tests-fail' : 'implement';
  return {
    action,
    recovery: 0,
    schemaVersion: 2,
    vertex,
    visit: 1,
    procedure,
    attempt: 1,
    direction: 'advance',
    rule: { table: 'fixed', row },
    agent: false,
  };
};

// The golden first Visit on real git, run to its end, and whether the PR was still a draft when pr-ready marked it.
async function firstVisitPass(t: TestContext) {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const marked: { draft?: boolean } = {};
  const { markReady } = fixture.options.deps.gh;
  fixture.options.deps.gh = {
    ...fixture.options.deps.gh,
    markReady: async (...args: Parameters<typeof markReady>) => {
      marked.draft = fixture.gh.pr()!.isDraft;
      return markReady(...args);
    },
  };
  await interpreter.runExecution(fixture.options);
  return { ...fixture, events: fixture.readEvents(), draft: marked.draft };
}
type FirstVisitPass = Awaited<ReturnType<typeof firstVisitPass>>;

function tracesRedAndGreen(fixture: FirstVisitPass) {
  const { events: traced } = fixture;
  assert.deepEqual(
    golden.trace(traced).filter((event) => TDD_VERTICES.includes(event.vertex)),
    FIRST_VISIT,
  );
  const fields = ({
    action,
    recovery,
    schemaVersion,
    vertex,
    visit,
    procedure,
    attempt,
    direction,
    rule,
    agent,
  }: events.ActionEvent) => ({
    action,
    recovery,
    schemaVersion,
    vertex,
    visit,
    procedure,
    attempt,
    direction,
    rule,
    agent,
  });
  const actions = traced.filter(
    (event): event is events.ActionEvent => event.type === 'action' && TDD_VERTICES.includes(event.vertex),
  );
  assert.deepEqual(actions.map(fields), [
    { ...deterministic('red', 'red', 'claimed'), agent: true },
    deterministic('red', 'red-check', 'claimed'),
    deterministic('red', 'commit', 'effect-completed'),
    { ...deterministic('green', 'green', 'claimed'), agent: true },
    deterministic('green', 'test', 'claimed'),
    deterministic('green', 'commit', 'effect-completed'),
    deterministic('green', 'push', 'effect-completed'),
    deterministic('green', 'pr', 'effect-completed'),
  ]);
  assert.deepEqual(
    actions.filter((event) => event.signals == null).map((event) => `${event.action}/${event.recovery}`),
    [],
    'every Action carries its signals',
  );
}

function runsPublishWithoutAnAgent(fixture: FirstVisitPass) {
  const { events: traced } = fixture;
  // publish has no Agent: its test Check, the PR body re-render and pr-ready, each at Recovery Number 0.
  assert.deepEqual(
    golden.trace(traced).filter((event) => event.vertex === 'publish'),
    ['test', 'pr', 'pr-ready'].map((action) => ({ vertex: 'publish', action, recovery: 0, attempt: 1, outcome: 'ok' })),
  );
  assert.deepEqual(
    traced
      .filter((event): event is events.ActionEvent => event.type === 'action' && event.vertex === 'publish')
      .map((event) => [event.action, event.agent, event.procedure]),
    [
      ['test', false, 'publish'],
      ['pr', false, 'publish'],
      ['pr-ready', false, 'publish'],
    ],
  );
  assert.equal(fixture.shells.length, 3, 'publish runs the test command again, on the tree pr-ready publishes');
}

function startsFreshSessions(fixture: FirstVisitPass) {
  const red = actionEvent(fixture, 'red', 'red') as events.AgentActionEvent;
  assert.equal(red.sessionId, 'fake-session-1');
  assert.equal(red.sessionLineage, null, 'red starts a fresh session');
  assert.match(red.transcriptPath!, /fake-session-1\.jsonl$/);
  assert.equal(red.usage.cumulative.costUsd, null, 'red: absent cost capability is null');
  assert.equal(red.usage.cumulative.reasoningTokens, null, 'red: absent reasoning capability is null');
  assert.equal(typeof red.usage.cumulative.inputTokens, 'number');
  const green = actionEvent(fixture, 'green', 'green') as events.AgentActionEvent;
  assert.equal(green.sessionId, 'fake-session-2');
  assert.equal(green.sessionLineage, null, 'green starts a fresh session');
  assert.match(green.transcriptPath!, /fake-session-2\.jsonl$/);
  assert.equal(green.usage.cumulative.costUsd, null, 'green: absent cost capability is null');
  assert.equal(green.usage.cumulative.reasoningTokens, null, 'green: absent reasoning capability is null');
  assert.equal(typeof green.usage.cumulative.inputTokens, 'number');
}

function pushesTwoCommitsWithTrailers(fixture: FirstVisitPass) {
  // Two commits on the branch, each carrying both trailers.
  const messages = gitShell
    .sh(fixture.worktree, 'log', '--format=%B%x00', `${fixture.base}..HEAD`)
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean)
    .reverse();
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^test: /);
  assert.ok(messages[0].includes('Gg-Vertex: red fake/model-x/high'), messages[0]);
  assert.ok(messages[0].includes(`Gg-Action: ${actionMarker(fixture, 'red', 'commit')}`), messages[0]);
  assert.match(messages[1], /^feat: /);
  assert.ok(messages[1].includes('Gg-Vertex: green fake/model-x/high'), messages[1]);
  assert.ok(messages[1].includes(`Gg-Action: ${actionMarker(fixture, 'green', 'commit')}`), messages[1]);
  assert.equal(
    gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0],
    gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'),
  );
}

function opensADraftPrThatPublishMarksReady(fixture: FirstVisitPass) {
  // The draft PR body carries the marker line, the red Evidence and the provenance row.
  assert.equal(fixture.draft, true, 'the PR is opened as a draft');
  const body = fixture.gh.pr()!.body!;
  assert.ok(body.includes("Cannot find module 'lib/add.mjs'"), 'red evidence in the PR body');
  assert.match(body, /^\| red \| fake \| model-x \| high \| /m);
  assert.match(body, /^\| green \| fake \| model-x \| high \| /m);
  assert.equal(fixture.gh.pr()!.isDraft, false, "publish's pr-ready marks the PR ready");
  assert.ok(
    fixture.gh.pr()!.body!.includes(marker.markerComment(actionMarker(fixture, 'publish', 'pr'))),
    'publish re-renders the PR body',
  );
}

function endsAtReadyForQa(fixture: FirstVisitPass) {
  const end = fixture.events.at(-1) as events.TicketEndEvent;
  assert.equal(end.type, 'ticket_end');
  assert.equal(end.outcome, 'ready-for-qa');
  assert.equal(end.ticket, golden.TICKET);
  assert.deepEqual(fixture.executionRecord.cursor, {
    vertex: 'ready-for-qa',
    visit: 1,
    action: 'end-label',
    recovery: 0,
    attempt: 1,
  });
  assert.deepEqual(fixture.executionRecord.visits, { red: 1, green: 1, publish: 1 });
  assert.equal(fixture.executionRecord.state, 'ready-for-qa');
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'));
  assert.equal(
    fixture.executionRecord.terminalReason!.text,
    'publish visit 1 completed every publish Action: test passed. ' +
      `PR #${fixture.executionRecord.pr} is ready for review.`,
  );
}

// One run on real git, whose cases each assert one behaviour of it.
test('golden: a first-visit pass', async (t) => {
  const pass = await firstVisitPass(t);
  await t.test('golden: a first-visit pass traces red and green as advances', () => tracesRedAndGreen(pass));
  await t.test('golden: a first-visit pass runs publish with no Agent', () => runsPublishWithoutAnAgent(pass));
  await t.test('golden: a first-visit pass starts a fresh Session for red and for green', () =>
    startsFreshSessions(pass),
  );
  await t.test('golden: a first-visit pass pushes two commits that carry both trailers', () =>
    pushesTwoCommitsWithTrailers(pass),
  );
  await t.test('golden: a first-visit pass opens a draft PR that publish marks ready', () =>
    opensADraftPrThatPublishMarksReady(pass),
  );
  await t.test('golden: a first-visit pass ends at ready-for-qa through publish', () => endsAtReadyForQa(pass));
});

// Red committed its tests, then a human edited a tracked file before green started (R2d).
test("a write Vertex on a dirty worktree gg's records do not explain is held", async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const { commitStaged } = fixture.options.deps.git;
  let edited: string | null | undefined = null;
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    commitStaged: async (...args: Parameters<typeof commitStaged>) => {
      const sha = await commitStaged(...args);
      [edited] = gitShell.sh(fixture.worktree, 'ls-files').split('\n');
      writeFileSync(join(fixture.worktree, edited!), 'a human edit\n');
      return sha;
    },
  };
  const { outcome } = await interpreter.runExecution(fixture.options);

  assert.equal(outcome, 'needs-human');
  assert.deepEqual(
    fixture.harness.calls.map((call) => call.marker),
    [actionMarker(fixture, 'red', 'red')],
    'no green agent runs over unknown changes',
  );
  assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), `M ${edited}`, 'the human edit survives');
  assert.match(gitShell.sh(fixture.worktree, 'log', '-1', '--format=%s'), /^test: /, "red's commit stays");
  assert.deepEqual(intents(fixture.executionRecord, 'reset'), []);
  assert.equal(fixture.executionRecord.history.at(-1)?.kind, 'held');
  assert.deepEqual(fixture.executionRecord.visits, { red: 1, green: 1 });
  const reason = terminalReasonOf(fixture);
  assert.deepEqual(reason.decidedBy, { hold: 'dirty-worktree' });
  assert.match(reason.text, /uncommitted changes before green/);
});

// A gh call that changes GitHub: a comment, a label, a label definition or a pull request.
const ghWrite = (args: string[]) =>
  fakeGhModule.isCommentPost(args) ||
  (args[0] === 'issue' && args[1] === 'edit') ||
  (args[0] === 'label' && args[1] === 'create') ||
  (args[0] === 'pr' && ['create', 'edit', 'ready'].includes(args[1]));

test('a run stop during a repo-lock wait skips the queued effect and only needs-human reporting follows', async (t) => {
  const fixture = await golden.fixture(t, { integrity: 'real', git: 'real' });
  const runState: { stop: { failureClass: string; ticket: number } | null; remoteNotBefore: number } = {
    stop: null,
    remoteNotBefore: 0,
  };
  let before: number | undefined;
  let written: Record<string, number> | undefined;
  // Another Ticket stops the run while this one's push waits for the repo lock.
  const lock = contendRepoLock(fixture, async () => {
    runState.stop = { failureClass: 'auth', ticket: 21 };
    before = fixture.gh.calls.length;
    written = { ...counts };
  });
  const counts = onLockedGit(fixture, (verb, count) => {
    if (verb === 'commitStaged' && count === 2) lock.arm();
  });
  const result = await interpreter.runExecution({ ...fixture.options, runState });

  assert.equal(lock.state(), 'released', 'the push waited for the lock');
  assert.equal(result.outcome, 'needs-human', JSON.stringify(result));
  assert.equal(counts.push ?? 0, 0, 'nothing was pushed');
  assert.deepEqual(counts, written, 'no git write follows the stop');
  assert.equal(gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`), '');
  const final = await loadTicket(fixture);
  assert.equal(final.state, 'needs-human');
  assert.deepEqual(final.terminalReason!.rule, { table: 'fixed', row: 'run-stopped' });
  assert.equal(
    final.terminalReason!.text,
    'The harness call of Ticket #21 failed with class auth, which stops the whole run, so this ' +
      'Execution stopped before push.',
  );
  const writes = fixture.gh.calls.slice(before).filter((call) => ghWrite(call.args));
  assert.equal(writes.length, 2, JSON.stringify(writes.map((call) => call.args)));
  assert.ok(fakeGhModule.isCommentPost(writes[0].args, golden.TICKET), 'the needs-human comment');
  assert.ok(ticketComments(fixture).at(-1)!.body.startsWith('### gg: needs-human'));
  assert.ok(writes[1].args.join(' ').includes('--add-label gg:state:needs-human'), 'the needs-human label');
});

// A green call held for cleanup, on real git with the real integrity, whose survivor writes before the later Run looks.
async function heldGreen(t: TestContext) {
  const greenCall = keys.responseKey('green', 1, 'green', 1);
  const fixture = await golden.fixture(t, {
    integrity: 'real',
    git: 'real',
    responses: firstVisitWith({
      [greenCall]: {
        ...golden.firstVisitResponses[greenCall],
        cleanup: {
          confirmed: false,
          survivors: [{ pid: 4242, created: null, commandLine: 'node writer.js', error: 'still running' }],
          reason: 'termination refused',
          containment: { kind: 'group', pgid: 4242 },
        },
      },
    }),
  });
  return fixture;
}

test('a workflow file a survivor changed is an integrity violation on resume', async (t) => {
  const fixture = await heldGreen(t);
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  mkdirSync(join(fixture.worktree, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(fixture.worktree, '.github', 'workflows', 'ci.yml'), 'name: changed\n');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'needs-human');
  const saved = await loadTicket(fixture);
  assert.match(saved.terminalReason!.text, /broke an Integrity Assertion on protected/);
  assert.equal(existsSync(join(fixture.worktree, '.github', 'workflows', 'ci.yml')), false, 'rolled back');
});

test('an ignored Protected File a survivor changed is an integrity violation on resume', async (t) => {
  const fixture = await heldGreen(t);
  mkdirSync(join(fixture.worktree, '.claude'), { recursive: true });
  writeFileSync(join(fixture.worktree, '.claude', '.gitignore'), '*\n');
  const local = join(fixture.worktree, '.claude', 'settings.local.json');
  writeFileSync(local, '{"owner":true}\n');
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  writeFileSync(local, '{"survivor":true}\n');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'needs-human');
  const saved = await loadTicket(fixture);
  assert.match(saved.terminalReason!.text, /broke an Integrity Assertion on protected/);
  assert.equal(readFileSync(local, 'utf8'), '{"owner":true}\n', 'restored from the baseline');
});

test('a held call whose worktree is unchanged goes on over real git', async (t) => {
  const fixture = await heldGreen(t);
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  assert.equal((await laterRun(fixture)).outcome, 'ready-for-qa');
  assert.deepEqual([...fixture.gh.labels], ['gg:state:ready-for-qa']);
});

test('a commit made while a cleanup hold waits is kept, and holds the Ticket', async (t) => {
  const fixture = await heldGreen(t);
  assert.equal((await interpreter.runExecution(fixture.options)).outcome, 'pending');
  gitShell.sh(fixture.worktree, 'add', '-A');
  gitShell.sh(fixture.worktree, 'commit', '-q', '-m', 'a human or a survivor commits');
  const committed = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');

  const result = await laterRun(fixture);
  assert.equal(result.outcome, 'needs-human');
  assert.equal(result.held, true);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), committed, 'nothing was reset');
});
