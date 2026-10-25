import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as marker from '../lib/marker.mjs';
import { canonical, pathKey } from '../lib/paths.mjs';
import * as record from '../lib/record.mjs';
import * as run from '../lib/run.mjs';
import * as golden from './support/golden.mjs';
import { fakeHarness } from './support/fake-harness.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, sh, fixture, seedExecution, markerOf, ticketResult, failComment,
  failHoldLabel,
} from './support/run.mjs';

test('a flow mixing harnesses runs each vertex on its own harness', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'reviewer/1/review/1': { files: {}, response: {
    claim: 'ok', summary: 'The review says ok.', dodMet: true, tddEvidenceOk: true, findings: [], diagnosis: '' } } };
  const f = fixture(t, { responses, fullFlow: true });
  const other = fakeHarness({ name: 'other', transcriptDir: join(f.root, 'transcripts-other'), responses, capabilities: { cost: false, reasoningTokens: false } });
  f.options.config.agents.reviewer.harness = 'other';
  f.options.harnesses.other = other;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  const vertexOf = (c) => c.marker.split(':')[2];
  assert.deepEqual(f.harness.calls.map(vertexOf), ['implementer', 'implementer'], 'the implementer runs on its own harness');
  assert.deepEqual(other.calls.map(vertexOf), ['reviewer'], 'the reviewer runs on its own harness');
});

test('an in-progress ticket with a recoverable record is resumed', async (t) => {
  const f = fixture(t, { git: 'real', labels: [IN_PROGRESS] });
  // The push of the green commit was intended but never made.
  const rec = await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
  assert.equal(rec.state, 'active');
  assert.deepEqual(record.openIntents(rec).map((e) => e.action), ['push'], 'the push is the open intent');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  assert.equal(f.harness.calls.length, 2, 'the resume continues at the cursor; no agent call is repeated');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.execution, rec.execution, 'the same Execution is resumed');
  assert.equal(final.state, 'done');
  assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split('\t')[0], sh(f.worktree, 'rev-parse', 'HEAD'));
  // The resume's Events belong to this Run; the markers keep the Run that wrote them, so no effect is redone.
  const evs = f.readEvents();
  const start = evs.findIndex((e) => e.type === 'run_start');
  const resumed = evs.slice(start).filter((e) => ['action', 'ticket_start', 'ticket_end'].includes(e.type));
  assert.ok(resumed.some((e) => e.type === 'action'), 'the resume records Action Events');
  assert.deepEqual([...new Set(resumed.map((e) => e.run))], [evs[start].run], 'every resumed Event carries the new Run id');
  assert.equal(f.gh.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length, 1, 'one PR is opened');
});

test('an in-progress ticket without a record is skipped', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await run.runTarget(f.options);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`)), `the skip is logged: ${JSON.stringify(f.logs)}`);
  assert.equal(f.worktrees(), 1, 'no worktree');
  assert.deepEqual(f.labelAdds(), [], 'no label written');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no repository label setup on a Stuck Ticket');
  assert.ok(f.gh.labels.has(IN_PROGRESS), 'the State Label is left for Stuck handling');
});

test('a finished record with open intents is not resumed', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
  rec.visits = { implementer: 1 };
  rec.cursor = { vertex: 'needs-human', visit: null, phase: null, ordinal: 0, attempt: 1 };
  // A fault report leaves the comment intent of the Terminal it interrupted open for good.
  const m = markerOf(rec, 'done', 1, 'done', 2);
  await record.intent(rec, m, 'comment', { target: { kind: 'issue', number: TICKET }, body: 'x', bodyHash: 'h' });
  for (const state of ['done', 'fault', 'abandoned']) {
    rec.state = state;
    await record.save(rec);
    const row = f.loadRow();
    assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.equal(f.loadRow(), row, 'the finished record is unchanged');
    assert.deepEqual(f.comments(), [], 'the open comment intent is not replayed');
    assert.ok(f.logs.some((l) => l.includes(`finished (${state})`)));
  }
  assert.ok(f.gh.calls.every((c) => c.args[0] === 'issue' && c.args[1] === 'view'));
});

test('a held Execution Record skip gives row-delete recovery without GitHub writes', async (t) => {
  const f = fixture(t);
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: 'seed', worktree: f.worktree, branch: BRANCH, base: 'main' });
  rec.state = 'held';
  await record.save(rec);
  const row = f.loadRow();
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  assert.equal(ticketResult(results).outcome, 'skipped');
  assert.ok(f.logs.some((line) => line.includes(`Execution Record ticket-${TICKET} is held and cannot resume.`)
    && line.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)
    && line.includes('Inspect the row first in the State Database at .git/gg/gg.db (relative to the main checkout) using a SQLite client.')));
  assert.ok(f.logs.every((line) => !line.includes('finished (held)')));
  assert.equal(f.loadRow(), row);
  assert.equal(f.harness.calls.length, 0);
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']]);
});

// A corrupt row stands for a Ticket whose worktree and in-progress label an earlier Run left behind.
async function corruptTicket(t) {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  f.options.cwd = f.worktree;
  record.openDb(f.commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)").run(TICKET, '{ "schemaVersion": 1, "log": [');
  return f;
}

test('a corrupt-record hold whose label failed is not posted twice', async (t) => {
  const f = await corruptTicket(t);
  const failing = failHoldLabel(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.equal(f.comments().length, 1);
  assert.equal(f.gh.labels.has(NEEDS_HUMAN), false);

  failing.on = false;
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the landed comment is found by its marker, not reposted');
  assert.ok(marker.parseMarker(f.comments()[0]), 'the corrupt-record comment carries an Action Marker');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS));
});

test('a corrupt-record hold whose comment failed is posted once on the next run', async (t) => {
  const f = await corruptTicket(t);
  const failing = failComment(f);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.deepEqual(f.comments(), []);
  assert.equal(f.gh.labels.has(NEEDS_HUMAN), false);

  failing.on = false;
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1);
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS));
  await run.runTarget(f.options);
  assert.equal(f.comments().length, 1, 'a labelled corrupt record is not commented again');
});

test('a corrupt record found at admission is held through reconcile', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  f.options.cwd = f.worktree;
  const corrupt = '{ "schemaVersion": 1, "log": [';
  record.openDb(f.commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)").run(TICKET, corrupt);

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes(`Execution Record ticket-${TICKET}`) && b.includes('SQLite client')),
    `a comment names the record: ${JSON.stringify(f.comments())}`);
  assert.ok(f.comments().some((b) => b.includes('Inspect the row first in the State Database at .git/gg/gg.db (relative to the main checkout) using a SQLite client.')));
  assert.ok(f.comments().some((b) => b.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)));
  assert.equal(pathKey((await f.options.git.repoInfo(f.worktree)).gitCommonDir), pathKey(f.commonDir));
  assert.ok(existsSync(join(f.mainRoot, '.git', 'gg', 'gg.db')));
  assert.ok(f.comments().every((b) => !b.includes(f.root)), 'no comment exposes a local path');
  // From the worktree git names the common dir canonically, so the log may carry either spelling.
  assert.ok(f.logs.some((l) => l.includes(f.commonDir) || l.includes(canonical(f.commonDir))), 'the local log keeps the full diagnostic');
  assert.equal(f.loadRow(), corrupt, 'the corrupt record is kept');
});

test('local paths in fault comments stay in the local Event only', async (t) => {
  const f = fixture(t);
  f.options.harnesses.fake.run = async () => { throw new Error(`Cannot read ${f.worktree}/secret.txt or ${f.commonDir}/gg/gg.db`); };
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  assert.ok(f.comments().length > 0);
  assert.ok(f.comments().every((b) => !b.includes(f.root)), JSON.stringify(f.comments()));
  assert.ok(f.readEvents().find((e) => e.type === 'ticket_end').error.includes(f.root));
});

// A long Check's stored Evidence is cut too, before its public excerpt is.
for (const kind of ['Check', 'long Check', 'fault']) {
  test(`truncated ${kind} output does not expose fragments of local paths`, async (t) => {
    const f = fixture(t);
    const directory = kind === 'fault' ? f.commonDir : f.worktree;
    const line = `    at Object.<anonymous> (${directory}\\lib\\add.mjs:3:9)`;
    const raw = (kind === 'long Check' ? 'y'.repeat(70_000) + '\n' : '') + line + '\n' + 'x'.repeat(3000 - line.length - 1 + line.indexOf(directory) + 1);
    if (kind === 'fault') f.options.harnesses.fake.run = async () => { throw new Error(raw); };
    else f.options.exec.runShell = async (_command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
      ? { code: 0, output: raw, timedOut: false } : { code: 1, output: golden.RED_OUTPUT, timedOut: false };
    assert.equal(run.runExitCode(await run.runTarget(f.options)), kind === 'fault' ? 1 : 0);
    const bodies = [...f.comments(), ...(f.gh.pr() ? [f.gh.pr().body] : [])];
    assert.ok(bodies.length);
    assert.ok(bodies.every((body) => !body.includes(basename(f.root))), `${kind}: a truncated path exposed the temp directory name`);
    const rec = await record.load(f.commonDir, 'ticket', TICKET);
    for (const entry of rec.log.filter((e) => e.step === 'intent' && ['comment', 'pr-upsert'].includes(e.action))) {
      assert.equal(entry.payload.bodyHash, createHash('sha256').update(entry.payload.body).digest('hex'));
      assert.ok(bodies.includes(entry.payload.body), 'the stored body is the body sent');
    }
  });
}

test('local paths in captured Check output and agent text do not reach PR bodies', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const f = fixture(t, { git: 'real', responses });
  responses['implementer/1/green/1'].response.summary = `Updated ${f.worktree}/lib/add.mjs`;
  responses['implementer/1/red/1'].response.summary = `Tested ${f.worktree}/test/add.test.mjs`;
  f.options.exec.runShell = async (_command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
    ? { code: 0, output: `${golden.GREEN_OUTPUT}\n${f.worktree}/test/add.test.mjs`, timedOut: false }
    : { code: 1, output: `${golden.RED_OUTPUT}\n${f.worktree}/test/add.test.mjs`, timedOut: false };
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
  assert.ok(!f.gh.pr().body.includes(f.root), f.gh.pr().body);
  assert.ok(f.gh.comments.every((c) => !c.body.includes(f.root)));
  assert.ok(!sh(join(f.root, 'origin.git'), 'log', '--format=%B', '--all').includes(f.root), 'pushed commit messages contain no local root');
  const rec = await record.load(f.commonDir, 'ticket', TICKET);
  const commits = rec.log.filter((e) => e.step === 'intent' && e.action === 'commit');
  assert.equal(commits.length, 2);
  assert.ok(commits.every((e) => !e.payload.message.includes(f.root)), 'commit replay payloads are redacted before the intent is saved');
});

for (const kind of ['done', 'fault']) {
  test(`encoded and JSON-escaped local paths reach no ${kind} publication`, async (t) => {
    const responses = structuredClone(golden.firstVisitResponses);
    const issue = {};
    const f = fixture(t, { git: 'real', responses, issue, rootName: 'gg run é-', branch: 'ticket/15-add-two-numbers-local' });
    const forms = (path) => `${pathToFileURL(path).href} ${JSON.stringify(path)}`;
    issue.title = `Add two numbers ${pathToFileURL(f.worktree).href}`;
    responses['implementer/1/red/1'].response.summary = `Tested ${forms(join(f.worktree, 'test', 'add.test.mjs'))}`;
    responses['implementer/1/green/1'].response.summary = `Updated ${forms(join(f.worktree, 'lib', 'add.mjs'))}`;
    if (kind === 'fault') f.options.harnesses.fake.run = async () => { throw new Error(`Cannot read ${forms(f.commonDir)}`); };
    else f.options.exec.runShell = async (_command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
      ? { code: 0, output: `${golden.GREEN_OUTPUT}\n${forms(f.worktree)}`, timedOut: false }
      : { code: 1, output: `${golden.RED_OUTPUT}\n${forms(f.worktree)}`, timedOut: false };
    const exit = run.runExitCode(await run.runTarget(f.options));
    const origin = join(f.root, 'origin.git');
    const published = {
      gh: JSON.stringify(f.gh.calls.map(({ args, input }) => [args, input])),
      commits: sh(origin, 'log', '--format=%B', '--all'),
      refs: sh(origin, 'for-each-ref', '--format=%(refname)'),
    };
    const name = basename(f.root);
    for (const [where, text] of Object.entries(published)) {
      for (const leak of [name, encodeURIComponent(name)]) assert.ok(!text.includes(leak), `${where} exposes ${leak}: ${text}`);
    }
    assert.ok(kind === 'fault' ? f.comments().length : f.gh.pr());
    assert.equal(exit, kind === 'fault' ? 1 : 0);
  });
}

test('Ticket branch names use the public title before slugifying', async (t) => {
  const issue = {};
  const branch = 'ticket/15-add-two-numbers-local';
  const f = fixture(t, { git: 'real', issue, branch });
  issue.title = `Add two numbers ${f.worktree}`;
  const results = await run.runTarget(f.options);
  assert.equal(sh(join(f.root, 'origin.git'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket/'), branch);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
});
