import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as marker from '../../lib/marker.mjs';
import { canonical, pathKey } from '../../lib/paths.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import * as golden from '../support/golden.mjs';
import { fakeHarness } from '../support/fake-harness.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, NEEDS_HUMAN, fixture, markerOf, ticketResult, failComment, failHoldLabel,
} from '../support/run.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test('a flow mixing harnesses runs each vertex on its own harness', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'reviewer/1/review/1': { files: {}, response: {
    claim: 'ok', summary: 'The review says ok.', dodMet: true, tddEvidenceOk: true, findings: [], diagnosis: '' } } };
  const f = fixture(t, { responses, fullFlow: true });
  const other = fakeHarness({ name: 'other', transcriptDir: join(f.root, 'transcripts-other'), responses, capabilities: { cost: false, reasoningTokens: false } });
  f.options.config.agents.reviewer.harness = 'other';
  f.options.harnesses.other = other;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  // parseMarker reads a marker from the text it is published in.
  const vertexOf = (c) => marker.parseMarker(marker.markerTrailer(c.marker)).vertex;
  assert.deepEqual(f.harness.calls.map(vertexOf), ['implementer', 'implementer'], 'the implementer runs on its own harness');
  assert.deepEqual(other.calls.map(vertexOf), ['reviewer'], 'the reviewer runs on its own harness');
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

// A fault report leaves the comment intent of the Terminal it interrupted open for good.
for (const state of ['done', 'fault', 'abandoned']) {
  test(`a finished record with open intents is not resumed: ${state}`, async (t) => {
    const f = fixture(t, { labels: [IN_PROGRESS] });
    await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
    const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
      configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
    rec.visits = { implementer: 1 };
    rec.cursor = { vertex: 'needs-human', visit: null, phase: null, ordinal: 0, attempt: 1 };
    await record.intent(rec, markerOf(rec, 'done', 1, 'done', 2), 'comment', { target: { kind: 'issue', number: TICKET }, body: 'x', bodyHash: 'h' });
    rec.state = state;
    await record.save(rec);
    const row = f.loadRow();

    assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.equal(f.loadRow(), row, 'the finished record is unchanged');
    assert.deepEqual(f.comments(), [], 'the open comment intent is not replayed');
    assert.ok(f.logs.some((l) => l.includes(`finished (${state})`)), JSON.stringify(f.logs));
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'gh made only the discovery read');
  });
}

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
    && line.includes('Inspect the row first in the State Database at .git/gg/gg.db (relative to the main checkout) using a SQLite client.')), JSON.stringify(f.logs));
  assert.ok(f.logs.every((line) => !line.includes('finished (held)')), JSON.stringify(f.logs));
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
  const responses = {};
  const f = fixture(t, { responses });
  responses['implementer/1/red/1'] = { throw: new Error(`Cannot read ${f.worktree}/secret.txt or ${f.commonDir}/gg/gg.db`) };
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  assert.ok(f.comments().length > 0);
  assert.ok(f.comments().every((b) => !b.includes(f.root)), JSON.stringify(f.comments()));
  assert.ok(f.readEvents().find((e) => e.type === 'ticket_end').error.includes(f.root));
});

// The stack line of `directory`, padded so a 3000-character excerpt cuts it inside the directory.
const truncatedAt = (directory) => {
  const line = `    at Object.<anonymous> (${directory}\\lib\\add.mjs:3:9)`;
  return line + '\n' + 'x'.repeat(3000 - line.length - 1 + line.indexOf(directory) + 1);
};

test('truncated Check output does not expose fragments of local paths', async (t) => {
  const f = fixture(t);
  const raw = truncatedAt(f.worktree);
  f.options.exec.runShell = async (_command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
    ? { code: 0, output: raw, timedOut: false } : { code: 1, output: golden.RED_OUTPUT, timedOut: false };
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
  const bodies = [...f.comments(), f.gh.pr().body];
  assert.deepEqual(bodies.filter((body) => body.includes(basename(f.root))), [], 'a truncated path exposed the temp directory name');
  const intents = (await record.load(f.commonDir, 'ticket', TICKET)).log.filter((e) => e.step === 'intent' && ['comment', 'pr-upsert'].includes(e.action));
  assert.deepEqual(intents.filter((e) => e.payload.bodyHash !== sha256(e.payload.body)), [], 'each stored hash is of its body');
  assert.deepEqual(intents.filter((e) => !bodies.includes(e.payload.body)), [], 'the stored body is the body sent');
});

// A long Check's stored Evidence is cut too, before its public excerpt is.
test('truncated long Check output does not expose fragments of local paths', async (t) => {
  const f = fixture(t);
  const raw = 'y'.repeat(70_000) + '\n' + truncatedAt(f.worktree);
  f.options.exec.runShell = async (_command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
    ? { code: 0, output: raw, timedOut: false } : { code: 1, output: golden.RED_OUTPUT, timedOut: false };
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
  const bodies = [...f.comments(), f.gh.pr().body];
  assert.deepEqual(bodies.filter((body) => body.includes(basename(f.root))), [], 'a truncated path exposed the temp directory name');
  const intents = (await record.load(f.commonDir, 'ticket', TICKET)).log.filter((e) => e.step === 'intent' && ['comment', 'pr-upsert'].includes(e.action));
  assert.deepEqual(intents.filter((e) => e.payload.bodyHash !== sha256(e.payload.body)), [], 'each stored hash is of its body');
  assert.deepEqual(intents.filter((e) => !bodies.includes(e.payload.body)), [], 'the stored body is the body sent');
});

test('truncated fault output does not expose fragments of local paths', async (t) => {
  const responses = {};
  const f = fixture(t, { responses });
  responses['implementer/1/red/1'] = { throw: new Error(truncatedAt(f.commonDir)) };
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const bodies = f.comments();
  assert.ok(bodies.length, 'the fault is reported');
  assert.equal(f.gh.pr(), null, 'no PR is published');
  assert.deepEqual(bodies.filter((body) => body.includes(basename(f.root))), [], 'a truncated path exposed the temp directory name');
  const intents = (await record.load(f.commonDir, 'ticket', TICKET)).log.filter((e) => e.step === 'intent' && ['comment', 'pr-upsert'].includes(e.action));
  assert.deepEqual(intents.filter((e) => e.payload.bodyHash !== sha256(e.payload.body)), [], 'each stored hash is of its body');
  assert.deepEqual(intents.filter((e) => !bodies.includes(e.payload.body)), [], 'the stored body is the body sent');
});
