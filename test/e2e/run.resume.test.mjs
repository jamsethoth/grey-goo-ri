import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import * as golden from '../support/golden.mjs';
import { TICKET, BRANCH, IN_PROGRESS, sh, fixture, seedExecution } from '../support/run.mjs';

test('an in-progress ticket with a recoverable record is resumed', async (t) => {
  const f = fixture(t, { git: 'real', labels: [IN_PROGRESS] });
  // The push of the green commit was intended but never made.
  const rec = await seedExecution(f, { crashAt: (r) => ({ marker: golden.markerOf(r, 'green', 1, 'push', 0), point: 'before-effect' }) });
  assert.equal(rec.state, 'active');
  assert.deepEqual(record.openIntents(rec).map((e) => e.action), ['push'], 'the push is the open intent');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  assert.equal(f.harness.calls.length, 2, 'the resume continues at the cursor; no agent call is repeated');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.execution, rec.execution, 'the same Execution is resumed');
  assert.equal(final.state, 'ready-for-qa');
  assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split('\t')[0], sh(f.worktree, 'rev-parse', 'HEAD'));
  // The resume's Events belong to this Run; the markers keep the Run that wrote them, so no effect is redone.
  const evs = f.readEvents();
  const start = evs.findIndex((e) => e.type === 'run_start');
  const resumed = evs.slice(start).filter((e) => ['action', 'ticket_start', 'ticket_end'].includes(e.type));
  assert.ok(resumed.some((e) => e.type === 'action'), 'the resume records Action Events');
  assert.deepEqual([...new Set(resumed.map((e) => e.run))], [evs[start].run], 'every resumed Event carries the new Run id');
  assert.equal(f.gh.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length, 1, 'one PR is opened');
});

test('local paths in captured Check output and agent text do not reach PR bodies', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const f = fixture(t, { git: 'real', responses });
  responses['green/1/green/1'].response.summary = `Updated ${f.worktree}/lib/add.mjs`;
  responses['red/1/red/1'].response.summary = `Tested ${f.worktree}/test/add.test.mjs`;
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

// A path as a file URL and as a JSON string.
const forms = (path) => `${pathToFileURL(path).href} ${JSON.stringify(path)}`;

test('encoded and JSON-escaped local paths reach no done publication', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const issue = {};
  const f = fixture(t, { git: 'real', responses, issue, rootName: 'gg run é-', branch: 'ticket/15-add-two-numbers-local' });
  issue.title = `Add two numbers ${pathToFileURL(f.worktree).href}`;
  responses['red/1/red/1'].response.summary = `Tested ${forms(join(f.worktree, 'test', 'add.test.mjs'))}`;
  responses['green/1/green/1'].response.summary = `Updated ${forms(join(f.worktree, 'lib', 'add.mjs'))}`;
  f.options.exec.runShell = async (_command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
    ? { code: 0, output: `${golden.GREEN_OUTPUT}\n${forms(f.worktree)}`, timedOut: false }
    : { code: 1, output: `${golden.RED_OUTPUT}\n${forms(f.worktree)}`, timedOut: false };

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
  const origin = join(f.root, 'origin.git');
  const gh = JSON.stringify(f.gh.calls.map(({ args, input }) => [args, input]));
  const commits = sh(origin, 'log', '--format=%B', '--all');
  const refs = sh(origin, 'for-each-ref', '--format=%(refname)');
  const name = basename(f.root);
  assert.ok(!gh.includes(name), `gh exposes ${name}: ${gh}`);
  assert.ok(!gh.includes(encodeURIComponent(name)), `gh exposes ${encodeURIComponent(name)}: ${gh}`);
  assert.ok(!commits.includes(name), `commits expose ${name}: ${commits}`);
  assert.ok(!commits.includes(encodeURIComponent(name)), `commits expose ${encodeURIComponent(name)}: ${commits}`);
  assert.ok(!refs.includes(name), `refs expose ${name}: ${refs}`);
  assert.ok(!refs.includes(encodeURIComponent(name)), `refs expose ${encodeURIComponent(name)}: ${refs}`);
  assert.ok(f.gh.pr(), 'a PR is published');
});

test('encoded and JSON-escaped local paths reach no fault publication', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const issue = {};
  const f = fixture(t, { git: 'real', responses, issue, rootName: 'gg run é-', branch: 'ticket/15-add-two-numbers-local' });
  issue.title = `Add two numbers ${pathToFileURL(f.worktree).href}`;
  responses['red/1/red/1'] = { throw: new Error(`Cannot read ${forms(f.commonDir)}`) };

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const origin = join(f.root, 'origin.git');
  const gh = JSON.stringify(f.gh.calls.map(({ args, input }) => [args, input]));
  const commits = sh(origin, 'log', '--format=%B', '--all');
  const refs = sh(origin, 'for-each-ref', '--format=%(refname)');
  const name = basename(f.root);
  assert.ok(!gh.includes(name), `gh exposes ${name}: ${gh}`);
  assert.ok(!gh.includes(encodeURIComponent(name)), `gh exposes ${encodeURIComponent(name)}: ${gh}`);
  assert.ok(!commits.includes(name), `commits expose ${name}: ${commits}`);
  assert.ok(!commits.includes(encodeURIComponent(name)), `commits expose ${encodeURIComponent(name)}: ${commits}`);
  assert.ok(!refs.includes(name), `refs expose ${name}: ${refs}`);
  assert.ok(!refs.includes(encodeURIComponent(name)), `refs expose ${encodeURIComponent(name)}: ${refs}`);
  assert.ok(f.comments().length > 0, 'the fault is reported');
});

test('Ticket branch names use the public title before slugifying', async (t) => {
  const issue = {};
  const branch = 'ticket/15-add-two-numbers-local';
  const f = fixture(t, { git: 'real', issue, branch });
  issue.title = `Add two numbers ${f.worktree}`;
  const results = await run.runTarget(f.options);
  assert.equal(sh(join(f.root, 'origin.git'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket/'), branch);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
});
