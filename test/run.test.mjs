import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import * as config from '../lib/config.mjs';
import * as events from '../lib/events.mjs';
import * as flowModule from '../lib/flow.mjs';
import * as gitModule from '../lib/git.mjs';
import * as github from '../lib/github.mjs';
import * as integrity from '../lib/integrity.mjs';
import * as interpreter from '../lib/interpreter.mjs';
import * as locks from '../lib/locks.mjs';
import * as marker from '../lib/marker.mjs';
import * as record from '../lib/record.mjs';
import * as run from '../lib/run.mjs';
import * as golden from './support/golden.mjs';
import { fakeHarness } from './support/fake-harness.mjs';

const contender = fileURLToPath(new URL('./support/lock-contender.mjs', import.meta.url));
const TICKET = golden.TICKET;
const BRANCH = golden.BRANCH;
const IN_PROGRESS = 'gg:state:in-progress';
const NEEDS_HUMAN = 'gg:state:needs-human';
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// The shipped defaults with every Node on `harness` and, unless `fullFlow`, a one-Vertex Flow from tdd straight to done.
function testConfig(root, { harness = 'fake', fullFlow = false } = {}) {
  const c = config.loadDefaults();
  for (const node of Object.values(c.nodes)) Object.assign(node, { harness, model: 'model-x', effort: 'high' });
  c.worktreeRoot = join(root, 'wt');
  if (!fullFlow) c.flows.default.ticket = { entry: 'implementer', vertices: { implementer: { use: 'implementer', procedure: 'tdd', then: 'done' } } };
  return c;
}

// A temp origin and clone with AGENTS.md, a fake gh at lib/github.mjs's seam answering one standalone Ticket, and the
// fake harness. `failEdit` makes every label edit fail as gh does; `issue` overrides fields of the issue view.
function fixture(t, { responses = golden.firstVisitResponses, failEdit = false, failCreate = false, repoLabels, labels = [], branch = BRANCH, harness: harnessName, fullFlow, issue = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gg-run-'));
  const mainRoot = join(root, 'main');
  const commonDir = join(mainRoot, '.git');
  t.after(() => {
    record.close(commonDir);
    rmSync(root, { recursive: true, force: true });
  });
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  sh(root, 'clone', '-q', 'origin.git', 'main');
  sh(mainRoot, 'config', 'user.name', 't'); sh(mainRoot, 'config', 'user.email', 't@t');
  writeFileSync(join(mainRoot, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
  writeFileSync(join(mainRoot, 'AGENTS.md'), '# repo\n\n## Commands\n\n- test: `npm test`\n');
  sh(mainRoot, 'add', '-A');
  sh(mainRoot, 'commit', '-q', '-m', 'init');
  sh(mainRoot, 'push', '-q', 'origin', 'main');
  const base = sh(mainRoot, 'rev-parse', 'main');

  const fake = golden.fakeGh({ branch, repoLabels });
  for (const l of labels) fake.labels.add(l);
  const inner = fake.gh;
  fake.gh = async (args, cwd, input) => {
    const [noun, verb] = args;
    if (noun === 'issue' && verb === 'view') {
      fake.calls.push({ args, cwd, input });
      return JSON.stringify({ number: Number(args[2]), title: 'Add two numbers', body: 'Add `add(a, b)`.', state: 'OPEN',
        labels: [...fake.labels].map((name) => ({ name })), blockedBy: [], subIssues: [], ...issue });
    }
    if (failEdit && noun === 'issue' && verb === 'edit') {
      fake.calls.push({ args, cwd, input });
      throw new Error(`gh issue edit ${args[2]} exited 1\nHTTP 502: Bad Gateway`);
    }
    if (failCreate && noun === 'label' && verb === 'create') {
      fake.calls.push({ args, cwd, input });
      throw new Error('HTTP 403: label creation denied');
    }
    return inner(args, cwd, input);
  };
  github.setGh(fake.gh);

  const harness = fakeHarness({ transcriptDir: join(root, 'transcripts'), responses, capabilities: { cost: false, reasoningTokens: false } });
  const exec = {
    runShell: async (command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
      ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: golden.RED_OUTPUT, timedOut: false },
  };
  const logs = [];
  let now = Date.parse('2026-10-17T00:00:00Z');
  const clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const cfg = testConfig(root, { harness: harnessName, fullFlow });
  const worktree = gitModule.worktreePath(cfg.worktreeRoot, 'main', TICKET);
  const options = { target: TICKET, config: cfg, harnesses: { fake: harness }, gh: github, git: gitModule, exec, cwd: mainRoot,
    log: (m) => logs.push(m), clock };
  return {
    root, mainRoot, commonDir, base, worktree, gh: fake, harness, exec, logs, clock, options,
    readEvents: () => events.readEvents(commonDir),
    worktrees: () => sh(mainRoot, 'worktree', 'list').split('\n').length,
    loadRow: () => record.openDb(commonDir).prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(TICKET)?.json,
    comments: () => fake.comments.filter((c) => c.number === TICKET).map((c) => c.body),
    labelAdds: () => fake.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit')
      .flatMap((c) => c.args.filter((a, i) => c.args[i - 1] === '--add-label')),
  };
}

// An Execution of the fixture's Ticket run straight through the interpreter, as an earlier Run left it.
async function seedExecution(f, { git = gitModule, crashAt, exec = f.exec } = {}) {
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  const flow = flowModule.resolveFlow(f.options.config);
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: flow.name, entry: flow.ticket.entry },
    configHash: 'cfg-hash', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  await assert.rejects(interpreter.runExecution({
    flow, record: rec, harness: f.harness, gh: github, git, exec, events: events.eventLog(f.commonDir), log: () => {}, cwd: f.mainRoot,
    commands: { test: 'npm test' }, ticket: { number: TICKET, title: 'Add two numbers', body: 'Add `add(a, b)`.', branch: BRANCH },
    base: 'main', labelPrefix: 'gg', others: [], clock: f.clock, crashAt: crashAt?.(rec),
  }), (err) => err instanceof interpreter.CrashError);
  return record.load(f.commonDir, 'ticket', TICKET);
}

const markerOf = (rec, vertex, visit, phase, ordinal) =>
  marker.formatMarker({ execution: rec.execution, vertex, visit, phase, ordinal, run: rec.run, attempt: 1 });

// Spawns a process holding the lock `name`, resolving once it reports its handle; killing it releases the lock.
function holdLock(t, commonDir, name) {
  const child = spawn(process.execPath, [contender, commonDir, name, '60000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      try {
        const report = JSON.parse(out);
        if (!report.handle) reject(new Error(`holder did not get the lock: ${out}`));
        resolve({ release: () => { child.kill(); return exited; } });
      } catch {}
    });
    child.on('exit', () => reject(new Error(`holder exited before reporting: ${out}`)));
  });
}

const ticketResult = (results) => results.find((r) => r.ticket === TICKET);

test('a Run ensures missing State Labels once immediately before its first label edit', async (t) => {
  for (const repoLabels of [[], ['gg:state:in-progress'], ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa']]) {
    const f = fixture(t, { repoLabels });
    assert.equal(run.runExitCode(await run.runTarget(f.options)), 0);
    const reads = f.gh.calls.filter((c) => c.args[0] === 'api' && c.args.at(-1).includes('/labels'));
    assert.equal(reads.length, 1, 'one repository label read per Run');
    const creates = f.gh.calls.filter((c) => c.args[0] === 'label');
    assert.deepEqual(creates.map((c) => c.args[2]).sort(),
      ['gg:state:in-progress', 'gg:state:needs-human', 'gg:state:needs-replan', 'gg:state:ready-for-qa'].filter((l) => !repoLabels.includes(l)).sort());
    assert.ok(creates.every((c) => !c.args.includes('--force')));
    const firstEdit = f.gh.calls.findIndex((c) => c.args[0] === 'issue' && c.args[1] === 'edit');
    assert.equal(f.gh.calls[firstEdit - 1], creates.at(-1) ?? reads[0], 'setup immediately precedes the first label edit');
  }
});

test('a State Label creation failure uses the label-failure log, Event and exit code', async (t) => {
  const f = fixture(t, { repoLabels: [], failCreate: true });
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  assert.equal(ticketResult(results).labelFailed, true);
  assert.ok(f.logs.some((l) => l.includes('label creation denied')));
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET && e.error.includes('label creation denied')));
  assert.equal(f.gh.calls.filter((c) => c.args[0] === 'api' && c.args.at(-1).includes('/labels')).length, 2, 'a failed setup is retried at the next label write');
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

test('not-ready skips name the reason and make only the discovery read', async (t) => {
  for (const [issue, reason] of [
    [{ state: 'CLOSED' }, 'closed'],
    [{ blockedBy: [{ number: 3, state: 'OPEN' }, { number: 5, state: 'OPEN' }] }, 'blocked by #3, #5'],
    [{ labels: [{ name: 'gg:state:ready-for-qa' }] }, 'carries State Label gg:state:ready-for-qa'],
  ]) {
    const f = fixture(t, { issue });
    assert.equal(ticketResult(await run.runTarget(f.options)).outcome, 'skipped');
    assert.ok(f.logs.includes(`#${TICKET} skipped: it is not ready: ${reason}`), JSON.stringify(f.logs));
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']]);
  }
});

test('runEpic preflight throws naming vertex and harness before any gh call or worktree', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.nodes.implementer.harness = 'nope';
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'preflight rejects the run');
  assert.match(err.message, /implementer/);
  assert.match(err.message, /nope/);
  assert.deepEqual(f.gh.calls, [], 'no gh call');
  assert.equal(f.worktrees(), 1, 'no worktree');
  assert.equal(existsSync(join(f.root, 'wt')), false);
  assert.equal(existsSync(join(f.commonDir, 'gg', 'runs')), false, 'no run directory');
  assert.equal(f.harness.calls.length, 0);
});

test('runEpic preflight names every failing vertex in one error', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.nodes.implementer.harness = 'nope';
  f.options.config.nodes.reviewer.harness = 'claude';
  f.options.harnesses.claude = await import('../lib/harnesses/claude.mjs');
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'preflight rejects the run');
  assert.match(err.message, /implementer[^]*nope|nope[^]*implementer/, 'the unknown harness is named with its vertex');
  assert.match(err.message, /reviewer/);
  assert.equal(err.message.split('\n').find((l) => l.startsWith('vertex reviewer')), 'vertex reviewer: harness claude: not implemented');
  assert.deepEqual(f.gh.calls, [], 'no gh call');
  assert.equal(f.worktrees(), 1, 'no worktree');
  assert.equal(existsSync(join(f.commonDir, 'gg', 'runs')), false, 'no run directory');
});

test('a node without a harness fails admission naming the vertex and node', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.nodes.implementer.harness = null;
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'admission rejects the run');
  const examples = fileURLToPath(new URL('../examples/', import.meta.url));
  assert.equal(err.message.split('\n')[1], 'vertex implementer: no harness configured for node implementer');
  assert.equal(err.message.split('\n').at(-1), `Merge ${join(examples, 'claude.json')} or ${join(examples, 'codex.json')} into the user Layer at ${config.layerPath(homedir())}.`);
  assert.deepEqual(f.gh.calls, [], 'no gh call');
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.equal(f.worktrees(), 1, 'no worktree');
});

test('preflight lists every unset Vertex and Node before one merge advice line', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.nodes.implementer.harness = null;
  f.options.config.nodes.reviewer.harness = null;
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.equal(err.exitCode, 2);
  const examples = fileURLToPath(new URL('../examples/', import.meta.url));
  assert.deepEqual(err.message.split('\n'), [
    'preflight failed:',
    'vertex implementer: no harness configured for node implementer',
    'vertex reviewer: no harness configured for node reviewer',
    'vertex implementer-fix: no harness configured for node implementer',
    `Merge ${join(examples, 'claude.json')} or ${join(examples, 'codex.json')} into the user Layer at ${config.layerPath(homedir())}.`,
  ]);
  assert.deepEqual(f.gh.calls, []);
  assert.equal(f.harness.calls.length, 0);
});

test('preflight names an unset harness and an unknown harness in one error', async (t) => {
  const f = fixture(t, { fullFlow: true });
  f.options.config.nodes.implementer.harness = null;
  f.options.config.nodes.reviewer.harness = 'nope';
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'preflight rejects the run');
  assert.match(err.message, /no harness configured for node implementer/);
  assert.match(err.message, /reviewer[^]*nope/, 'the unknown harness is named with its vertex');
  assert.equal(err.exitCode, 2, 'an unset harness exits 2');
  assert.deepEqual(f.gh.calls, [], 'no gh call');
});

test('a standalone ticket under a flow with a plan section is rejected before any effect', async (t) => {
  const f = fixture(t);
  f.options.config.flows['ticket-only'] = structuredClone(f.options.config.flows.default);
  f.options.config.flows.default.plan = { entry: 'planner', vertices: {} };
  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'the standalone ticket is rejected');
  assert.equal(err.exitCode ?? 1, 1, 'the rejection exit code is unchanged');
  assert.match(err.message, /set plan to null on Flow default\b/);
  assert.ok(err.message.includes(join(f.mainRoot, '.agents', 'gg', 'gg.json')), 'the message names the repo Layer file');
  assert.ok(err.message.includes('{"flows":{"default":{"plan":null}}}'), 'the message gives the minimal repo Layer JSON');
  assert.doesNotMatch(err.message, /ticket-only/, 'the advice does not name an unselectable Flow');
  assert.ok(f.gh.calls.length > 0, 'the target was discovered');
  assert.deepEqual(f.gh.calls.filter((c) => !(c.args[0] === 'issue' && c.args[1] === 'view')), [], 'gh recorded only issue view');
  assert.equal(f.worktrees(), 1, 'no worktree');
  assert.equal(f.loadRow(), undefined, 'no record');
  assert.equal(f.harness.calls.length, 0);
  assert.equal(existsSync(join(f.commonDir, 'gg', 'runs')), false, 'no run directory');
});

test('a standalone Ticket under a Flow without a plan key is accepted', async (t) => {
  const f = fixture(t);
  delete f.options.config.flows.default.plan;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'done');
  assert.equal(f.harness.calls.length, 2, 'both agent Phases ran on the fake Harness');
  const { run: runId } = f.readEvents().find((e) => e.type === 'run_start');
  const resolved = JSON.parse(readFileSync(join(f.commonDir, 'gg', 'runs', runId, 'flow.json'), 'utf8'));
  assert.equal(Object.hasOwn(resolved, 'plan'), false, 'the Resolved Flow has no plan key');
});

test('following standalone Ticket advice in the repo Layer allows the Ticket to run', async (t) => {
  const f = fixture(t);
  f.options.config.flows.default.plan = { entry: 'planner', vertices: {} };
  const home = join(f.root, 'home');
  mkdirSync(join(home, '.agents', 'gg'), { recursive: true });
  writeFileSync(join(home, '.agents', 'gg', 'gg.json'), JSON.stringify(f.options.config));
  f.options.config = config.loadConfig(f.mainRoot, home);

  const err = await run.runTarget(f.options).then(() => null, (e) => e);
  assert.ok(err, 'the user Layer initially enables the plan section');
  const repoLayer = join(f.mainRoot, '.agents', 'gg', 'gg.json');
  assert.ok(err.message.includes(repoLayer), 'the advice names the path loadConfig reads');
  const advice = JSON.parse(err.message.split('\n').at(-1));
  assert.deepEqual(advice, { flows: { default: { plan: null } } });
  mkdirSync(join(f.mainRoot, '.agents', 'gg'), { recursive: true });
  writeFileSync(repoLayer, JSON.stringify(advice));
  f.options.config = config.loadConfig(f.mainRoot, home);

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'done');
  assert.equal(f.harness.calls.length, 2, 'both agent Phases ran on the fake Harness');
});

test('a ticket reaching done exits 0 and the run events carry the run id and outcome', async (t) => {
  const f = fixture(t);
  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  assert.ok(f.gh.labels.has('gg:state:ready-for-qa'));
  const evs = f.readEvents();
  const start = evs.find((e) => e.type === 'run_start');
  const end = evs.find((e) => e.type === 'run_end');
  assert.ok(start && end, 'run_start and run_end are recorded');
  assert.equal(typeof start.run, 'string');
  assert.equal(end.run, start.run);
  assert.deepEqual(end.tickets, [{ ticket: TICKET, outcome: 'done' }], 'run_end carries the Ticket outcome');
  assert.equal(evs.find((e) => e.type === 'ticket_end').run, start.run);
  const runDir = join(f.commonDir, 'gg', 'runs', start.run);
  assert.ok(existsSync(join(runDir, 'flow.json')), 'the Resolved Flow is in the run directory');
  assert.ok(existsSync(join(runDir, 'config-hash.txt')), 'the Config Hash is in the run directory');
  assert.ok(readdirSync(runDir).some((name) => name.endsWith('.log')), 'the run directory has a log file');
});

test('unknown dirty state is held with the diff stat', async (t) => {
  const f = fixture(t);
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  const edited = '{ "scripts": { "test": "node --test" }, "human": true }\n';
  writeFileSync(join(f.worktree, 'package.json'), edited);
  writeFileSync(join(f.worktree, 'notes.txt'), 'my notes\n');
  const status = sh(f.worktree, 'status', '--porcelain');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('package.json')), `a comment carries the diff stat: ${JSON.stringify(f.comments())}`);
  assert.ok(f.comments().some((b) => b.includes(`Commit, stash or remove these changes in the worktree, then remove the ${NEEDS_HUMAN} label and re-run gg run ${TICKET}.`)));
  assert.ok(f.comments().every((b) => !b.includes(f.root)));
  assert.equal(readFileSync(join(f.worktree, 'package.json'), 'utf8'), edited, 'the edit is untouched');
  assert.equal(readFileSync(join(f.worktree, 'notes.txt'), 'utf8'), 'my notes\n', 'the untracked file is untouched');
  assert.equal(sh(f.worktree, 'status', '--porcelain'), status);
  const held = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(held?.state, 'held', 'the hold is recorded');
  assert.equal(f.readEvents().filter((e) => e.type === 'ticket_end' && e.execution === held.execution).length, 1, 'the hold landed');
  sh(f.worktree, 'restore', 'package.json');
  rmSync(join(f.worktree, 'notes.txt'));
  f.gh.labels.delete(NEEDS_HUMAN);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0, 'following the advice starts the Ticket');
});

// A merge conflict left in the worktree: conflict.txt at stages 1 to 3 with the markers on disk. git write-tree refuses
// such an index, so the snapshot cannot fingerprint it.
function conflict(worktree) {
  const blob = (text) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: worktree, input: text, encoding: 'utf8' }).trim();
  const stages = ['base\n', 'ours\n', 'theirs\n'].map((text, i) => `100644 ${blob(text)} ${i + 1}\tconflict.txt`);
  execFileSync('git', ['update-index', '--index-info'], { cwd: worktree, input: `${stages.join('\n')}\n` });
  writeFileSync(join(worktree, 'conflict.txt'), '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n');
  return { unmerged: sh(worktree, 'ls-files', '-u'), bytes: readFileSync(join(worktree, 'conflict.txt'), 'utf8') };
}

function assertConflictHeld(f, results, before) {
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('conflict.txt')), `a comment carries the diff stat: ${JSON.stringify(f.comments())}`);
  assert.ok(f.comments().some((b) => b.includes('merge conflict') && b.includes('Resolve and commit the conflicted paths in the worktree')));
  assert.ok(f.comments().every((b) => !b.includes(f.root)));
  assert.equal(sh(f.worktree, 'ls-files', '-u'), before.unmerged, 'the unmerged index is untouched');
  assert.equal(readFileSync(join(f.worktree, 'conflict.txt'), 'utf8'), before.bytes, 'the conflicted file is untouched');
}

test('a merge conflict at ticket start is held with the diff stat', async (t) => {
  const f = fixture(t);
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  const before = conflict(f.worktree);

  assertConflictHeld(f, await run.runTarget(f.options), before);
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  writeFileSync(join(f.worktree, 'conflict.txt'), 'resolved\n');
  sh(f.worktree, 'add', 'conflict.txt');
  sh(f.worktree, 'commit', '-q', '-m', 'resolve conflict');
  f.gh.labels.delete(NEEDS_HUMAN);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0, 'following the advice starts the Ticket');
});

test('dirty hold advice explains how a held Execution Record can be inspected and restarted', async (t) => {
  const f = fixture(t);
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  f.options.cwd = f.worktree;
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: 'seed', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.ok(f.comments().some((b) => b.includes(`Execution Record ticket-${TICKET} is held`) && b.includes('SQLite client')));
  assert.ok(f.comments().some((b) => b.includes('Inspect the row first in the State Database at .git/gg/gg.db (relative to the main checkout) using a SQLite client.')));
  assert.ok(f.comments().some((b) => b.includes(`DELETE FROM records WHERE kind = 'ticket' AND n = ${TICKET};`)));
  assert.equal((await gitModule.repoInfo(f.worktree)).gitCommonDir, f.commonDir, 'the linked worktree uses the main checkout State Database');
  assert.ok(existsSync(join(f.mainRoot, '.git', 'gg', 'gg.db')));
  const held = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(held.state, 'held');
  assert.doesNotMatch(held.terminalReason.text, /DELETE FROM|SQLite/, 'the recovery advice is in the comment, not the Terminal Reason');
  rmSync(join(f.worktree, 'human.txt'));
  f.gh.labels.delete(NEEDS_HUMAN);
  assert.equal(ticketResult(await run.runTarget(f.options)).outcome, 'skipped', 'removing the label alone cannot resume a finished record');
  const statement = f.comments().join('\n').match(/`(DELETE FROM records WHERE kind = 'ticket' AND n = \d+;)`/)[1];
  record.openDb(f.commonDir).exec(statement);
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 0, 'deleting only the held row allows a fresh Execution');
});

test('a merge conflict in the worktree of a resumed execution is held, not faulted', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
  const before = conflict(f.worktree);

  assertConflictHeld(f, await run.runTarget(f.options), before);
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'held');
});

// The green commit was intended, its implementation staged, and the process died before the commit landed.
const crashBeforeCommit = (f) => seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 3), point: 'before-effect' }) });

test('a commit interrupted before it landed is admitted and replayed', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await crashBeforeCommit(f);
  assert.deepEqual(record.openIntents(seeded).map((e) => e.action), ['commit'], 'the record holds the intended commit');
  assert.notEqual(sh(f.worktree, 'status', '--porcelain'), '', 'the staged implementation waits for its commit');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(f.harness.calls.length, 2, 'no agent call is repeated');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'done');
  assert.equal(sh(f.worktree, 'status', '--porcelain'), '', 'the replayed commit took the staged changes');
  assert.notEqual(sh(f.worktree, 'ls-tree', 'HEAD', 'lib/add.mjs'), '', 'the implementation is committed');
});

test('a commit interrupted before it landed is held once a human changed the worktree', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await crashBeforeCommit(f);
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  const staged = sh(f.worktree, 'diff', '--cached', '--name-only');

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.equal(sh(f.worktree, 'diff', '--cached', '--name-only'), staged, 'the staged changes are untouched');
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'held');
});

test('a resumed execution on another Ticket branch or another branch of its Ticket is held before recovery', async (t) => {
  for (const branch of ['ticket/99-another-ticket', `ticket/${TICKET}-another-attempt`]) {
    const f = fixture(t, { labels: [IN_PROGRESS] });
    const seeded = await crashBeforeCommit(f);
    sh(f.worktree, 'checkout', '-q', '-b', branch);
    const head = sh(f.worktree, 'rev-parse', 'HEAD');
    const before = await integrity.snapshot(f.worktree);
    const implementation = readFileSync(join(f.worktree, 'lib', 'add.mjs'), 'utf8');
    f.gh.calls.length = 0;

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
    assert.ok(!f.gh.labels.has(IN_PROGRESS));
    assert.ok(f.comments().some((b) => b.includes(BRANCH) && b.includes(branch)), 'the hold names both branches');
    assert.equal(f.harness.calls.length, 2, 'no agent started');
    assert.equal(sh(f.worktree, 'branch', '--show-current'), branch);
    assert.equal(sh(f.worktree, 'rev-parse', branch), head, 'the other branch did not advance');
    assert.equal(sh(f.worktree, 'rev-parse', BRANCH), head, 'the recorded branch did not advance');
    assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and worktree are untouched');
    assert.equal(readFileSync(join(f.worktree, 'lib', 'add.mjs'), 'utf8'), implementation, 'the implementation is kept');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    const final = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(final.state, 'held');
    assert.equal(final.branch, BRANCH);
    assert.deepEqual(record.openIntents(final), record.openIntents(seeded), 'the intended commit is kept');
  }
});

test('fresh admission refuses another Ticket\'s branch without changing it', async (t) => {
  // ticket/150-* shares ticket 15's digits, so the prefix must end at the number.
  for (const branch of ['ticket/99-other', 'ticket/150-other', 'detached HEAD']) {
    const f = fixture(t);
    await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
    if (branch === 'detached HEAD') sh(f.worktree, 'checkout', '-q', '--detach');
    else sh(f.worktree, 'checkout', '-q', '-b', branch);
    const head = sh(f.worktree, 'rev-parse', 'HEAD');
    const before = await integrity.snapshot(f.worktree);

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
    assert.ok(f.comments().some((b) => b.includes(branch) && b.includes(`ticket/${TICKET}-*`)),
      `the hold names the actual and required branches: ${JSON.stringify(f.comments())}`);
    const held = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(held?.state, 'held', 'the hold is recorded');
    assert.equal(held.branch, BRANCH, 'the record names the intended branch, never the one found');
    assert.equal(held.worktree, f.worktree);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(sh(f.worktree, 'branch', '--show-current'), branch === 'detached HEAD' ? '' : branch);
    assert.equal(sh(f.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and files are untouched');
    assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${branch}`), '', 'nothing was pushed');
  }
});

test('fresh admission reuses its Ticket branch after a title change', async (t) => {
  const branch = `ticket/${TICKET}-old-title`;
  const f = fixture(t, { branch, issue: { title: 'A new title' } });
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch, base: 'main' });

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).branch, branch);
  assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${branch}`).split('\t')[0], sh(f.worktree, 'rev-parse', 'HEAD'));
  assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/ticket/${TICKET}-a-new-title`), '', 'no branch from the new title');
});

test('resume refuses a recorded branch belonging to another Ticket', async (t) => {
  const branch = 'ticket/99-other';
  for (const existing of [true, false]) {
    const f = fixture(t, { labels: [IN_PROGRESS] });
    if (existing) await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch, base: 'main' });
    const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
      configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch, base: 'main' });
    await record.intent(rec, 'seed-intent', 'commit', { message: 'red' });
    assert.equal(record.openIntents(rec).length, 1);
    const worktrees = f.worktrees();
    const before = existing && await integrity.snapshot(f.worktree);

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
    assert.ok(f.comments().some((b) => b.includes(branch) && b.includes(`ticket/${TICKET}-*`)),
      `the hold names the recorded and required branches: ${JSON.stringify(f.comments())}`);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(f.worktrees(), worktrees, 'no worktree was created or removed');
    assert.equal(existsSync(f.worktree), existing, 'a missing worktree is not recreated');
    if (existing) {
      assert.equal(sh(f.worktree, 'branch', '--show-current'), branch);
      assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and files are untouched');
    } else assert.equal(sh(f.mainRoot, 'branch', '--list', branch), '', 'the foreign branch was not created');
    const final = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(final.state, 'held');
    assert.equal(final.branch, branch);
    assert.deepEqual(record.openIntents(final), record.openIntents(rec), 'the outstanding intent is kept');
  }
});

const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

test('admission detects an agent overwrite of an idle sibling as an Integrity Violation', async (t) => {
  const other = 'ticket/99-other';
  // A second branch of this same Ticket is another worktree too, not the one being admitted.
  for (const [seeded, siblingRecord, siblingBranch = other] of [[false, false], [false, true], [true, false], [true, true],
    [false, false, `ticket/${TICKET}-other-suffix`]]) {
    const responses = structuredClone(golden.firstVisitResponses);
    const f = fixture(t, { responses, labels: seeded ? [IN_PROGRESS] : [] });
    // Outside the configured worktree root, so only git's worktree list can find it.
    const sibling = join(f.root, 'elsewhere', 'ticket-99');
    sh(f.mainRoot, 'worktree', 'add', '-q', '-b', siblingBranch, sibling, 'main');
    if (siblingRecord) {
      await record.save(record.createExecution({ commonDir: f.commonDir, ticket: 99, epic: null, flow: { name: 'default', entry: 'implementer' },
        configHash: 'x', run: '20261016T000000Z-seed00', worktree: sibling, branch: other, base: 'main' }));
    }
    if (seeded) {
      await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
      await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
        configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
    }
    responses['implementer/1/red/1'].files[relative(f.worktree, join(sibling, 'package.json'))] = '{ "overwritten": true }\n';

    const results = await run.runTarget(f.options);
    const label = JSON.stringify({ seeded, siblingRecord, siblingBranch });
    assert.equal(run.runExitCode(results), 2, `${label} ${JSON.stringify(results)}`);
    const red = f.readEvents().find((e) => e.type === 'action' && e.ticket === TICKET && e.phase === 'red' && e.agent);
    assert.equal(red?.outcome, 'integrity-violation', label);
    assert.equal(red.rule, 'integrity-violation');
    assert.ok(red.violations.some((v) => pathKey(v.worktree) === pathKey(sibling) && v.surface === 'tree'), JSON.stringify(red.violations));
    assert.equal(f.harness.calls.length, 1, 'no agent call after the violation');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`), '', 'nothing was pushed');
    assert.equal(sh(f.worktree, 'rev-parse', 'HEAD'), f.base, 'the own worktree is back at its baseline head');
    assert.equal(sh(f.worktree, 'status', '--porcelain'), '', 'the own worktree is restored');
  }
});

test('admission excludes non-ticket worktrees and its own, however cased, from sibling assertions', async (t) => {
  const f = fixture(t);
  // git write-tree refuses an unmerged index, so a snapshot of this worktree would fault.
  const scratch = join(f.root, 'scratch');
  sh(f.mainRoot, 'worktree', 'add', '-q', '-b', 'scratch', scratch, 'main');
  conflict(scratch);
  // Windows paths are case-insensitive: the own worktree, listed in another case, would see its agent's writes as violations.
  if (process.platform === 'win32') {
    f.options.git = { ...gitModule, listWorktrees: async (root) => (await gitModule.listWorktrees(root)).map((w) => ({ ...w, path: w.path.toUpperCase() })) };
  }

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
  assert.equal(ticketResult(results).outcome, 'done');
});

test('sibling discovery failure prevents agent execution', async (t) => {
  for (const seeded of [false, true]) {
    const f = fixture(t, { labels: seeded ? [IN_PROGRESS] : [] });
    if (seeded) {
      await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
      await record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
        configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' }));
    }
    f.options.git = { ...gitModule, listWorktrees: async () => { throw new Error('fatal: cannot list worktrees'); } };

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
    assert.match(ticketResult(results).error, /cannot list worktrees/);
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    // An Execution that cannot be admitted, fresh or active, is marked as a fault, never left to retry.
    assert.equal((await record.load(f.commonDir, 'ticket', TICKET))?.state, 'fault');
  }
});

test('a resumed execution detached at the recorded SHA is held before recovery', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await crashBeforeCommit(f);
  const head = sh(f.worktree, 'rev-parse', 'HEAD');
  sh(f.worktree, 'checkout', '-q', '--detach', head);
  const before = await integrity.snapshot(f.worktree);
  f.gh.calls.length = 0;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.ok(f.gh.labels.has(NEEDS_HUMAN));
  assert.ok(f.comments().some((b) => b.includes('detached HEAD') && b.includes(BRANCH)), 'the hold names the detached HEAD and recorded branch');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  assert.equal(sh(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'HEAD stays detached');
  assert.equal(sh(f.worktree, 'rev-parse', BRANCH), head, 'the recorded branch is untouched');
  assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the index and files are untouched');
  assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'held');
  assert.deepEqual(record.openIntents(final), record.openIntents(seeded));
});

test('a resumed execution stopped mid-rebase is held without changing the rebase', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'red', 3), point: 'after-completion' }) });
  const rebase = spawnSync('git', ['rebase', '--exec', 'exit 1', 'main'], { cwd: f.worktree, encoding: 'utf8' });
  assert.equal(rebase.status, 1, rebase.stderr);
  assert.equal(sh(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  const rebasePath = sh(f.worktree, 'rev-parse', '--git-path', 'rebase-merge');
  const todo = readFileSync(join(rebasePath, 'git-rebase-todo'), 'utf8');
  const before = await integrity.snapshot(f.worktree);
  const head = sh(f.worktree, 'rev-parse', BRANCH);

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'held');
  assert.equal(f.harness.calls.length, 1, 'no agent started');
  assert.deepEqual(await integrity.snapshot(f.worktree), before);
  assert.equal(sh(f.worktree, 'rev-parse', BRANCH), head);
  assert.equal(readFileSync(join(rebasePath, 'git-rebase-todo'), 'utf8'), todo, 'the rebase is untouched');
  assert.deepEqual(record.openIntents(await record.load(f.commonDir, 'ticket', TICKET)), record.openIntents(seeded));
});

test('an unexpected branch query failure faults before recovery', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await crashBeforeCommit(f);
  const before = await integrity.snapshot(f.worktree);
  f.options.git = { ...gitModule, runGit: (args, opts) => args[0] === 'symbolic-ref'
    ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: cannot read HEAD' }) : gitModule.runGit(args, opts) };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
  assert.match(ticketResult(results).error, /cannot read HEAD/);
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  assert.deepEqual(await integrity.snapshot(f.worktree), before, 'nothing was replayed or discarded');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'fault');
  assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'commit'), record.openIntents(seeded));
});

test('a fault before the first visit still records its action events', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
    configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  f.options.git = { ...gitModule, ensureWorktree: async () => { throw new Error('worktree add failed\nfatal: disk full'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  const actions = f.readEvents().filter((e) => e.type === 'action' && e.ticket === TICKET);
  assert.deepEqual(actions.map((e) => `${e.phase} ${e.ordinal}`), ['fault 1', 'fault 2'], 'the comment and the label each record an Event');
  assert.ok(!f.logs.some((l) => /fault report failed/.test(l)), `no reporting failure is logged: ${JSON.stringify(f.logs)}`);
});

test('agent-made dirty state proven by the record is discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS] });
  // The red test passes before implementation, so the red Phase fails; the crash comes before its reset.
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  const seeded = await seedExecution(f, { git, exec });
  assert.deepEqual(record.openIntents(seeded).map((e) => e.action), ['reset'], 'the record holds the decided reset');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), "the agent's test is still in the worktree");
  f.options.exec = exec;

  await run.runTarget(f.options);
  assert.equal(sh(f.worktree, 'status', '--porcelain'), '', "the agent's changes are discarded");
  assert.equal(f.harness.calls.length, 2, 'no agent call is repeated');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.notEqual(final.state, 'held', 'the Ticket is not held for its own agent changes');
  assert.equal(final.state, 'needs-human', 'the Ticket runs on to the Terminal of its failed red');
  assert.deepEqual(final.history.map((h) => h.kind), ['red phase failed']);
  assert.deepEqual(record.openIntents(final), []);
});

test('changes made after an interrupted reset are held, not discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS] });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  // A human works in the worktree after the crash, on top of what the agent left.
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('human.txt')), `a comment carries the diff stat: ${JSON.stringify(f.comments())}`);
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('an ignored test added after an interrupted reset is held, not deleted', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS] });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  // An ignored file leaves HEAD and the tree as the agent left them, so only the saved ignored files can tell it apart.
  writeFileSync(join(f.commonDir, 'info', 'exclude'), 'test/human.test.mjs\n');
  writeFileSync(join(f.worktree, 'test', 'human.test.mjs'), 'mine\n');
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(readFileSync(join(f.worktree, 'test', 'human.test.mjs'), 'utf8'), 'mine\n', 'the human file is untouched');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('a human change staged after an interrupted reset is held, not discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS] });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  // Staged, then the working-tree bytes put back: HEAD and the worktree match what the agent left, only the index differs.
  const pkg = join(f.worktree, 'package.json');
  const original = readFileSync(pkg, 'utf8');
  writeFileSync(pkg, '{ "human": true }\n');
  sh(f.worktree, 'add', 'package.json');
  writeFileSync(pkg, original);
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.equal(sh(f.worktree, 'show', ':package.json'), '{ "human": true }', 'the staged human content survives');
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('an interrupted reset whose intent predates the index fingerprint is held', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [IN_PROGRESS] });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  const seeded = await seedExecution(f, { git, exec });
  delete record.openIntents(seeded)[0].payload.left.index;
  await record.save(seeded);
  f.options.exec = exec;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 2);
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), 'nothing was discarded');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('an admission failure on an active execution is reported as a fault', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  const seeded = await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
  let adds = 0;
  f.options.git = { ...gitModule, ensureWorktree: async () => { adds++; throw new Error('worktree add failed\nfatal: disk full') } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1, 'a fault exits 1');
  assert.match(ticketResult(results).error, /disk full/);
  assert.equal(f.harness.calls.length, 2, 'no agent started');
  const final = await record.load(f.commonDir, 'ticket', TICKET);
  assert.equal(final.state, 'fault', 'the record is marked, so it is not retried');
  assert.equal(final.execution, seeded.execution);
  assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'push'), record.openIntents(seeded), 'the earlier intent is kept');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS), 'the Ticket is at needs-human');
  assert.ok(f.comments().some((b) => b.includes('disk full')), `a comment carries the error: ${JSON.stringify(f.comments())}`);
  assert.match(f.readEvents().find((e) => e.type === 'ticket_end' && e.ticket === TICKET).error, /disk full/);
  assert.ok(f.readEvents().some((e) => e.type === 'ticket_start' && e.run === lastRun(f) && e.execution === seeded.execution));

  const second = await run.runTarget(f.options);
  assert.equal(adds, 1, 'the worktree add is not retried');
  assert.equal(ticketResult(second).outcome, 'skipped');
});

// Makes `gh issue comment` fail with HTTP 502 while `on` is set; `lost` lets the comment land first, as a lost response does.
function failComment(f, { lost = false } = {}) {
  const inner = f.gh.gh;
  const failing = { on: true };
  github.setGh(async (args, cwd, input) => {
    if (failing.on && args[0] === 'issue' && args[1] === 'comment') {
      if (lost) await inner(args, cwd, input);
      else f.gh.calls.push({ args, cwd, input });
      throw new Error('gh issue comment exited 1\nHTTP 502: Bad Gateway');
    }
    return inner(args, cwd, input);
  });
  return failing;
}
const endsOf = (f, execution) => f.readEvents().filter((e) => e.type === 'ticket_end' && e.execution === execution);
const lastRun = (f) => f.readEvents().findLast((e) => e.type === 'run_start').run;
const loadTicket = (f) => record.load(f.commonDir, 'ticket', TICKET);

// A worktree with a human file: fresh, or the worktree of an Execution whose commit was interrupted (with its Visits).
async function dirtyTicket(t, seeded) {
  const f = fixture(t, { labels: seeded ? [IN_PROGRESS] : [] });
  const seededRec = seeded ? await crashBeforeCommit(f) : null;
  if (!seeded) await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  return { f, seededRec };
}

test('a dirty hold whose comment gets HTTP 502 finishes on the next Run', async (t) => {
  for (const seeded of [false, true]) {
    const { f, seededRec } = await dirtyTicket(t, seeded);
    const agentCalls = f.harness.calls.length;
    const status = sh(f.worktree, 'status', '--porcelain');
    const head = sh(f.worktree, 'rev-parse', 'HEAD');
    const failing = failComment(f);

    const first = await run.runTarget(f.options);
    assert.equal(run.runExitCode(first), 1, `seeded ${seeded}: ${JSON.stringify(first)}`);
    assert.match(ticketResult(first).error, /HTTP 502/);
    const mid = await loadTicket(f);
    assert.equal(mid?.terminalReason?.decidedBy.hold, 'dirty-worktree', 'the hold is decided durably');
    assert.equal(mid.cursor.vertex, 'needs-human');
    assert.equal(mid.terminalStop?.held, true);
    const [open, ...more] = record.openIntents(mid).filter((e) => e.action === 'comment');
    assert.ok(open && !more.length, 'the hold comment intent stays open');
    assert.deepEqual(record.openIntents(mid).filter((e) => e.action !== 'comment'), seeded ? record.openIntents(seededRec) : [],
      'older intents are unchanged');
    assert.deepEqual(f.comments(), []);
    assert.equal(endsOf(f, mid.execution).length, 0, 'the hold has not landed');
    assert.equal(f.gh.labels.has(NEEDS_HUMAN), false);
    assert.equal(f.gh.labels.has(IN_PROGRESS), seeded, 'a seeded in-progress label is kept until the hold lands');

    failing.on = false;
    const second = await run.runTarget(f.options);
    assert.equal(run.runExitCode(second), 2, JSON.stringify(second));
    const final = await loadTicket(f);
    assert.equal(final.execution, mid.execution);
    assert.equal(final.state, 'held');
    assert.equal(f.comments().length, 1, 'exactly one hold comment');
    assert.ok(f.comments()[0].includes(marker.markerComment(open.marker)), 'the comment carries the original Action Marker');
    assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS));
    assert.deepEqual(record.openIntents(final).filter((e) => ['comment', 'label'].includes(e.action)), []);
    const ends = endsOf(f, final.execution);
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0].reason, mid.terminalReason);
    assert.equal(ends[0].run, lastRun(f));
    assert.equal(f.harness.calls.length, agentCalls, 'no agent ran');
    assert.equal(sh(f.worktree, 'status', '--porcelain'), status, 'the worktree is untouched');
    assert.equal(sh(f.worktree, 'rev-parse', 'HEAD'), head, 'nothing was committed or reset');
    assert.equal(f.gh.calls.some((c) => c.args[0] === 'pr'), false, 'no PR was read or published');
    assert.equal(sh(f.mainRoot, 'ls-remote', 'origin', `refs/heads/${BRANCH}`), '', 'nothing was pushed');
  }
});

test('fixing the worktree while a hold comment is pending still finishes the hold', async (t) => {
  for (const seeded of [false, true]) {
    const { f } = await dirtyTicket(t, seeded);
    const agentCalls = f.harness.calls.length;
    const failing = failComment(f);
    assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
    const mid = await loadTicket(f);
    failing.on = false;
    rmSync(join(f.worktree, 'human.txt'));

    assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'the pending hold finishes, not the Ticket');
    const held = await loadTicket(f);
    assert.equal(held.execution, mid?.execution);
    assert.equal(held.state, 'held');
    assert.equal(f.comments().length, 1);
    assert.equal(endsOf(f, held.execution).length, 1);
    assert.equal(f.harness.calls.length, agentCalls, 'no agent ran');

    f.gh.labels.delete(NEEDS_HUMAN);
    const third = await run.runTarget(f.options);
    if (seeded) {
      assert.equal(ticketResult(third).outcome, 'skipped', 'a held Execution with Visits needs its row deleted');
      assert.equal(f.harness.calls.length, agentCalls);
    } else {
      assert.equal(run.runExitCode(third), 0, JSON.stringify(third));
      assert.notEqual((await loadTicket(f)).execution, mid.execution, 'a fresh hold restarts as a new Execution');
      assert.equal(f.harness.calls.length, 2);
    }
  }
});

test('a landed hold comment with a lost response is not posted twice', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const failing = failComment(f, { lost: true });
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.equal(f.comments().length, 1, 'the comment landed before its response was lost');
  failing.on = false;

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the marker found it, so it was not posted again');
  const final = await loadTicket(f);
  const comment = final.log.find((e) => e.step === 'intent' && e.action === 'comment');
  assert.deepEqual(final.log.filter((e) => e.marker === comment.marker).map((e) => e.step), ['intent', 'evidence', 'complete']);
  assert.equal(final.log.find((e) => e.marker === comment.marker && e.step === 'evidence').evidence.id, f.gh.comments[0].id);
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the label lands');
  assert.equal(final.state, 'held');
});

test('an ensureWorktree failure without a record is marked and never retried', async (t) => {
  const f = fixture(t);
  let adds = 0;
  f.options.git = { ...gitModule, ensureWorktree: async () => { adds++; throw new Error('worktree add failed\nfatal: disk full'); } };

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 1);
  assert.match(ticketResult(results).error, /disk full/);
  const rec = await loadTicket(f);
  assert.equal(rec?.state, 'fault', 'the fault is marked on a record created for it');
  assert.equal(rec.branch, BRANCH);
  assert.equal(rec.worktree, f.worktree);
  assert.ok(f.comments().some((b) => b.includes('disk full')), JSON.stringify(f.comments()));
  assert.ok(f.gh.labels.has(NEEDS_HUMAN));
  assert.ok(!f.labelAdds().includes(IN_PROGRESS), 'in-progress is never set');
  const evs = f.readEvents().filter((e) => e.ticket === TICKET);
  assert.deepEqual(evs.map((e) => (e.type === 'action' ? `${e.phase} ${e.ordinal}` : e.type)), ['ticket_start', 'fault 1', 'fault 2', 'ticket_end']);
  assert.ok(evs.every((e) => e.execution === rec.execution));
  assert.match(evs.at(-1).error, /disk full/);
  assert.equal(f.harness.calls.length, 0);

  const second = await run.runTarget(f.options);
  assert.equal(adds, 1, 'the worktree add is never retried');
  assert.equal(ticketResult(second).outcome, 'skipped');
  assert.equal(run.runExitCode(second), 2);
});

test('admission holds emit ticket lifecycle events with their Terminal Reason', async (t) => {
  const ensure = (f) => gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  for (const [hold, arrange] of [
    ['dirty-worktree', async (f) => { await ensure(f); writeFileSync(join(f.worktree, 'notes.txt'), 'mine\n'); }],
    ['merge-conflict', async (f) => { await ensure(f); conflict(f.worktree); }],
    ['branch-mismatch', async (f) => { await ensure(f); sh(f.worktree, 'checkout', '-q', '-b', 'ticket/99-other'); }],
    ['branch-mismatch', async (f) => record.save(record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null,
      flow: { name: 'default', entry: 'implementer' }, configHash: 'x', run: 'seed', worktree: f.worktree, branch: 'ticket/99-other', base: 'main' }))],
  ]) {
    const f = fixture(t);
    await arrange(f);

    const results = await run.runTarget(f.options);
    assert.equal(run.runExitCode(results), 2, `${hold}: ${JSON.stringify(results)}`);
    const rec = await loadTicket(f);
    assert.equal(rec?.terminalReason?.decidedBy.hold, hold);
    assert.equal(rec.state, 'held');
    const evs = f.readEvents().filter((e) => e.ticket === TICKET);
    assert.deepEqual(evs.map((e) => (e.type === 'action' ? `${e.vertex} ${e.phase} ${e.ordinal}` : e.type)),
      ['ticket_start', 'needs-human needs-human 1', 'needs-human needs-human 2', 'ticket_end'], hold);
    assert.ok(evs.every((e) => e.execution === rec.execution && e.run === lastRun(f)), 'one Execution and Run throughout');
    assert.equal(evs.at(-1).outcome, 'needs-human');
    assert.deepEqual(evs.at(-1).reason, rec.terminalReason);
    assert.doesNotMatch(rec.terminalReason.text, /re-run|DELETE FROM/, 'the Terminal Reason is one sentence; the advice is in the comment');
    assert.equal(f.harness.calls.length, 0, 'no agent started');
  }
});

test('a hold label failure leaves its label intent open for the next Run', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const inner = f.gh.gh;
  let failing = true;
  github.setGh(async (args, cwd, input) => {
    if (failing && args[0] === 'issue' && args[1] === 'edit' && args.includes(NEEDS_HUMAN)) {
      f.gh.calls.push({ args, cwd, input });
      throw new Error(`gh issue edit ${args[2]} exited 1\nHTTP 502: Bad Gateway`);
    }
    return inner(args, cwd, input);
  });

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  assert.equal(f.comments().length, 1);
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET));
  const mid = await loadTicket(f);
  assert.deepEqual(record.openIntents(mid ?? { log: [] }).map((e) => e.action), ['label'], 'the label intent stays open');
  assert.equal(endsOf(f, mid.execution).length, 0);

  failing = false;
  assert.equal(run.runExitCode(await run.runTarget(f.options)), 2);
  assert.equal(f.comments().length, 1, 'the landed comment is reused');
  assert.ok(f.gh.labels.has(NEEDS_HUMAN));
  const final = await loadTicket(f);
  assert.deepEqual(record.openIntents(final), []);
  assert.equal(final.state, 'held');
  assert.equal(endsOf(f, final.execution).length, 1);
});

test('human override abandons a pending hold before any label cleanup', async (t) => {
  for (const cleanupFails of [false, true]) {
    const { f, seededRec } = await dirtyTicket(t, true);
    const before = await integrity.snapshot(f.worktree);
    const failing = failComment(f);
    assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
    const mid = await loadTicket(f);
    const [holdComment] = record.openIntents(mid).filter((e) => e.action === 'comment');
    failing.on = false;
    f.gh.labels.add(NEEDS_HUMAN);
    const inner = f.gh.gh;
    const states = [];
    let failEdit = cleanupFails;
    github.setGh(async (args, cwd, input) => {
      if (args[0] === 'issue' && args[1] === 'edit') {
        states.push(JSON.parse(f.loadRow()).state);
        if (failEdit) {
          f.gh.calls.push({ args, cwd, input });
          throw new Error(`gh issue edit ${args[2]} exited 1\nHTTP 502: Bad Gateway`);
        }
      }
      return inner(args, cwd, input);
    });

    let results = await run.runTarget(f.options);
    if (cleanupFails) {
      assert.equal(run.runExitCode(results), 1, JSON.stringify(results));
      assert.equal((await loadTicket(f)).state, 'abandoned');
      assert.equal(endsOf(f, mid.execution).length, 0, 'the abandonment has not landed');
      failEdit = false;
      results = await run.runTarget(f.options);
    }
    assert.equal(run.runExitCode(results), 2, JSON.stringify(results));
    assert.equal(ticketResult(results).outcome, 'abandoned');
    assert.ok(states.length && states.every((s) => s === 'abandoned'), `abandoned before any label cleanup: ${JSON.stringify(states)}`);
    assert.deepEqual(f.comments(), [], 'the pending hold comment is not replayed');
    assert.deepEqual(f.labelAdds(), [], 'no label is added');
    assert.ok(f.gh.labels.has(NEEDS_HUMAN) && !f.gh.labels.has(IN_PROGRESS));
    const final = await loadTicket(f);
    assert.equal(final.state, 'abandoned');
    assert.match(final.terminalReason.text, /needs-human/);
    const ends = endsOf(f, final.execution);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'abandoned');
    assert.deepEqual(ends[0].reason, final.terminalReason);
    assert.ok(record.openIntents(final).some((e) => e.marker === holdComment.marker), 'the hold comment intent stays open, never replayed');
    assert.deepEqual(record.openIntents(final).filter((e) => e.action === 'commit'), record.openIntents(seededRec), 'the older intent is kept');
    assert.deepEqual(final.log.filter((e) => e.step === 'intent' && e.action === 'label').map((e) => e.payload),
      [{ ticket: TICKET, add: [], remove: [IN_PROGRESS] }], 'the cleanup is one write-ahead label Action');
    assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the worktree is untouched');
    assert.equal(f.harness.calls.length, 2, 'no agent ran');
  }
});

test('a pending fault report whose comment lookup fails stays pending and posts no second comment', async (t) => {
  const f = fixture(t);
  f.options.git = { ...gitModule, ensureWorktree: async () => { throw new Error('worktree add failed\nfatal: disk full'); } };
  const inner = f.gh.gh;
  let mode = 'crash';
  github.setGh(async (args, cwd, input) => {
    if (mode === 'crash' && args[0] === 'issue' && args[1] === 'comment') {
      await inner(args, cwd, input);
      throw new interpreter.CrashError('crash after the fault comment landed');
    }
    if (mode === 'lookup' && args[0] === 'api' && /issues\/\d+\/comments$/.test(args.at(-1))) {
      f.gh.calls.push({ args, cwd, input });
      throw new Error('gh api exited 1\nHTTP 502: Bad Gateway');
    }
    return inner(args, cwd, input);
  });

  assert.equal(run.runExitCode(await run.runTarget(f.options)), 1);
  const mid = await loadTicket(f);
  const [open] = record.openIntents(mid ?? { log: [] }).filter((e) => e.action === 'comment');
  assert.ok(open, 'the landed fault comment waits for its completion');
  assert.equal(f.comments().length, 1);

  mode = 'lookup';
  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 1, JSON.stringify(second));
  assert.match(ticketResult(second).error, /HTTP 502/);
  assert.equal(f.comments().length, 1, 'the stored payload is not posted again');
  const still = await loadTicket(f);
  assert.deepEqual(still.terminalReason, mid.terminalReason, 'the fault keeps its Terminal Reason');
  assert.deepEqual(still.terminalStop, mid.terminalStop);
  assert.equal(endsOf(f, mid.execution).length, 0, 'the fault stays pending');

  mode = null;
  const third = await run.runTarget(f.options);
  assert.equal(run.runExitCode(third), 1, 'a fault exits 1');
  assert.equal(f.comments().length, 1, 'the marker found the landed comment');
  const final = await loadTicket(f);
  assert.deepEqual(final.log.filter((e) => e.marker === open.marker).map((e) => e.step), ['intent', 'evidence', 'complete']);
  assert.ok(f.gh.labels.has(NEEDS_HUMAN), 'the label lands');
  assert.equal(final.state, 'fault');
  assert.equal(endsOf(f, final.execution).length, 1);
  assert.match(endsOf(f, final.execution)[0].error, /disk full/);
});

test('a Terminal saved before ticket_end resumes finalization exactly once', async (t) => {
  const { f } = await dirtyTicket(t, false);
  const db = record.openDb(f.commonDir);
  db.exec("CREATE TRIGGER fail_end BEFORE INSERT ON events WHEN NEW.type = 'ticket_end' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const first = await run.runTarget(f.options);
  assert.equal(run.runExitCode(first), 1, JSON.stringify(first));
  const mid = await loadTicket(f);
  assert.equal(mid?.state, 'held', 'the Terminal saved its state before ticket_end');
  assert.equal(endsOf(f, mid.execution).length, 0);
  db.exec('DROP TRIGGER fail_end');
  const effects = () => f.gh.calls.filter((c) => c.args[0] === 'issue' && ['comment', 'edit'].includes(c.args[1])).length;
  const done = effects();

  const second = await run.runTarget(f.options);
  assert.equal(run.runExitCode(second), 2);
  assert.equal(ticketResult(second).outcome, 'needs-human', 'not skipped as finished');
  assert.equal(effects(), done, 'no GitHub effect is repeated');
  assert.equal(endsOf(f, mid.execution).length, 1);
  assert.equal(f.comments().length, 1);
});

test('a human needs-human label before the first Visit prevents admission effects', async (t) => {
  for (const dirty of [false, true]) {
    const f = fixture(t, { labels: [IN_PROGRESS, NEEDS_HUMAN] });
    await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
    const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: 'default', entry: 'implementer' },
      configHash: 'x', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
    await record.save(rec);
    if (dirty) writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
    const before = await integrity.snapshot(f.worktree);

    const results = await run.runTarget(f.options);
    assert.equal(ticketResult(results).outcome, 'abandoned', JSON.stringify(results));
    assert.equal(run.runExitCode(results), 2, 'a human needs-human label exits 2');
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view'], ['issue', 'edit']], 'only the in-progress label is removed');
    assert.deepEqual([...f.gh.labels], [NEEDS_HUMAN], 'the human hold remains without in-progress');
    assert.deepEqual(await integrity.snapshot(f.worktree), before, 'the worktree is untouched');
    if (dirty) assert.equal(readFileSync(join(f.worktree, 'human.txt'), 'utf8'), 'mine\n');
    const final = await record.load(f.commonDir, 'ticket', TICKET);
    assert.equal(final.state, 'abandoned', 'the label overrides the record before any Visit');
    assert.deepEqual(final.visits, {});
    assert.deepEqual(final.log.map((e) => `${e.step} ${e.action}`), ['intent label', 'evidence label', 'complete label'],
      'the cleanup is one write-ahead Action');
    assert.deepEqual(final.log[0].payload, { ticket: TICKET, add: [], remove: [IN_PROGRESS] });
    const evs = f.readEvents().filter((e) => e.ticket === TICKET);
    assert.deepEqual(evs.map((e) => e.type), ['ticket_start', 'action', 'ticket_end']);
    assert.equal(evs.at(-1).outcome, 'abandoned');
    assert.deepEqual(evs.at(-1).reason, final.terminalReason);
  }
});

test('a human needs-human label prevents admission effects without a readable record', async (t) => {
  for (const corrupt of [false, true]) {
    const f = fixture(t, { labels: [NEEDS_HUMAN] });
    if (corrupt) record.openDb(f.commonDir).prepare("INSERT INTO records (kind, n, json) VALUES ('ticket', ?, ?)").run(TICKET, '{');
    const row = f.loadRow();

    assert.equal(run.runExitCode(await run.runTarget(f.options)), 2, 'needs-human exits 2 even without a readable record');
    assert.equal(f.harness.calls.length, 0, 'no agent started');
    assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no label write or comment');
    assert.equal(f.worktrees(), 1, 'no worktree created');
    assert.equal(f.loadRow(), row, 'the record is untouched');
  }
});

test('an interrupted reset under a human needs-human label is abandoned before anything is discarded', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'implementer/1/still-green/1': { files: {}, response: golden.redResponse } };
  const f = fixture(t, { responses, labels: [NEEDS_HUMAN] });
  const exec = { runShell: async () => ({ code: 0, output: golden.GREEN_OUTPUT, timedOut: false }) };
  const git = { ...gitModule, resetTo: async () => { throw new interpreter.CrashError('crash before reset'); } };
  await seedExecution(f, { git, exec });
  f.options.exec = exec;

  await run.runTarget(f.options);
  assert.ok(existsSync(join(f.worktree, 'test', 'add.test.mjs')), "the agent's changes are kept for the human");
  assert.equal((await record.load(f.commonDir, 'ticket', TICKET)).state, 'abandoned', 'the label overrides the record');
  assert.deepEqual(f.labelAdds(), [], 'no label written');
  assert.deepEqual(f.comments(), [], 'no comment posted');
  assert.equal(f.harness.calls.length, 2, 'no agent started');
});

test('a resumed execution still needs its ticket open and unblocked', async (t) => {
  for (const issue of [{ blockedBy: [{ number: 3, state: 'OPEN' }] }, { state: 'CLOSED' }]) {
    const f = fixture(t, { labels: [IN_PROGRESS], issue });
    await seedExecution(f, { crashAt: (r) => ({ marker: markerOf(r, 'implementer', 1, 'green', 4), point: 'before-effect' }) });
    const row = f.loadRow();
    await run.runTarget(f.options);
    assert.equal(f.harness.calls.length, 2, `no agent started for ${JSON.stringify(issue)}`);
    assert.equal(f.loadRow(), row, 'the record is not resumed');
    assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && /not ready/.test(l)), `the skip is logged: ${JSON.stringify(f.logs)}`);
  }
});

test('a flow mixing harnesses runs each vertex on its own harness', async (t) => {
  const responses = { ...structuredClone(golden.firstVisitResponses), 'reviewer/1/review/1': { files: {}, response: {
    claim: 'ok', summary: 'The review says ok.', dodMet: true, tddEvidenceOk: true, findings: [], diagnosis: '' } } };
  const f = fixture(t, { responses, fullFlow: true });
  const other = fakeHarness({ name: 'other', transcriptDir: join(f.root, 'transcripts-other'), responses, capabilities: { cost: false, reasoningTokens: false } });
  f.options.config.nodes.reviewer.harness = 'other';
  f.options.harnesses.other = other;

  const results = await run.runTarget(f.options);
  assert.equal(run.runExitCode(results), 0);
  const vertexOf = (c) => c.marker.split(':')[2];
  assert.deepEqual(f.harness.calls.map(vertexOf), ['implementer', 'implementer'], 'the implementer runs on its own harness');
  assert.deepEqual(other.calls.map(vertexOf), ['reviewer'], 'the reviewer runs on its own harness');
});

test('an in-progress ticket with a recoverable record is resumed', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
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
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
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

test('a corrupt record found at admission is held through reconcile', async (t) => {
  const f = fixture(t, { labels: [IN_PROGRESS] });
  await gitModule.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
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
  assert.equal((await gitModule.repoInfo(f.worktree)).gitCommonDir, f.commonDir);
  assert.ok(existsSync(join(f.mainRoot, '.git', 'gg', 'gg.db')));
  assert.ok(f.comments().every((b) => !b.includes(f.root)), 'no comment exposes a local path');
  assert.ok(f.logs.some((l) => l.includes(f.commonDir)), 'the local log keeps the full diagnostic');
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

for (const kind of ['Check', 'fault']) {
  test(`truncated ${kind} output does not expose fragments of local paths`, async (t) => {
    const f = fixture(t);
    const directory = kind === 'Check' ? f.worktree : f.commonDir;
    const line = `    at Object.<anonymous> (${directory}\\lib\\add.mjs:3:9)`;
    const raw = line + '\n' + 'x'.repeat(3000 - line.length - 1 + line.indexOf(directory) + 1);
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
  const f = fixture(t, { responses });
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

test('Ticket branch names use the public title before slugifying', async (t) => {
  const issue = {};
  const branch = 'ticket/15-add-two-numbers-local';
  const f = fixture(t, { issue, branch });
  issue.title = `Add two numbers ${f.worktree}`;
  const results = await run.runTarget(f.options);
  assert.equal(sh(join(f.root, 'origin.git'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket/'), branch);
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
});

test('a held ticket lock skips the ticket', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, `ticket-${TICKET}`);
  await run.runTarget(f.options);
  // Released before the fixture's cleanup, which Windows refuses while the holder keeps the lock file open.
  await holder.release();
  assert.equal(f.harness.calls.length, 0, 'no agent started');
  assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && /lock/.test(l)), `the skip is logged: ${JSON.stringify(f.logs)}`);
  assert.deepEqual(f.labelAdds(), [], 'no label written');
  assert.deepEqual(f.gh.calls.map((c) => c.args.slice(0, 2)), [['issue', 'view']], 'no repository label setup on a held lock');
  assert.equal(f.worktrees(), 1, 'no worktree');
});

test('every orchestrator git write waits for the repo lock', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, 'repo');
  const called = [];
  const verbs = ['ensureWorktree', 'stageAll', 'writeTree', 'commitStaged', 'commitTree', 'push', 'remoteSha', 'resetTo'];
  const git = run.lockedGit(Object.fromEntries(verbs.map((v) => [v, async () => { called.push(v); }])), f.commonDir);
  const pending = verbs.map((v) => git[v]());
  await sleep(500);
  assert.deepEqual(called, [], 'no write runs while another process holds the repo lock');
  await holder.release();
  await Promise.all(pending);
  assert.deepEqual(called.sort(), [...verbs].sort(), 'every write runs after release');
});

test('an integrity snapshot waits for the repo lock', async (t) => {
  const f = fixture(t);
  const holder = await holdLock(t, f.commonDir, 'repo');
  let settled = false;
  const pending = integrity.snapshot(f.mainRoot).finally(() => { settled = true; });
  await sleep(500);
  assert.equal(settled, false, 'the snapshot writes no object while another process holds the repo lock');
  await holder.release();
  assert.equal((await pending).head, f.base, 'the snapshot runs after release');
});

test('an orchestrator commit waits for the repo lock', async (t) => {
  const f = fixture(t);
  // The competing lock is taken during the red call, after the worktree exists.
  let holder = null;
  const { run: call } = f.harness;
  f.options.harnesses.fake = { ...f.harness, run: async (c) => { holder ??= await holdLock(t, f.commonDir, 'repo'); return call(c); } };
  // The snapshot after the call waits on the holder too, so each commit-path write must itself run inside the repo lock.
  const unlocked = [];
  f.options.git = { ...gitModule, ...Object.fromEntries(['stageAll', 'writeTree', 'commitStaged', 'push', 'remoteSha'].map((v) => [v, async (...args) => {
    const probe = await locks.tryAcquire(f.commonDir, 'repo');
    if (probe) {
      unlocked.push(v);
      await locks.release(probe);
    }
    return gitModule[v](...args);
  }])) };
  const commits = () => {
    const r = spawnSync('git', ['rev-list', '--count', `main..refs/heads/${BRANCH}`], { cwd: f.mainRoot, encoding: 'utf8' });
    return r.status === 0 ? Number(r.stdout.trim()) : 0;
  };
  let settled = false;
  const running = run.runTarget(f.options).finally(() => { settled = true; });
  for (let i = 0; i < 200 && !holder && !settled; i++) await sleep(50);
  assert.ok(holder, 'the red call ran, so the worktree exists');
  await sleep(1000);
  assert.equal(settled, false, 'the run waits while another process holds the repo lock');
  assert.equal(commits(), 0, 'no commit lands while the repo lock is held');
  assert.equal(f.harness.calls.length, 1, 'the run is waiting at the red commit');

  await holder.release();
  const results = await running;
  assert.equal(run.runExitCode(results), 0);
  assert.ok(commits() >= 2, 'the commits land after release');
  assert.deepEqual(unlocked, [], 'every commit-path git write ran inside the repo lock');
});

test('in-progress is set only after the worktree exists', async (t) => {
  const f = fixture(t);
  // A plain directory where the worktree belongs makes ensureWorktree fail.
  mkdirSync(f.worktree, { recursive: true });
  writeFileSync(join(f.worktree, 'stray.txt'), 'not a worktree\n');
  await run.runTarget(f.options).catch(() => {});
  assert.ok(!f.labelAdds().includes(IN_PROGRESS), `in-progress was never added: ${JSON.stringify(f.labelAdds())}`);
  assert.ok(!f.gh.labels.has(IN_PROGRESS));
  assert.equal(f.harness.calls.length, 0);
});

test('a failed label update reaches the log, the event and the exit code', async (t) => {
  const f = fixture(t, { failEdit: true });
  const results = await run.runTarget(f.options);
  assert.ok(f.logs.some((l) => l.includes(`#${TICKET}`) && l.includes('HTTP 502')), `log names the ticket and the error: ${JSON.stringify(f.logs)}`);
  assert.ok(f.readEvents().some((e) => e.type === 'label_failed' && e.ticket === TICKET && e.error.includes('HTTP 502')), 'event names the ticket and the error');
  assert.equal(ticketResult(results).labelFailed, true);
  assert.equal(run.runExitCode(results), 1);
});

test('a crashed ticket keeps the reason from the later lines of the error', async (t) => {
  const f = fixture(t, { responses: { 'implementer/1/red/1': { throw: new Error('git push origin x exited 1\nremote: Permission to o/r denied to u') } } });
  const results = await run.runTarget(f.options);
  assert.match(ticketResult(results).error, /Permission to o\/r denied/);
  assert.match(f.readEvents().find((e) => e.type === 'ticket_end' && e.ticket === TICKET).error, /Permission to o\/r denied/);
  assert.equal(run.runExitCode(results), 1, 'a fault exits 1');
});

test('runExitCode is non-zero when any ticket had a label failure, zero otherwise', () => {
  assert.equal(run.runExitCode([{ ticket: 1, state: 'ready-for-qa' }]), 0);
  assert.notEqual(run.runExitCode([{ ticket: 1, state: 'ready-for-qa', labelFailed: true }]), 0);
  assert.equal(run.runExitCode([{ ticket: 1, state: 'needs-human' }, { ticket: 2, state: 'ready-for-qa', labelFailed: true }]), 1);
  assert.equal(run.runExitCode([{ ticket: 1, state: 'needs-human' }, { ticket: 2, state: 'ready-for-qa' }]), 2);
});

const issue = (number, labels = [], extra = {}) => ({ number, state: 'OPEN', labels: labels.map((name) => ({ name })), ...extra });

test('epicProblem explains an epic with no sub-issues or nothing ready', () => {
  assert.match(run.epicProblem([], []), /no sub-issues/i);
  const busy = [issue(2, [IN_PROGRESS])];
  assert.match(run.epicProblem(busy, []), /nothing ready/i);
  assert.equal(run.epicProblem([issue(3)], [issue(3)]), null);
});
