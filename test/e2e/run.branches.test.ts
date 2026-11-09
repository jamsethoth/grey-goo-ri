import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type * as events from '../../lib/events.ts';
import * as integrity from '../../lib/integrity.ts';
import * as paths from '../../lib/paths.ts';
import * as record from '../../lib/record.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as run from '../../lib/run.ts';
import * as golden from '../support/golden.ts';
import * as executionContext from '../support/execution-context.ts';
import * as failingGit from '../support/failing-git.ts';
import * as gitShell from '../support/git-shell.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

const { BRANCH, TICKET } = runFixture;
const { IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL } = executionContext;
type RunFixture = runFixture.RunFixture;

const ensureWorktree = (fixture: RunFixture, branch: string) =>
  fixture.options.deps.git.ensureWorktree({ mainRoot: fixture.mainRoot, path: fixture.worktree, branch, base: 'main' });
const snapshot = (fixture: RunFixture) => integrity.snapshot(fixture.worktree, fixture.options.deps.git);
const prTouched = (fixture: RunFixture) => fixture.gh.calls.some((call) => call.args[0] === 'pr');
const DELETE_ROW = `DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`;
const CANNOT_RESUME = `Execution Record ticket-${TICKET} is held and cannot resume.`;

// The hold of a resumed Execution found off its recorded branch says to switch back or delete the record's row.
function assertSwitchBackAdvice(fixture: RunFixture) {
  assert.ok(
    fixture
      .comments()
      .some(
        (body) =>
          body.includes(`${CANNOT_RESUME} Switch the worktree back to \`${BRANCH}\` or remove it.`) &&
          body.includes(DELETE_ROW),
      ),
    `the hold says how to recover: ${JSON.stringify(fixture.comments())}`,
  );
}

for (const branch of ['ticket/99-another-ticket', `ticket/${TICKET}-another-attempt`]) {
  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`a resumed execution on another Ticket branch or another branch of its Ticket is held before recovery: ${branch}`, async (t) => {
    const fixture = runFixture.fixture(t, { git: 'real', labels: [IN_PROGRESS_LABEL] });
    const seeded = await runFixture.crashBeforeCommit(fixture);
    gitShell.sh(fixture.worktree, 'checkout', '-q', '-b', branch);
    const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
    const before = await snapshot(fixture);
    const implementation = readFileSync(join(fixture.worktree, 'lib', 'add.mjs'), 'utf8');
    fixture.gh.calls.length = 0;

    const results = await run.runTarget(fixture.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
    assert.ok(!fixture.gh.labels.has(IN_PROGRESS_LABEL), 'in-progress is removed');
    assert.ok(
      fixture.comments().some((body) => body.includes(BRANCH) && body.includes(branch)),
      `the hold names both branches: ${JSON.stringify(fixture.comments())}`,
    );
    assertSwitchBackAdvice(fixture);
    assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
    assert.equal(gitShell.sh(fixture.worktree, 'branch', '--show-current'), branch);
    assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', branch), head, 'the other branch did not advance');
    assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', BRANCH), head, 'the recorded branch did not advance');
    assert.deepEqual(await snapshot(fixture), before, 'the index and worktree are untouched');
    assert.equal(
      readFileSync(join(fixture.worktree, 'lib', 'add.mjs'), 'utf8'),
      implementation,
      'the implementation is kept',
    );
    assert.equal(prTouched(fixture), false, 'no PR was read or published');
    const final = executionReads.loadTicket(fixture, TICKET);
    assert.equal(final.state, 'held');
    assert.equal(final.branch, BRANCH);
    assert.deepEqual(writeAhead.openIntents(final), writeAhead.openIntents(seeded), 'the intended commit is kept');
  });
}

// The hold names the branch found and the Ticket branch it needs, and says to switch back or remove the worktree.
function assertRequiredBranchAdvice(fixture: RunFixture, branch: string) {
  assert.ok(
    fixture.comments().some((body) => body.includes(branch) && body.includes(`ticket/${TICKET}-*`)),
    `the hold names the actual and required branches: ${JSON.stringify(fixture.comments())}`,
  );
  const advice =
    `Switch the worktree back to a \`ticket/${TICKET}-*\` branch or remove it, then remove the ${NEEDS_HUMAN_LABEL} ` +
    `label and re-run gg run ${TICKET}.`;
  assert.ok(
    fixture.comments().some((body) => body.includes(advice)),
    `the hold says how to recover: ${JSON.stringify(fixture.comments())}`,
  );
}

// ticket/150-* shares ticket 15's digits, so the prefix must end at the number.
const REFUSED = [
  { branch: 'ticket/99-other', checkout: ['-b', 'ticket/99-other'], current: 'ticket/99-other' },
  { branch: 'ticket/150-other', checkout: ['-b', 'ticket/150-other'], current: 'ticket/150-other' },
  { branch: 'detached HEAD', checkout: ['--detach'], current: '' },
];
for (const { branch, checkout, current } of REFUSED) {
  test(`fresh admission refuses another Ticket's branch without changing it: ${branch}`, async (t) => {
    const fixture = runFixture.fixture(t, { git: 'real' });
    await ensureWorktree(fixture, BRANCH);
    gitShell.sh(fixture.worktree, 'checkout', '-q', ...checkout);
    const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
    const before = await snapshot(fixture);

    const results = await run.runTarget(fixture.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
    assertRequiredBranchAdvice(fixture, branch);
    assert.ok(
      fixture.comments().every((body) => !body.includes('`detached HEAD`')),
      'a detached HEAD is not shown as a branch name',
    );
    const held = executionReads.loadTicket(fixture, TICKET);
    assert.equal(held?.state, 'held', 'the hold is recorded');
    assert.equal(held.branch, BRANCH, 'the record names the intended branch, never the one found');
    assert.equal(held.worktree, fixture.worktree);
    assert.equal(fixture.harness.calls.length, 0, 'no agent started');
    assert.equal(prTouched(fixture), false, 'no PR was read or published');
    assert.equal(gitShell.sh(fixture.worktree, 'branch', '--show-current'), current);
    assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.deepEqual(await snapshot(fixture), before, 'the index and files are untouched');
    assert.equal(
      gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${branch}`),
      '',
      'nothing was pushed',
    );
  });
}

test('fresh admission reuses its Ticket branch after a title change', async (t) => {
  const branch = `ticket/${TICKET}-old-title`;
  const fixture = runFixture.fixture(t, { git: 'real', branch, issue: { title: 'A new title' } });
  await ensureWorktree(fixture, branch);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(executionReads.loadTicket(fixture, TICKET).branch, branch);
  assert.equal(
    gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${branch}`).split('\t')[0],
    gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'),
  );
  assert.equal(
    gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/ticket/${TICKET}-a-new-title`),
    '',
    'no branch from the new title',
  );
});

// An Execution of this Ticket recorded on another Ticket's branch, with one outstanding intent.
async function foreignBranchRecord(fixture: RunFixture, branch: string) {
  const executionRecord = unvisitedExecution.unvisitedExecution(fixture, { branch });
  record.intent(executionRecord, 'seed-intent', 'commit', { message: 'red' });
  assert.equal(writeAhead.openIntents(executionRecord).length, 1);
  return executionRecord;
}

// The Run held the Execution on its foreign branch before any agent, PR or worktree change, keeping its intent.
async function assertForeignBranchHeld(fixture: RunFixture, branch: string, seeded: record.ExecutionRecord) {
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
  assert.ok(
    fixture.comments().some((body) => body.includes(branch) && body.includes(`ticket/${TICKET}-*`)),
    `the hold names the recorded and required branches: ${JSON.stringify(fixture.comments())}`,
  );
  assert.ok(
    fixture.comments().some((body) => body.includes(CANNOT_RESUME) && body.includes(DELETE_ROW)),
    `the hold says how to recover: ${JSON.stringify(fixture.comments())}`,
  );
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.equal(prTouched(fixture), false, 'no PR was read or published');
  const final = executionReads.loadTicket(fixture, TICKET);
  assert.equal(final.state, 'held');
  assert.equal(final.branch, branch);
  assert.deepEqual(writeAhead.openIntents(final), writeAhead.openIntents(seeded), 'the outstanding intent is kept');
}

test('resume refuses a recorded branch belonging to another Ticket: its worktree exists', async (t) => {
  const branch = 'ticket/99-other';
  const fixture = runFixture.fixture(t, { git: 'real', labels: [IN_PROGRESS_LABEL] });
  await ensureWorktree(fixture, branch);
  const seeded = await foreignBranchRecord(fixture, branch);
  const before = await snapshot(fixture);

  await assertForeignBranchHeld(fixture, branch, seeded);
  assert.equal(fixture.worktrees(), 2, 'no worktree was created or removed');
  assert.equal(existsSync(fixture.worktree), true, 'the worktree is kept');
  assert.equal(gitShell.sh(fixture.worktree, 'branch', '--show-current'), branch);
  assert.deepEqual(await snapshot(fixture), before, 'the index and files are untouched');
});

test('resume refuses a recorded branch belonging to another Ticket: its worktree is missing', async (t) => {
  const branch = 'ticket/99-other';
  const fixture = runFixture.fixture(t, { git: 'real', labels: [IN_PROGRESS_LABEL] });
  const seeded = await foreignBranchRecord(fixture, branch);

  await assertForeignBranchHeld(fixture, branch, seeded);
  assert.equal(fixture.worktrees(), 1, 'no worktree was created or removed');
  assert.equal(existsSync(fixture.worktree), false, 'a missing worktree is not recreated');
  assert.equal(gitShell.sh(fixture.mainRoot, 'branch', '--list', branch), '', 'the foreign branch was not created');
});

interface SiblingRow {
  name: string;
  seeded: boolean;
  siblingRecord: boolean;
  siblingBranch: string;
}

// A Ticket admitted, fresh or `seeded` with a record, beside a sibling worktree on `siblingBranch` (with a record of
// Ticket 99 if `siblingRecord`), whose red call writes into the sibling.
async function siblingOverwrite(t: TestContext, { seeded, siblingRecord, siblingBranch }: SiblingRow) {
  const responses = structuredClone(golden.firstVisitResponses);
  const labels = seeded ? [IN_PROGRESS_LABEL] : [];
  const fixture = runFixture.fixture(t, { responses, labels, integrity: 'real', git: 'real' });
  // Outside the configured worktree root, so only git's worktree list can find it.
  const sibling = join(fixture.root, 'elsewhere', 'ticket-99');
  gitShell.sh(fixture.mainRoot, 'worktree', 'add', '-q', '-b', siblingBranch, sibling, 'main');
  if (siblingRecord) {
    const options = { ticket: 99, worktree: sibling, branch: 'ticket/99-other' };
    record.save(unvisitedExecution.unvisitedExecution(fixture, options));
  }
  if (seeded) {
    await ensureWorktree(fixture, BRANCH);
    record.save(unvisitedExecution.unvisitedExecution(fixture));
  }
  const files = responses['red/1/red/1']?.files as Record<string, string>;
  files[relative(fixture.worktree, join(sibling, 'package.json'))] = '{ "overwritten": true }\n';
  return { fixture, sibling, results: await run.runTarget(fixture.options) };
}

// A second branch of this same Ticket is another worktree too, not the one being admitted.
const SIBLINGS: SiblingRow[] = [
  {
    name: 'a fresh Ticket beside an unrecorded sibling',
    seeded: false,
    siblingRecord: false,
    siblingBranch: 'ticket/99-other',
  },
  {
    name: 'a fresh Ticket beside a recorded sibling',
    seeded: false,
    siblingRecord: true,
    siblingBranch: 'ticket/99-other',
  },
  {
    name: 'a seeded Ticket beside an unrecorded sibling',
    seeded: true,
    siblingRecord: false,
    siblingBranch: 'ticket/99-other',
  },
  {
    name: 'a seeded Ticket beside a recorded sibling',
    seeded: true,
    siblingRecord: true,
    siblingBranch: 'ticket/99-other',
  },
  {
    name: 'a fresh Ticket beside another branch of its own',
    seeded: false,
    siblingRecord: false,
    siblingBranch: `ticket/${TICKET}-other-suffix`,
  },
];
for (const row of SIBLINGS) {
  test(`admission detects an agent overwrite of an idle sibling as an Integrity Violation: ${row.name}`, async (t) => {
    const { fixture, sibling, results } = await siblingOverwrite(t, row);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    const red = fixture
      .readEvents()
      .find(
        (event): event is events.AgentActionEvent =>
          event.type === 'action' && event.ticket === TICKET && event.action === 'red' && event.agent,
      );
    assert.equal(red?.outcome, 'integrity-violation');
    assert.deepEqual(red.rule, { table: 'fixed', row: 'integrity-violation' });
    const violations = red.integrityViolations as { worktree: string; surface: string }[];
    assert.ok(
      violations.some(
        (violation) => paths.pathKey(violation.worktree) === paths.pathKey(sibling) && violation.surface === 'tree',
      ),
      JSON.stringify(violations),
    );
    assert.equal(fixture.harness.calls.length, 1, 'no agent call after the violation');
    assert.equal(prTouched(fixture), false, 'no PR was read or published');
    assert.equal(
      gitShell.sh(fixture.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`),
      '',
      'nothing was pushed',
    );
    assert.equal(
      gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD'),
      fixture.base,
      'the own worktree is back at its baseline head',
    );
    assert.equal(gitShell.sh(fixture.worktree, 'status', '--porcelain'), '', 'the own worktree is restored');
  });
}

test('admission excludes non-ticket worktrees from sibling assertions', async (t) => {
  const fixture = runFixture.fixture(t, { integrity: 'real', git: 'real' });
  // git write-tree refuses an unmerged index, so a snapshot of this worktree would fault.
  const scratch = join(fixture.root, 'scratch');
  gitShell.sh(fixture.mainRoot, 'worktree', 'add', '-q', '-b', 'scratch', scratch, 'main');
  runFixture.conflict(scratch);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa');
});

// Windows paths are case-insensitive: the own worktree, listed in another case, would see its agent's writes as
// violations.
test(
  'admission excludes its own worktree, listed in another case, from sibling assertions',
  { skip: process.platform !== 'win32' && 'case-insensitive paths are Windows only' },
  async (t) => {
    const fixture = runFixture.fixture(t, { integrity: 'real', git: 'real' });
    const git = fixture.options.deps.git;
    fixture.options.deps.git = {
      ...git,
      listWorktrees: async (root) =>
        (await git.listWorktrees(root)).map((listed) => ({ ...listed, path: listed.path.toUpperCase() })),
    };

    const results = await run.runTarget(fixture.options);
    assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
    assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa');
  },
);

test('a resumed execution detached at the recorded SHA is held before recovery', async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real', labels: [IN_PROGRESS_LABEL] });
  const seeded = await runFixture.crashBeforeCommit(fixture);
  const head = gitShell.sh(fixture.worktree, 'rev-parse', 'HEAD');
  gitShell.sh(fixture.worktree, 'checkout', '-q', '--detach', head);
  const before = await snapshot(fixture);
  fixture.gh.calls.length = 0;

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL));
  assert.ok(
    fixture.comments().some((body) => body.includes('detached HEAD') && body.includes(BRANCH)),
    'the hold names the detached HEAD and recorded branch',
  );
  assertSwitchBackAdvice(fixture);
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'HEAD stays detached');
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', BRANCH), head, 'the recorded branch is untouched');
  assert.deepEqual(await snapshot(fixture), before, 'the index and files are untouched');
  assert.equal(prTouched(fixture), false, 'no PR was read or published');
  const final = executionReads.loadTicket(fixture, TICKET);
  assert.equal(final.state, 'held');
  assert.deepEqual(writeAhead.openIntents(final), writeAhead.openIntents(seeded));
});

test('a resumed execution stopped mid-rebase is held without changing the rebase', async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real', labels: [IN_PROGRESS_LABEL] });
  const seeded = await runFixture.seedExecution(fixture, {
    crashAt: (executionRecord) => ({
      marker: golden.markerOf(executionRecord, 'red', 1, 'commit', 0),
      point: 'after-completion',
    }),
  });
  const rebase = spawnSync('git', ['rebase', '--exec', 'exit 1', 'main'], { cwd: fixture.worktree, encoding: 'utf8' });
  assert.equal(rebase.status, 1, rebase.stderr);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  const rebasePath = gitShell.sh(fixture.worktree, 'rev-parse', '--git-path', 'rebase-merge');
  const todo = readFileSync(join(rebasePath, 'git-rebase-todo'), 'utf8');
  const before = await snapshot(fixture);
  const head = gitShell.sh(fixture.worktree, 'rev-parse', BRANCH);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(executionReads.loadTicket(fixture, TICKET).state, 'held');
  assert.equal(fixture.harness.calls.length, 1, 'no agent call beyond the seeded 1');
  assert.deepEqual(await snapshot(fixture), before);
  assert.equal(gitShell.sh(fixture.worktree, 'rev-parse', BRANCH), head);
  assert.equal(readFileSync(join(rebasePath, 'git-rebase-todo'), 'utf8'), todo, 'the rebase is untouched');
  assert.deepEqual(writeAhead.openIntents(executionReads.loadTicket(fixture, TICKET)), writeAhead.openIntents(seeded));
});

test('an unexpected branch query failure faults before recovery', async (t) => {
  const fixture = runFixture.fixture(t, { git: 'real', labels: [IN_PROGRESS_LABEL] });
  const seeded = await runFixture.crashBeforeCommit(fixture);
  const before = await snapshot(fixture);
  failingGit.failGitVerb(fixture, 'currentBranch', 'fatal: cannot read HEAD');

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
  assert.match(runFixture.ticketResult(results)?.error as string, /cannot read HEAD/);
  assert.equal(fixture.harness.calls.length, 2, 'no agent call beyond the seeded 2');
  assert.deepEqual(await snapshot(fixture), before, 'nothing was replayed or discarded');
  const final = executionReads.loadTicket(fixture, TICKET);
  assert.equal(final.state, 'fault');
  assert.deepEqual(
    writeAhead.openIntents(final).filter((entry) => entry.effect === 'commit'),
    writeAhead.openIntents(seeded),
  );
});
