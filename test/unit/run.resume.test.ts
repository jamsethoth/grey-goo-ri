import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as locks from '../../lib/locks.ts';
import * as marker from '../../lib/marker.ts';
import * as paths from '../../lib/paths.ts';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as work from '../../lib/work.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as golden from '../support/golden.ts';
import * as fakeHarness from '../support/fake-harness.ts';
import * as executionContext from '../support/execution-context.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

const { BRANCH, TICKET } = runFixture;
const { IN_PROGRESS_LABEL, NEEDS_HUMAN_LABEL } = executionContext;
// Where the State Database is, which a held or corrupt record's advice names.
const INSPECT_ADVICE =
  'Inspect the row first in the State Database at .git/gg/gg.db (relative to the main checkout) using a SQLite client.';

test('a flow mixing harnesses runs each vertex on its own harness', async (t) => {
  const responses = {
    ...structuredClone(golden.firstVisitResponses),
    'reviewer/1/review/1': {
      files: {},
      response: {
        claim: 'ok',
        summary: 'The review says ok.',
        definitionOfDoneMet: true,
        redGreenEvidenceOk: true,
        findings: [],
        diagnosis: '',
      },
    },
  };
  const fixture = runFixture.fixture(t, { responses, fullFlow: true });
  const other = fakeHarness.fakeHarness({
    name: 'other',
    transcriptDir: join(fixture.root, 'transcripts-other'),
    responses,
    capabilities: { costReporting: false, reasoningTokenReporting: false },
  });
  fixture.options.config.repository.agents.reviewer.harness = 'other';
  fixture.options.harnesses.other = other;

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0);
  // parseMarker reads a marker from the text it is published in.
  const vertexOf = (call: { marker?: string }) =>
    marker.parseMarker(marker.markerTrailer(call.marker as string))?.vertex;
  assert.deepEqual(fixture.harness.calls.map(vertexOf), ['red', 'green'], 'the implementer runs on its own harness');
  assert.deepEqual(other.calls.map(vertexOf), ['reviewer'], 'the reviewer runs on its own harness');
});

test('an in-progress ticket without a record is skipped', async (t) => {
  const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL] });
  await run.runTarget(fixture.options);
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.ok(
    fixture.logs.some((line) => line.includes(`#${TICKET}`)),
    `the skip is logged: ${JSON.stringify(fixture.logs)}`,
  );
  assert.equal(fixture.worktrees(), 1, 'no worktree');
  assert.deepEqual(fixture.labelAdds(), [], 'no label written');
  assert.deepEqual(
    fixture.gh.calls.map((call) => call.args.slice(0, 2)),
    [
      ['repo', 'view'],
      ['issue', 'view'],
    ],
    'no repository label setup on a Stuck Ticket',
  );
  assert.ok(fixture.gh.labels.has(IN_PROGRESS_LABEL), 'the State Label is left for Stuck handling');
});

// A fault report leaves the comment intent of the Terminal it interrupted open for good.
for (const state of ['ready-for-qa', 'fault', 'abandoned'] as const) {
  test(`a finished record with open intents is not resumed: ${state}`, async (t) => {
    const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL] });
    const { mainRoot, worktree } = fixture;
    await fixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
    const executionRecord = unvisitedExecution.unvisitedExecution(fixture);
    executionRecord.visits = new Map([
      ['red', 1],
      ['green', 1],
    ]);
    executionRecord.cursor = { vertex: 'needs-human', visit: null, action: null, recovery: 0, attempt: 1 };
    const actionMarker = golden.markerOf(executionRecord, 'ready-for-qa', 1, 'end-comment', 0);
    record.intent(executionRecord, actionMarker, 'comment', {
      target: { kind: 'issue', number: TICKET },
      body: 'x',
      bodyHash: 'h',
    });
    executionRecord.state = state;
    record.save(executionRecord);
    const row = fixture.loadRow();

    assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0);
    assert.equal(fixture.harness.calls.length, 0, 'no agent started');
    assert.equal(fixture.loadRow(), row, 'the finished record is unchanged');
    assert.deepEqual(fixture.comments(), [], 'the open comment intent is not replayed');
    assert.ok(
      fixture.logs.some((line) => line.includes(`finished (${state})`)),
      JSON.stringify(fixture.logs),
    );
    assert.deepEqual(
      fixture.gh.calls.map((call) => call.args.slice(0, 2)),
      [
        ['repo', 'view'],
        ['issue', 'view'],
      ],
      'gh made only the discovery read',
    );
  });
}

test('a held Execution Record skip gives row-delete recovery without GitHub writes', async (t) => {
  const fixture = runFixture.fixture(t);
  const executionRecord = unvisitedExecution.unvisitedExecution(fixture, { run: 'seed' });
  executionRecord.state = 'held';
  record.save(executionRecord);
  const row = fixture.loadRow();
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'skipped');
  assert.ok(
    fixture.logs.some(
      (line) =>
        line.includes(`Execution Record ticket-${TICKET} is held and cannot resume.`) &&
        line.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`) &&
        line.includes(INSPECT_ADVICE),
    ),
    JSON.stringify(fixture.logs),
  );
  assert.ok(
    fixture.logs.every((line) => !line.includes('finished (held)')),
    JSON.stringify(fixture.logs),
  );
  assert.equal(fixture.loadRow(), row);
  assert.equal(fixture.harness.calls.length, 0);
  assert.deepEqual(
    fixture.gh.calls.map((call) => call.args.slice(0, 2)),
    [
      ['repo', 'view'],
      ['issue', 'view'],
    ],
  );
});

const CORRUPT = '{ "schemaVersion": 1, "log": [';

// A corrupt row stands for a Ticket whose worktree and in-progress label an earlier Run left behind.
async function corruptTicket(t: TestContext) {
  const fixture = runFixture.fixture(t, { labels: [IN_PROGRESS_LABEL] });
  const { mainRoot, worktree } = fixture;
  await fixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  fixture.options.cwd = fixture.worktree;
  stateDatabase
    .open(fixture.commonDir)
    .prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)")
    .run(TICKET, CORRUPT);
  return fixture;
}
const heldLabels = (fixture: runFixture.RunFixture) =>
  fixture.gh.labels.has(NEEDS_HUMAN_LABEL) && !fixture.gh.labels.has(IN_PROGRESS_LABEL);

test('a corrupt-record hold whose label failed is not posted twice', async (t) => {
  const fixture = await corruptTicket(t);
  const failing = runFixture.failHoldLabel(fixture);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  assert.equal(fixture.comments().length, 1);
  assert.equal(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), false);

  failing.on = false;
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2);
  assert.equal(fixture.comments().length, 1, 'the landed comment is found by its marker, not reposted');
  assert.ok(marker.parseMarker(fixture.comments()[0] as string), 'the corrupt-record comment carries an Action Marker');
  assert.ok(heldLabels(fixture));
});

test('a corrupt-record hold whose comment failed is posted once on the next run', async (t) => {
  const fixture = await corruptTicket(t);
  const failing = runFixture.failComment(fixture);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  assert.deepEqual(fixture.comments(), []);
  assert.equal(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), false);

  failing.on = false;
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2);
  assert.equal(fixture.comments().length, 1);
  assert.ok(heldLabels(fixture));
  await run.runTarget(fixture.options);
  assert.equal(fixture.comments().length, 1, 'a labelled corrupt record is not commented again');
});

test('a corrupt record found at admission is held through reconcile', async (t) => {
  const fixture = await corruptTicket(t);

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.ok(fixture.gh.labels.has(NEEDS_HUMAN_LABEL), 'the Ticket is at needs-human');
  assert.ok(
    fixture
      .comments()
      .some((body) => body.includes(`Execution Record ticket-${TICKET}`) && body.includes('SQLite client')),
    `a comment names the record: ${JSON.stringify(fixture.comments())}`,
  );
  assert.ok(fixture.comments().some((body) => body.includes(INSPECT_ADVICE)));
  assert.ok(
    fixture.comments().some((body) => body.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)),
  );
  assert.equal(
    paths.pathKey((await fixture.options.deps.git.repoInfo(fixture.worktree)).gitCommonDir),
    paths.pathKey(fixture.commonDir),
  );
  assert.ok(existsSync(join(fixture.mainRoot, '.git', 'gg', 'gg.db')));
  assert.ok(
    fixture.comments().every((body) => !body.includes(fixture.root)),
    'no comment exposes a local path',
  );
  // From the worktree git names the common dir canonically, so the log may carry either spelling.
  assert.ok(
    fixture.logs.some((line) => line.includes(fixture.commonDir) || line.includes(paths.canonical(fixture.commonDir))),
    'the local log keeps the full diagnostic',
  );
  assert.equal(fixture.loadRow(), CORRUPT, 'the corrupt record is kept');
});

// An Execution of the fixture Ticket that an earlier Run admitted under `flow`, before its first Visit, in a repository
// whose default is the full Flow and whose light Flow has no reviewer.
async function pinnedTo(t: TestContext, flow: string) {
  const fixture = runFixture.fixture(t, { fullFlow: true, labels: [IN_PROGRESS_LABEL] });
  fixture.options.config.repository.flows.light = runFixture.testConfig(fixture.root).flows.default!;
  const { mainRoot, worktree } = fixture;
  await fixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  const executionRecord = unvisitedExecution.unvisitedExecution(fixture);
  executionRecord.flow = flow;
  record.save(executionRecord);
  return fixture;
}

test('a resumed Execution keeps its pinned Flow', async (t) => {
  const fixture = await pinnedTo(t, 'light');
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  const vertexOf = (call: { marker?: string }) => marker.parseMarker(marker.markerTrailer(call.marker!))?.vertex;
  assert.deepEqual(fixture.harness.calls.map(vertexOf), ['red', 'green'], 'no reviewer, which only default has');
  const actionFlows = fixture.readEvents().flatMap((event) => (event.type === 'action' ? [event.flow] : []));
  assert.deepEqual([...new Set(actionFlows)], ['light']);
});

// A user Flow's record names it with its source (`user:light`), so a resume runs it from the user's directory, and
// one the user no longer declares is kept as a repository Flow's is (X2, ADR 0022). The user's directory copies the
// repository's Agents, Procedures and files, so only the source of the Flow differs.
async function pinnedToUserFlow(t: TestContext, { declared }: { declared: boolean }) {
  const fixture = await pinnedTo(t, 'user:light');
  const { repository, user } = fixture.options.config;
  const { agents, procedures, files } = structuredClone(repository);
  const flows = declared ? { light: runFixture.testConfig(fixture.root).flows.default! } : {};
  Object.assign(user, { flows, agents, procedures, files });
  return fixture;
}

test("a resumed Execution of a user Flow runs that Flow from the user's directory", async (t) => {
  const fixture = await pinnedToUserFlow(t, { declared: true });
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  const vertexOf = (call: { marker?: string }) => marker.parseMarker(marker.markerTrailer(call.marker!))?.vertex;
  assert.deepEqual(fixture.harness.calls.map(vertexOf), ['red', 'green'], "the user's light Flow has no reviewer");
  const actionFlows = fixture.readEvents().flatMap((event) => (event.type === 'action' ? [event.flow] : []));
  assert.deepEqual([...new Set(actionFlows)], ['user:light']);
  assert.equal((JSON.parse(fixture.loadRow()!) as { flow: string }).flow, 'user:light');
});

test('a resumed Execution whose user Flow is gone is skipped, and its record is kept', async (t) => {
  const fixture = await pinnedToUserFlow(t, { declared: false });
  const row = fixture.loadRow();
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(runFixture.ticketResult(results)?.outcome, 'skipped');
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.ok(
    fixture.logs.some((line) =>
      line.endsWith(
        `#${TICKET} ERROR its Execution Record runs Flow user:light, which is no longer declared; declare it again ` +
          `to resume it, or run gg work abandon ${TICKET} to start over`,
      ),
    ),
    JSON.stringify(fixture.logs),
  );
  assert.equal(fixture.loadRow(), row, 'the record is kept as it was');
});

// It waits, kept and resumable, for the Flow to be declared again, but loudly (A2): the Run exits 2 with an error that
// names both remedies, and nothing on GitHub changes.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a resumed Execution whose Flow is no longer declared is an error naming its remedies, and its record is kept', async (t) => {
  const fixture = await pinnedTo(t, 'gone');
  const row = fixture.loadRow();
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.ok(
    fixture.logs.some((line) =>
      line.endsWith(
        `#${TICKET} ERROR its Execution Record runs Flow gone, which is no longer declared; declare it again to ` +
          `resume it, or run gg work abandon ${TICKET} to start over`,
      ),
    ),
    JSON.stringify(fixture.logs),
  );
  assert.equal(fixture.loadRow(), row, 'the record is kept as it was');
  assert.deepEqual(
    fixture.gh.calls.map((call) => call.args.slice(0, 2)),
    [
      ['repo', 'view'],
      ['issue', 'view'],
    ],
    'gh made only the discovery read',
  );
});

// Request 3.5's abandon: keep the worktree, forget the position, so the Ticket starts over under another Flow.
test('after gg work abandon, gg run --flow starts a new Execution under that Flow on the same branch', async (t) => {
  const fixture = await pinnedTo(t, 'gone');
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2);
  const text = await work.abandon({
    ticket: TICKET,
    commonDir: fixture.commonDir,
    cwd: fixture.mainRoot,
    labelPrefix: 'gg',
    gh: fixture.options.deps.gh,
    locks,
  });
  assert.ok(text.includes(`deleted Execution Record ticket-${TICKET} `), text);
  assert.equal(fixture.loadRow(), undefined, 'the record is gone');

  const results = await run.runTarget({ ...fixture.options, flow: 'light' });
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  const executionRecord = JSON.parse(fixture.loadRow()!) as { flow: string; branch: string; worktree: string };
  assert.equal(executionRecord.flow, 'light');
  assert.equal(executionRecord.branch, BRANCH, 'the same branch');
  assert.equal(paths.pathKey(executionRecord.worktree), paths.pathKey(fixture.worktree), 'the same worktree');
  assert.equal(fixture.readEvents().filter((event) => event.type === 'run_start').length, 2, 'the Events are kept');
});

// The Config Hash a Run admitted under, as it wrote it to its directory.
const runConfigHash = (fixture: runFixture.RunFixture) =>
  readFileSync(join(fixture.commonDir, 'gg', 'runs', runFixture.lastRun(fixture)!, 'config-hash.txt'), 'utf8').trim();
// The Events the last Run wrote, and each of its Action Events as its Vertex and Config Hash.
const lastRunEvents = (fixture: runFixture.RunFixture) =>
  fixture.readEvents().filter((event) => 'run' in event && event.run === runFixture.lastRun(fixture));
const actionHashes = (fixture: runFixture.RunFixture) =>
  lastRunEvents(fixture).flatMap((event) => (event.type === 'action' ? [[event.vertex, event.configHash]] : []));
const configChanges = (fixture: runFixture.RunFixture) =>
  fixture.readEvents().filter((event) => event.type === 'config_change');
const snapshotHash = (fixture: runFixture.RunFixture) =>
  (JSON.parse(fixture.loadRow()!) as { configurationSnapshot: { configHash?: string } }).configurationSnapshot
    .configHash;

// An Execution an earlier Run left inside green, under the hash the fixture's configuration gives, as a control
// Run reports it, so only an edit between the Runs can move it. A Run of this Flow cannot be left resumable: its stops
// end at needs-human.
async function resumed(t: TestContext, { edited }: { edited: boolean }) {
  const control = runFixture.fixture(t);
  await run.runTarget(control.options);
  const fixture = runFixture.fixture(t);
  const seeded = await runFixture.crashBeforePush(fixture);
  assert.equal(seeded.cursor.vertex, 'green', 'the earlier Run stopped inside green');
  seeded.configHash = runConfigHash(control);
  (fixture.options.deps.database as record.StateDatabase).save(seeded);
  if (edited) fixture.options.config.repository.commands = { test: 'npm run test:changed' };
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  return { fixture, seeded };
}

// A Visit resumed mid-Visit finishes on the snapshot it entered with, and the new configuration takes effect at the
// next Vertex entry, logged as a change (request 3.5, #368): green keeps the earlier Run's hash, publish moves it.
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('a Declared Command changed between Runs moves the Config Hash at the next Vertex entry, logged as a change', async (t) => {
  const { fixture, seeded } = await resumed(t, { edited: true });
  const runHash = runConfigHash(fixture);
  assert.notEqual(runHash, seeded.configHash, 'the edit moved the hash');
  const hashes = actionHashes(fixture);
  assert.deepEqual(
    [...new Set(hashes.map(([vertex]) => vertex))],
    ['green', 'publish', 'ready-for-qa'],
    'the resumed Visit and the Vertices after it',
  );
  assert.deepEqual(
    hashes,
    hashes.map(([vertex]) => [vertex, vertex === 'green' ? seeded.configHash : runHash]),
    'each Action Event carries the hash its Visit entered under',
  );
  const { execution } = seeded;
  const expected = { run: runFixture.lastRun(fixture), execution, ticket: TICKET, vertex: 'publish', visit: 1 };
  assert.deepEqual(
    configChanges(fixture).map(({ run: runId, execution: id, ticket, vertex, visit, from, to }) => ({
      ...{ run: runId, execution: id, ticket, vertex, visit, from, to },
    })),
    [{ ...expected, from: seeded.configHash, to: runHash }],
  );
  const types = lastRunEvents(fixture).map((event) => (event.type === 'action' ? event.vertex : event.type));
  assert.equal(types.indexOf('config_change'), types.indexOf('publish') - 1, 'logged at publish entry, first');
  const logged = ` #${TICKET} config ${seeded.configHash.slice(0, 12)} -> ${runHash.slice(0, 12)} at publish`;
  assert.ok(
    fixture.logs.some((line) => line.endsWith(logged)),
    JSON.stringify(fixture.logs),
  );
  assert.equal(executionReads.loadTicket(fixture).configHash, runHash, 'the record names the hash it runs under');
  assert.equal(snapshotHash(fixture), runHash, 'the snapshot names the hash its Visit entered under');
});

test('an Execution resumed under an unchanged configuration logs no config_change and keeps its hash', async (t) => {
  const { fixture, seeded } = await resumed(t, { edited: false });
  assert.equal(runConfigHash(fixture), seeded.configHash);
  const hashes = actionHashes(fixture);
  assert.ok(
    hashes.some(([vertex]) => vertex === 'publish'),
    'a Vertex entered after the resumed one',
  );
  assert.deepEqual(
    hashes,
    hashes.map(([vertex]) => [vertex, seeded.configHash]),
  );
  assert.deepEqual(configChanges(fixture), []);
  assert.ok(!fixture.logs.some((line) => line.includes(` #${TICKET} config `)), JSON.stringify(fixture.logs));
  assert.equal(executionReads.loadTicket(fixture).configHash, seeded.configHash);
  assert.equal(snapshotHash(fixture), seeded.configHash);
});

test('an Execution admitted by this Run logs no config_change, and every Action Event carries its hash', async (t) => {
  const fixture = runFixture.fixture(t);
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  const runHash = runConfigHash(fixture);
  const hashes = actionHashes(fixture);
  assert.ok(hashes.length > 0);
  assert.deepEqual(
    hashes,
    hashes.map(([vertex]) => [vertex, runHash]),
  );
  assert.deepEqual(configChanges(fixture), []);
  assert.equal(executionReads.loadTicket(fixture).configHash, runHash);
  assert.equal(snapshotHash(fixture), runHash);
});

// A report decided by an earlier Run enters no Vertex, so nothing runs under the new configuration (#368, Q1 A).
test('a hold finished by a later Run under a changed configuration keeps its Config Hash', async (t) => {
  const { runFixture: fixture } = await runFixture.dirtyTicket(t, false);
  const failing = runFixture.failComment(fixture);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  const decided = executionReads.loadTicket(fixture);
  assert.equal(decided.terminalStop?.held, true, 'the hold is decided, its comment pending');
  fixture.options.config.repository.commands = { test: 'npm run test:changed' };
  failing.on = false;

  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 2);
  assert.notEqual(runConfigHash(fixture), decided.configHash, 'the later Run admitted under another hash');
  const hashes = actionHashes(fixture);
  assert.ok(hashes.length > 0, 'the later Run landed the hold');
  assert.deepEqual(
    hashes,
    hashes.map(([vertex]) => [vertex, decided.configHash]),
  );
  assert.deepEqual(configChanges(fixture), []);
  assert.equal(executionReads.loadTicket(fixture).configHash, decided.configHash);
});
