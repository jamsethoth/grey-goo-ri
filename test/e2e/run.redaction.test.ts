// What gg publishes through GitHub and git never carries a local path, plain, URL-encoded or JSON-escaped.
import { type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as golden from '../support/golden.ts';
import * as gitShell from '../support/git-shell.ts';
import * as runFixture from '../support/run-fixture.ts';

type RunFixture = runFixture.RunFixture;

// A suite that is red until lib/add.mjs exists and then passes, each printing `trailer` after its output.
function suitePrints(fixture: RunFixture, trailer: string) {
  const exec = fixture.options.deps.exec;
  exec.runShell = (async (_command: string, options: { cwd: string }) =>
    existsSync(join(options.cwd, 'lib', 'add.mjs'))
      ? { code: 0, output: `${golden.GREEN_OUTPUT}\n${trailer}`, timedOut: false }
      : { code: 1, output: `${golden.RED_OUTPUT}\n${trailer}`, timedOut: false }) as unknown as typeof exec.runShell;
}
// The scripted response of a first-Visit call, whose summary a case sets.
const responseOf = (responses: typeof golden.firstVisitResponses, key: string) =>
  responses[key]?.response as { summary: string };

test('local paths in captured Check output and agent text do not reach PR bodies', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const fixture = runFixture.fixture(t, { git: 'real', responses });
  responseOf(responses, 'green/1/green/1').summary = `Updated ${fixture.worktree}/lib/add.mjs`;
  responseOf(responses, 'red/1/red/1').summary = `Tested ${fixture.worktree}/test/add.test.mjs`;
  suitePrints(fixture, `${fixture.worktree}/test/add.test.mjs`);
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0);
  const prBody = fixture.gh.pr()?.body as string;
  assert.ok(!prBody.includes(fixture.root), prBody);
  assert.ok(fixture.gh.comments.every((comment) => !comment.body.includes(fixture.root)));
  assert.ok(
    !gitShell.sh(join(fixture.root, 'origin.git'), 'log', '--format=%B', '--all').includes(fixture.root),
    'pushed commit messages contain no local root',
  );
  const executionRecord = record.load(fixture.commonDir, 'ticket', runFixture.TICKET) as record.ExecutionRecord;
  const commits = executionRecord.writeAheadLog.filter((entry) => entry.step === 'intent' && entry.effect === 'commit');
  assert.equal(commits.length, 2);
  assert.ok(
    commits.every((entry) => !(entry.payload as { message: string }).message.includes(fixture.root)),
    'commit replay payloads are redacted before the intent is saved',
  );
});

// A path as a file URL and as a JSON string.
const forms = (path: string) => `${pathToFileURL(path).href} ${JSON.stringify(path)}`;

// A fixture under a root whose name needs encoding, on a branch of its own, with the worktree's file URL in the
// Ticket's title.
function encodedFixture(t: TestContext, responses: typeof golden.firstVisitResponses) {
  const issue: Record<string, unknown> = {};
  const fixture = runFixture.fixture(t, {
    git: 'real',
    responses,
    issue,
    rootName: 'gg run é-',
    branch: 'ticket/15-add-two-numbers-local',
  });
  issue.title = `Add two numbers ${pathToFileURL(fixture.worktree).href}`;
  return fixture;
}

// No gh call, pushed commit or ref names the temp directory, plain or URL-encoded.
function assertNoLocalName(fixture: RunFixture) {
  const origin = join(fixture.root, 'origin.git');
  const gh = JSON.stringify(fixture.gh.calls.map(({ args, input }) => [args, input]));
  const commits = gitShell.sh(origin, 'log', '--format=%B', '--all');
  const refs = gitShell.sh(origin, 'for-each-ref', '--format=%(refname)');
  const name = basename(fixture.root);
  assert.ok(!gh.includes(name), `gh exposes ${name}: ${gh}`);
  assert.ok(!gh.includes(encodeURIComponent(name)), `gh exposes ${encodeURIComponent(name)}: ${gh}`);
  assert.ok(!commits.includes(name), `commits expose ${name}: ${commits}`);
  assert.ok(!commits.includes(encodeURIComponent(name)), `commits expose ${encodeURIComponent(name)}: ${commits}`);
  assert.ok(!refs.includes(name), `refs expose ${name}: ${refs}`);
  assert.ok(!refs.includes(encodeURIComponent(name)), `refs expose ${encodeURIComponent(name)}: ${refs}`);
}

test('encoded and JSON-escaped local paths reach no done publication', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const fixture = encodedFixture(t, responses);
  responseOf(responses, 'red/1/red/1').summary = `Tested ${forms(join(fixture.worktree, 'test', 'add.test.mjs'))}`;
  responseOf(responses, 'green/1/green/1').summary = `Updated ${forms(join(fixture.worktree, 'lib', 'add.mjs'))}`;
  suitePrints(fixture, forms(fixture.worktree));

  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0);
  assertNoLocalName(fixture);
  assert.ok(fixture.gh.pr(), 'a PR is published');
});

test('encoded and JSON-escaped local paths reach no fault publication', async (t) => {
  const responses = structuredClone(golden.firstVisitResponses);
  const fixture = encodedFixture(t, responses);
  responses['red/1/red/1'] = { throw: new Error(`Cannot read ${forms(fixture.commonDir)}`) };

  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  assertNoLocalName(fixture);
  assert.ok(fixture.comments().length > 0, 'the fault is reported');
});
