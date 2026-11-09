// What gg publishes never carries a local path: not whole, and not cut inside one by a truncated excerpt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as golden from '../support/golden.ts';
import type * as fakeHarness from '../support/fake-harness.ts';
import * as runFixture from '../support/run-fixture.ts';

const { TICKET } = runFixture;
type RunFixture = runFixture.RunFixture;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('local paths in fault comments stay in the local Event only', async (t) => {
  const responses: fakeHarness.ScriptedResponses = {};
  const fixture = runFixture.fixture(t, { responses });
  responses['red/1/red/1'] = {
    throw: new Error(`Cannot read ${fixture.worktree}/secret.txt or ${fixture.commonDir}/gg/gg.db`),
  };
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1);
  assert.ok(fixture.comments().length > 0);
  assert.ok(
    fixture.comments().every((body) => !body.includes(fixture.root)),
    JSON.stringify(fixture.comments()),
  );
  assert.ok(
    (fixture.readEvents().find((event) => event.type === 'ticket_end')?.error as string).includes(fixture.root),
  );
});

// The stack line of `directory`, padded so a 3000-character excerpt cuts it inside the directory.
const truncatedAt = (directory: string) => {
  const line = `    at Object.<anonymous> (${directory}\\lib\\add.mjs:3:9)`;
  return line + '\n' + 'x'.repeat(3000 - line.length - 1 + line.indexOf(directory) + 1);
};

// A suite that is red until lib/add.mjs exists and then passes, printing `output`.
function greenPrints(fixture: RunFixture, output: string) {
  const exec = fixture.options.deps.exec;
  exec.runShell = (async (_command: string, options: { cwd: string }) =>
    existsSync(join(options.cwd, 'lib', 'add.mjs'))
      ? { code: 0, output, timedOut: false }
      : { code: 1, output: golden.RED_OUTPUT, timedOut: false }) as unknown as typeof exec.runShell;
}

// Every published body that names no part of the temp directory, and every saved comment and PR intent whose hash and
// body are what was published.
async function assertBodiesMatchIntents(fixture: RunFixture, bodies: string[]) {
  assert.deepEqual(
    bodies.filter((body) => body.includes(basename(fixture.root))),
    [],
    'a truncated path exposed the temp directory name',
  );
  const executionRecord = record.load(fixture.commonDir, 'ticket', TICKET) as record.ExecutionRecord;
  const intents = executionRecord.writeAheadLog.filter(
    (entry) => entry.step === 'intent' && ['comment', 'pr-upsert'].includes(entry.effect as string),
  );
  // A comment or PR intent's payload carries the body it sends and that body's hash.
  const payloadOf = (entry: (typeof intents)[number]) => entry.payload as { body: string; bodyHash: string };
  assert.deepEqual(
    intents.filter((entry) => payloadOf(entry).bodyHash !== sha256(payloadOf(entry).body)),
    [],
    'each stored hash is of its body',
  );
  assert.deepEqual(
    intents.filter((entry) => !bodies.includes(payloadOf(entry).body)),
    [],
    'the stored body is the body sent',
  );
}

// Every PR body gh was sent: publish re-renders the body green's pr-upsert created.
const publishedBodies = (fixture: RunFixture) => [
  ...fixture.comments(),
  ...fixture.gh.calls
    .filter((call) => call.args[0] === 'pr' && ['create', 'edit'].includes(call.args[1] as string))
    .map((call) => call.input as string),
];

test('truncated Check output does not expose fragments of local paths', async (t) => {
  const fixture = runFixture.fixture(t);
  greenPrints(fixture, truncatedAt(fixture.worktree));
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0);
  await assertBodiesMatchIntents(fixture, publishedBodies(fixture));
});

// A long Check's stored Evidence is cut too, before its public excerpt is.
test('truncated long Check output does not expose fragments of local paths', async (t) => {
  const fixture = runFixture.fixture(t);
  greenPrints(fixture, 'y'.repeat(70_000) + '\n' + truncatedAt(fixture.worktree));
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0);
  await assertBodiesMatchIntents(fixture, publishedBodies(fixture));
});

test('truncated fault output does not expose fragments of local paths', async (t) => {
  const responses: fakeHarness.ScriptedResponses = {};
  const fixture = runFixture.fixture(t, { responses });
  responses['red/1/red/1'] = { throw: new Error(truncatedAt(fixture.commonDir)) };
  assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 1);
  const bodies = fixture.comments();
  assert.ok(bodies.length, 'the fault is reported');
  assert.equal(fixture.gh.pr(), null, 'no PR is published');
  await assertBodiesMatchIntents(fixture, bodies);
});
