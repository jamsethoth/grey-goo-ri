import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as github from '../../lib/github.ts';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as epicRun from '../support/epic-run.ts';
import * as executionContext from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';
import * as failingGit from '../support/failing-git.ts';
import * as fakeGh from '../support/fake-gh.ts';
import * as runFixture from '../support/run-fixture.ts';
import * as caseDatabase from '../support/case-database.ts';
import * as unvisitedExecution from '../support/unvisited-execution.ts';

const { TICKET } = runFixture;
const isLabelRead = (args: string[]) => args[0] === 'api' && (args.at(-1) as string).includes('/labels');

const LABEL_SETUPS = [
  {
    repoLabels: [],
    created: ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa'],
  },
  {
    repoLabels: ['gg:state:in-progress'],
    created: ['gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa'],
  },
  {
    repoLabels: ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa'],
    created: [],
  },
];
for (const { repoLabels, created } of LABEL_SETUPS) {
  // eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
  test(`a Run ensures missing State Labels once immediately before its first label edit: ${repoLabels.length} of 4 present`, async (t) => {
    const fixture = runFixture.fixture(t, { repoLabels });
    assert.equal(run.runExitCode(await run.runTarget(fixture.options)), 0);
    const reads = fixture.gh.calls.filter((call) => isLabelRead(call.args));
    assert.equal(reads.length, 1, 'one repository label read per Run');
    const creates = fixture.gh.calls.filter((call) => call.args[0] === 'label');
    assert.deepEqual(creates.map((call) => call.args[2]).sort(), created);
    assert.deepEqual(
      creates.filter((call) => call.args.includes('--force')),
      [],
      'no create forces',
    );
    const firstEdit = fixture.gh.calls.findIndex((call) => call.args[0] === 'issue' && call.args[1] === 'edit');
    assert.deepEqual(
      fixture.gh.calls.slice(firstEdit - 1 - created.length, firstEdit),
      [reads[0], ...creates],
      'the label read and its creates immediately precede the first label edit',
    );
  });
}

test('a State Label creation failure uses the label-failure log, Event and exit code', async (t) => {
  const fixture = runFixture.fixture(t, { repoLabels: [], failCreate: true });
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 1);
  assert.equal(runFixture.ticketResult(results)?.labelFailed, true);
  assert.ok(
    fixture.logs.some((line) => line.includes('label creation denied')),
    JSON.stringify(fixture.logs),
  );
  assert.ok(
    fixture
      .readEvents()
      .some(
        (event) =>
          event.type === 'label_failed' && event.ticket === TICKET && event.error.includes('label creation denied'),
      ),
  );
  // Each failed create is confirmed by one more read before the setup fails, and the next label write repeats both.
  assert.equal(
    fixture.gh.calls.filter((call) => isLabelRead(call.args)).length,
    4,
    'a failed setup is retried at the next label write',
  );
});

test('a State Label write that fails inside the Execution fails the Run', async (t) => {
  const fixture = runFixture.fixture(t);
  // Admission's in-progress label lands; only the Terminal's ready-for-qa label write fails.
  const transport = fakeGh.ghThrough(fixture.gh, async (call, next) => {
    const [noun, verb] = call.args;
    if (noun !== 'issue' || verb !== 'edit' || !call.args.includes('gg:state:ready-for-qa')) return next();
    fixture.gh.calls.push(call);
    throw new Error('label edit denied');
  });
  fixture.options.deps.gh = github.createGh(transport);
  const results = await run.runTarget(fixture.options);
  assert.equal(runFixture.ticketResult(results)?.outcome, 'ready-for-qa', JSON.stringify(results));
  assert.equal(runFixture.ticketResult(results)?.labelFailed, true);
  assert.equal(run.runExitCode(results), 1);
});

// The fixture's gh with its first repository label read answered by `first`.
function firstLabelRead(fixture: runFixture.RunFixture, first: () => string) {
  const reads = { count: 0 };
  const transport = fakeGh.ghThrough(fixture.gh, async (call, next) => {
    if (!isLabelRead(call.args) || ++reads.count !== 1) return next();
    fixture.gh.calls.push(call);
    return first();
  });
  fixture.options.deps.gh = github.createGh(transport);
  return reads;
}
const labelFailures = (fixture: runFixture.RunFixture) =>
  fixture.readEvents().filter((event) => event.type === 'label_failed');

test('a concurrent State Label create does not fail the Run', async (t) => {
  const fixture = runFixture.fixture(t);
  // Another Run creates every State Label between this Run's label read and its creates.
  firstLabelRead(fixture, () => JSON.stringify([[]]));
  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(labelFailures(fixture).length, 0);
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'));
});

test('a transient State Label setup failure is retried by the later label write', async (t) => {
  const fixture = runFixture.fixture(t);
  const reads = firstLabelRead(fixture, () => {
    throw new Error('HTTP 502: temporary label read failure');
  });
  const results = await run.runTarget(fixture.options);
  assert.equal(reads.count, 2, 'the terminal label write retries setup');
  assert.equal(run.runExitCode(results), 1, 'the first failure is still reported');
  assert.equal(labelFailures(fixture).length, 1);
  assert.ok(fixture.gh.labels.has('gg:state:ready-for-qa'), 'the later label write succeeds');
});

const NOT_READY: [Record<string, unknown>, string][] = [
  [{ state: 'CLOSED' }, 'closed'],
  [
    {
      blockedBy: [
        { number: 3, state: 'OPEN' },
        { number: 5, state: 'OPEN' },
      ],
    },
    'blocked by #3, #5',
  ],
  [{ labels: [{ name: 'gg:state:ready-for-qa' }] }, 'carries State Label gg:state:ready-for-qa'],
];
for (const [issue, reason] of NOT_READY) {
  test(`not-ready skips name the reason and make only the discovery read: ${reason}`, async (t) => {
    const fixture = runFixture.fixture(t, { issue });
    assert.equal(runFixture.ticketResult(await run.runTarget(fixture.options))?.outcome, 'skipped');
    assert.ok(
      fixture.logs.includes(`[main] #${TICKET} skipped: it is not ready: ${reason}`),
      JSON.stringify(fixture.logs),
    );
    assert.deepEqual(
      fixture.gh.calls.map((call) => call.args.slice(0, 2)),
      [['issue', 'view']],
    );
  });
}

test('every line a Run prints names its repository, in the terminal and in run.log', async (t) => {
  // A fault whose report gets HTTP 502 and whose label edit fails logs from run, the interpreter and github.
  const fixture = runFixture.fixture(t, { labels: [executionContext.IN_PROGRESS_LABEL], failEdit: true });
  await record.save(unvisitedExecution.unvisitedExecution(fixture));
  failingGit.failGitVerb(fixture, 'ensureWorktree', 'worktree add failed');
  runFixture.failComment(fixture);

  await run.runTarget(fixture.options);
  const prefix = `[${basename(fixture.mainRoot)}] `;
  const logged = (start: string) => fixture.logs.some((line) => line.startsWith(`${prefix}${start}`));
  assert.ok(logged(`#${TICKET} ERROR worktree add failed`), `the admission error: ${JSON.stringify(fixture.logs)}`);
  assert.ok(logged(`#${TICKET} fault report failed:`), `the report failure: ${JSON.stringify(fixture.logs)}`);
  assert.ok(logged(`#${TICKET} ERROR label update`), `the label failure: ${JSON.stringify(fixture.logs)}`);
  assert.ok(
    fixture.logs.some((line) => line.startsWith(prefix) && /failure, retry 1 of/.test(line)),
    `the retry line: ${JSON.stringify(fixture.logs)}`,
  );
  assert.deepEqual(
    fixture.logs.filter((line) => !line.startsWith(prefix)),
    [],
    'every line names the repository',
  );
  const runLog = readFileSync(
    join(fixture.commonDir, 'gg', 'runs', runFixture.lastRun(fixture) as string, 'run.log'),
    'utf8',
  );
  assert.equal(
    runLog.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /gm, ''),
    fixture.logs.map((line) => `${line}\n`).join(''),
    'run.log holds every line, after its timestamp',
  );
});

test('every error a Run throws names its repository', async (t) => {
  const preflight = runFixture.fixture(t);
  preflight.options.config.agents.implementer.harness = 'nope';
  await assert.rejects(run.runTarget(preflight.options), (err: Error) => {
    assert.ok(err?.message.startsWith('[main] preflight failed:'), err?.message);
    return true;
  });

  const view = runFixture.fixture(t);
  view.options.deps.gh = github.createGh(async (args) => {
    throw new Error(`gh ${args.join(' ')} exited 1\nHTTP 404: Not Found`);
  });
  await assert.rejects(run.runTarget(view.options), (err: Error) => {
    assert.ok(err?.message.startsWith(`[main] gh issue view ${TICKET} `), err?.message);
    return true;
  });

  const epic = runFixture.fixture(t, { issues: epicRun.epicOf([21], { 21: { state: 'CLOSED' } }) });
  epic.options.target = epicRun.EPIC;
  await assert.rejects(run.runTarget(epic.options), (err: Error) => {
    assert.ok(err?.message.startsWith(`[main] #${epicRun.EPIC}: nothing ready`), err?.message);
    return true;
  });
});

// A preflight failure: the error gg run rejects with, its message and exit code.
type PreflightError = Error & { exitCode?: number };

test('preflight names every failing vertex in one error, before any gh call, worktree or run directory', async (t) => {
  const fixture = runFixture.fixture(t, { fullFlow: true });
  fixture.options.config.agents.implementer.harness = 'nope';
  fixture.options.config.agents.reviewer.harness = 'claude';
  fixture.options.harnesses.claude = await import('../../lib/harnesses/claude.ts');
  await assert.rejects(run.runTarget(fixture.options), (err: PreflightError) => {
    assert.match(
      err.message,
      /implementer[^]*nope|nope[^]*implementer/,
      'the unknown harness is named with its vertex',
    );
    assert.match(err.message, /reviewer/);
    assert.equal(
      err.message.split('\n').find((line) => line.startsWith('vertex reviewer')),
      'vertex reviewer: harness claude: not implemented',
    );
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.worktrees(), 1, 'no worktree');
  assert.equal(existsSync(join(fixture.root, 'wt')), false, 'no worktree root');
  assert.equal(existsSync(join(fixture.commonDir, 'gg', 'runs')), false, 'no run directory');
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
});

test('preflight rejects a repository Layer without testPaths', async (t) => {
  const fixture = runFixture.fixture(t);
  delete fixture.options.config.testPaths;
  const file = config.layerPath(fixture.mainRoot);
  await assert.rejects(run.runTarget(fixture.options), (err: PreflightError) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      `${file} declares no testPaths; merge {"testPaths":["<glob>"]} into it`,
    ]);
    assert.equal(err.exitCode, 1);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.worktrees(), 1, 'no worktree');
});

// The advice a preflight that found an Agent with no harness ends with.
const examples = fileURLToPath(new URL('../../examples/', import.meta.url));
const MERGE_ADVICE =
  `Merge one of ${join(examples, 'claude.json')}, ${join(examples, 'codex.json')} into the user Layer at ` +
  `${config.layerPath(homedir())}.`;

test('preflight lists every unset Vertex and Agent before one merge advice line', async (t) => {
  const fixture = runFixture.fixture(t, { fullFlow: true });
  fixture.options.config.agents.implementer.harness = null;
  fixture.options.config.agents.reviewer.harness = null;
  await assert.rejects(run.runTarget(fixture.options), (err: PreflightError) => {
    assert.equal(err.exitCode, 2);
    assert.deepEqual(err.message.split('\n'), [
      '[main] preflight failed:',
      'error: agents.implementer: agent implementer names no harness; set one in a user or repository Layer',
      'error: agents.reviewer: agent reviewer names no harness; set one in a user or repository Layer',
      MERGE_ADVICE,
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.harness.calls.length, 0, 'no agent started');
  assert.equal(fixture.worktrees(), 1, 'no worktree');
});

test('preflight names an unset harness and an unknown harness in one error', async (t) => {
  const fixture = runFixture.fixture(t, { fullFlow: true });
  fixture.options.config.agents.implementer.harness = null;
  fixture.options.config.agents.reviewer.harness = 'nope';
  await assert.rejects(run.runTarget(fixture.options), (err: PreflightError) => {
    assert.match(err.message, /agent implementer names no harness/);
    assert.match(
      err.message,
      /agent reviewer names harness "nope", which is not registered/,
      'the unknown harness is named with its Agent',
    );
    assert.equal(err.exitCode, 2, 'an unset harness exits 2');
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
});

// #116: admission runs the validator gg doctor runs, before any GitHub access.
test('gg run rejects a Flow gg doctor rejects, with the same message', async (t) => {
  const fixture = runFixture.fixture(t);
  fixture.options.config.procedures.implement.actions[1].command = 'lint';
  const line =
    'error: procedures.implement.actions[1]: Check test names command "lint", ' +
    'which the repository Layer does not declare';
  const { text } = doctor.doctor({ config: fixture.options.config, harnesses: fixture.options.harnesses });
  assert.ok(text.includes(`\n${line}\n`), text);
  await assert.rejects(run.runTarget(fixture.options), (err: PreflightError) => {
    assert.deepEqual(err?.message.split('\n'), ['[main] preflight failed:', line]);
    assert.equal(err.exitCode, 1);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
});

// The fixture Flow's green Vertex, whose inputs a case adds to.
const greenInputs = (fixture: runFixture.RunFixture) =>
  fixture.options.config.flows.default.ticket.vertices.green.inputs as Record<string, unknown>;

test('gg run rejects a required input that a route may not produce', async (t) => {
  const fixture = runFixture.fixture(t);
  greenInputs(fixture).previous = { from: 'green.commit.files' };
  await assert.rejects(run.runTarget(fixture.options), (err: Error) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: flows.default.ticket.vertices.green.inputs.previous: input previous is required, but some route to ' +
        'green may not produce any of its sources; admission checks routes, not runs, so if every run does produce ' +
        'one, mark the input optional',
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.harness.calls.length, 0, 'no Visit');
});

test('gg run rejects pick over a value that is not a list of objects', async (t) => {
  const fixture = runFixture.fixture(t);
  greenInputs(fixture).names = { from: 'red.commit.files', pick: 'name' };
  await assert.rejects(run.runTarget(fixture.options), (err: Error) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: flows.default.ticket.vertices.green.inputs.names: pick needs a list of objects; "red.commit.files" is ' +
        '{"kind":"list","of":{"kind":"string"}}',
    ]);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
  assert.equal(fixture.harness.calls.length, 0, 'no Visit');
});

test('an Agent naming no harness still exits 2 naming the example Layers', async (t) => {
  const fixture = runFixture.fixture(t);
  fixture.options.config.agents.implementer.harness = null;
  await assert.rejects(run.runTarget(fixture.options), (err: PreflightError) => {
    assert.deepEqual(err?.message.split('\n'), [
      '[main] preflight failed:',
      'error: agents.implementer: agent implementer names no harness; set one in a user or repository Layer',
      MERGE_ADVICE,
    ]);
    assert.equal(err.exitCode, 2);
    return true;
  });
  assert.deepEqual(fixture.gh.calls, [], 'no gh call');
});

test('an admission hold saves an admission stop that declares every field', async (t) => {
  const fixture = runFixture.fixture(t);
  await record.save(unvisitedExecution.unvisitedExecution(fixture, { run: 'seed', branch: 'ticket/99-other' }));
  const saved: record.ExecutionRecord[] = [];
  caseDatabase.onSave(t, (next) => saved.push(structuredClone(next as record.ExecutionRecord)));

  const results = await run.runTarget(fixture.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  const admissionStop = saved.find((next) => next.admissionStop)?.admissionStop;
  assert.ok(admissionStop, 'admission saved the hold it decided');
  const expected = {
    kind: 'hold',
    name: 'branch-mismatch',
    terminalReasonText: admissionStop.terminalReasonText,
    fresh: false,
    advice: admissionStop.advice,
    detail: null,
    inProgress: false,
    error: null,
  };
  assert.deepEqual(admissionStop, expected);
  assert.deepEqual(Object.keys(admissionStop), Object.keys(expected));
  assert.equal(typeof admissionStop.terminalReasonText, 'string');
  assert.equal(typeof admissionStop.advice, 'string');
  assert.equal((await executionReads.loadTicket(fixture)).admissionStop, null, 'its Terminal retires it');
});
