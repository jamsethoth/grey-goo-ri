import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.mjs';
import * as github from '../../lib/github.mjs';
import * as record from '../../lib/record.mjs';
import * as run from '../../lib/run.mjs';
import {
  TICKET, BRANCH, IN_PROGRESS, fixture, ticketResult, failComment, lastRun, EPIC, epicOf,
} from '../support/run.mjs';

const LABEL_SETUPS = [
  { repoLabels: [], created: ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa'] },
  { repoLabels: ['gg:state:in-progress'], created: ['gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa'] },
  { repoLabels: ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa'], created: [] },
];
for (const { repoLabels, created } of LABEL_SETUPS) {
  test(`a Run ensures missing State Labels once immediately before its first label edit: ${repoLabels.length} of 4 present`, async (t) => {
    const f = fixture(t, { repoLabels });
    assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
    const reads = f.gh.calls.filter((c) => c.args[0] === 'api' && c.args.at(-1).includes('/labels'));
    assert.equal(reads.length, 1, 'one repository label read per Run');
    const creates = f.gh.calls.filter((c) => c.args[0] === 'label');
    assert.deepEqual(creates.map((c) => c.args[2]).sort(), created);
    assert.deepEqual(creates.filter((c) => c.args.includes('--force')), [], 'no create forces');
    const firstEdit = f.gh.calls.findIndex((c) => c.args[0] === 'issue' && c.args[1] === 'edit');
    assert.deepEqual(f.gh.calls.slice(firstEdit - 1 - created.length, firstEdit), [reads[0], ...creates],
      'the label read and its creates immediately precede the first label edit');
  });
}

test('a State Label creation failure uses the label-failure log, Event and exit code', async (t) => {
  const f = fixture(t, { repoLabels: [], failCreate: true });
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  assert.equal(ticketResult(results).labelFailed, true);
  assert.ok(f.logs.some((l) => l.includes('label creation denied')), JSON.stringify(f.logs));
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET && e.error.includes('label creation denied')));
  // Each failed create is confirmed by one more read before the setup fails, and the next label write repeats both.
  assert.equal(f.gh.calls.filter((c) => c.args[0] === 'api' && c.args.at(-1).includes('/labels')).length, 4, 'a failed setup is retried at the next label write');
});

test('a concurrent State Label create does not fail the Run', async (t) => {
  const f = fixture(t);
  // Another Run creates every State Label between this Run's label read and its creates.
  let reads = 0;
  const inner = f.gh.gh;
  github.setGh(async (args, cwd, input) => {
    if (args[0] === 'api' && args.at(-1).includes('/labels') && ++reads === 1) {
      f.gh.calls.push({ args, cwd, input });
      return JSON.stringify([[]]);
    }
    return inner(args, cwd, input);
  });
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(f.readEvents().filter((e) => e.type === 'label_failed').length, 0);
  assert.ok(f.gh.labels.has('gg:state:ready-for-qa'));
});

test('a transient State Label setup failure is retried by the later label write', async (t) => {
  const f = fixture(t);
  let reads = 0;
  const inner = f.gh.gh;
  github.setGh(async (args, cwd, input) => {
    if (args[0] === 'api' && args.at(-1).includes('/labels') && ++reads === 1) {
      f.gh.calls.push({ args, cwd, input });
      throw new Error('HTTP 502: temporary label read failure');
    }
    return inner(args, cwd, input);
  });
  const results = await run.runTarget(f.options);
  assert.equal(reads, 2, 'the terminal label write retries setup');
  assert.equal(run.runExitCode(results), 1, 'the first failure is still reported');
  assert.equal(f.readEvents().filter((e) => e.type === 'label_failed').length, 1);
  assert.ok(f.gh.labels.has('gg:state:ready-for-qa'), 'the later label write succeeds');
});

const NOT_READY = [
  [{ state: 'CLOSED' }, 'closed'],
  [{ blockedBy: [{ number: 3, state: 'OPEN' }, { number: 5, state: 'OPEN' }] }, 'blocked by #3, #5'],
  [{ labels: [{ name: 'gg:state:ready-for-qa' }] }, 'carries State Label gg:state:ready-for-qa'],
];
for (const [issue, reason] of NOT_READY) {
  test(`not-ready skips name the reason and make only the discovery read: ${reason}`, async (t) => {
    const f = fixture(t, { issue });
    assert.equal(ticketResult(await run.runTarget(f.options)).outcome, 'skipped');
    assert.ok(f.logs.includes(`[main] #${TICKET} skipped: it is not ready: ${reason}`), JSON.stringify(f.logs));
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']]);
  });
}

test('every line a Run prints names its repository, in the terminal and in run.log', async (t) => {
  // A fault whose report gets HTTP 502 and whose label edit fails logs from run, the interpreter and github.
  const f = fixture(t, { labels: [IN_PROGRESS], failEdit: true });
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'red' },
    configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  f.options.git = { ...f.options.git, ensureWorktree: async () => { throw new Error('worktree add failed'); } };
  failComment(f);

  await run.runTarget(f.options);
  const prefix = `[${basename(f.mainRoot)}] `;
  assert.ok(f.logs.some((l) => l.startsWith(`${prefix}#${TICKET} ERROR worktree add failed`)), `the admission error: ${JSON.stringify(f.logs)}`);
  assert.ok(f.logs.some((l) => l.startsWith(`${prefix}#${TICKET} fault report failed:`)), `the report failure: ${JSON.stringify(f.logs)}`);
  assert.ok(f.logs.some((l) => l.startsWith(`${prefix}#${TICKET} ERROR label update`)), `the label failure: ${JSON.stringify(f.logs)}`);
  assert.ok(f.logs.some((l) => l.startsWith(prefix) && /failure, retry 1 of/.test(l)), `the retry line: ${JSON.stringify(f.logs)}`);
  assert.deepEqual(f.logs.filter((l) => !l.startsWith(prefix)), [], 'every line names the repository');
  const runLog = readFileSync(join(f.commonDir, 'gg', 'runs', lastRun(f), 'run.log'), 'utf8');
  assert.equal(runLog.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /gm, ''), f.logs.map((m) => `${m}\n`).join(''), 'run.log holds every line, after its timestamp');
});

test('every error a Run throws names its repository', async (t) => {
  const p = fixture(t);
  p.options.config.agents.implementer.harness = 'nope';
  const preflight = await run.runTarget(p.options).then(() => null, (e) => e);
  assert.ok(preflight?.message.startsWith('[main] preflight failed:'), preflight?.message);

  const v = fixture(t);
  github.setGh(async (args) => { throw new Error(`gh ${args.join(' ')} exited 1\nHTTP 404: Not Found`); });
  const view = await run.runTarget(v.options).then(() => null, (e) => e);
  assert.ok(view?.message.startsWith(`[main] gh issue view ${TICKET} `), view?.message);

  const f = fixture(t, { issues: epicOf([21], { 21: { state: 'CLOSED' } }) });
  f.options.target = EPIC;
  const epic = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(epic?.message.startsWith(`[main] #${EPIC}: nothing ready`), epic?.message);

  const g = fixture(t);
  g.options.config.flows.default.plan = { entry: 'planner', vertices: {} };
  const standalone = await run.runTarget(g.options).then(() => null, (e) => e);
  assert.ok(standalone?.message.startsWith(`[main] #${TICKET} is a standalone Ticket`), standalone?.message);
});

test('preflight names every failing vertex in one error, before any gh call, worktree or run directory', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.agents.implementer.harness = 'nope';
  f.options.config.agents.reviewer.harness = 'claude';
  f.options.harnesses.claude = await import('../../lib/harnesses/claude.mjs');
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'preflight rejects the run');
  assert.match(err.message, /implementer[^]*nope|nope[^]*implementer/, 'the unknown harness is named with its vertex');
  assert.match(err.message, /reviewer/);
  assert.equal(err.message.split('\n').find((l) => l.startsWith('vertex reviewer')), 'vertex reviewer: harness claude: not implemented');
  assert.deepEqual(f.gh.calls, [], 'no gh call');
  assert.equal(f.worktrees(), 1, 'no worktree');
  assert.equal(existsSync(join(f.root, 'wt')), false, 'no worktree root');
  assert.equal(existsSync(join(f.commonDir, 'gg', 'runs')), false, 'no run directory');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
});

test('preflight rejects a repository Layer without testPaths', async (t) => {
  const f = fixture(t);
  delete f.options.config.testPaths;
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  const file = config.layerPath(f.mainRoot);
  assert.deepEqual(err?.message.split('\n'), [
    '[main] preflight failed:',
    `${file} declares no testPaths; merge {"testPaths":["<glob>"]} into it`,
  ]);
  assert.equal(err.exitCode, 1);
  assert.deepEqual(f.gh.calls, [], 'no gh call');
  assert.equal(f.worktrees(), 1, 'no worktree');
});

test('preflight lists every unset Vertex and Agent before one merge advice line', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.agents.implementer.harness = null;
  f.options.config.agents.reviewer.harness = null;
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.equal(err.exitCode, 2);
  const examples = fileURLToPath(new URL('../../examples/', import.meta.url));
  assert.deepEqual(err.message.split('\n'), [
    '[main] preflight failed:',
    'vertex red: no harness configured for agent implementer',
    'vertex green: no harness configured for agent implementer',
    'vertex reviewer: no harness configured for agent reviewer',
    'vertex implementer-fix: no harness configured for agent implementer',
    `Merge one of ${join(examples, 'claude.json')}, ${join(examples, 'codex.json')} into the user Layer at ${config.layerPath(homedir())}.`,
  ]);
  assert.deepEqual(f.gh.calls, [], 'no gh call');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.equal(f.worktrees(), 1, 'no worktree');
});

test('preflight names an unset harness and an unknown harness in one error', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.agents.implementer.harness = null;
  f.options.config.agents.reviewer.harness = 'nope';
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'preflight rejects the run');
  assert.match(err.message, /no harness configured for agent implementer/);
  assert.match(err.message, /reviewer[^]*nope/, 'the unknown harness is named with its vertex');
  assert.equal(err.exitCode, 2, 'an unset harness exits 2');
  assert.deepEqual(f.gh.calls, [], 'no gh call');
});
