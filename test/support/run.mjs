// Helpers the run test files share.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as checks from '../../lib/checks.mjs';
import * as config from '../../lib/config.mjs';
import * as events from '../../lib/events.mjs';
import * as flowModule from '../../lib/flow.mjs';
import * as gitModule from '../../lib/git.mjs';
import * as github from '../../lib/github.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import { pathKey } from '../../lib/paths.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from './golden.mjs';
import { fakeHarness } from './fake-harness.mjs';

export const contender = fileURLToPath(new URL('./lock-contender.mjs', import.meta.url));
export const TICKET = golden.TICKET;
export const BRANCH = golden.BRANCH;
export const IN_PROGRESS = 'gg:state:in-progress';
export const NEEDS_HUMAN = 'gg:state:needs-human';
export const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// The shipped defaults with every Agent on `harness`, the repository Layer's test command and, unless `fullFlow`, a
// red, green and publish Flow to ready-for-qa.
export function testConfig(root, { harness = 'fake', fullFlow = false } = {}) {
  const c = config.loadDefaults();
  c.commands = { test: 'npm test' };
  c.testPaths = [...checks.DEFAULT_TEST_GLOBS];
  for (const agent of Object.values(c.agents)) Object.assign(agent, { harness, model: 'model-x', effort: 'high' });
  c.worktreeRoot = join(root, 'wt');
  if (!fullFlow) {
    const { routes, vertices: shipped } = c.flows.default.ticket;
    c.flows.default.ticket = { entry: 'red', routes, vertices: {
      red: { use: 'implementer', procedure: 'tests-fail', route: { ok: 'green' } },
      green: { use: 'implementer', procedure: 'implement', inputs: shipped.green.inputs, route: { ok: 'publish' } },
      publish: { procedure: 'publish', inputs: shipped.publish.inputs, route: { ok: { end: 'ready-for-qa' } } } } };
  }
  return c;
}

// A temp origin and clone, a fake gh at lib/github.mjs's seam answering one standalone Ticket, and the
// fake harness. `failEdit` makes every label edit fail as gh does; `issue` overrides fields of the issue view, and `issues`
// those of one issue number.
// git is the fake unless `git` or `integrity` is 'real'.
export function fixture(t, { responses = golden.firstVisitResponses, failEdit = false, failCreate = false, repoLabels, labels = [], branch = BRANCH, harness: harnessName, fullFlow, issue = {}, issues = {}, rootName = 'gg-run-', linked = false, integrity, git: which = integrity === 'real' ? 'real' : 'fake' } = {}) {
  // linked: every path gg is given goes through a junction, as through a symlinked TMPDIR or a Windows 8.3 name.
  const real = mkdtempSync(join(tmpdir(), rootName));
  const root = linked ? `${real}-link` : real;
  if (linked) symlinkSync(real, root, 'junction');
  const mainRoot = join(root, 'main');
  const commonDir = join(mainRoot, '.git');
  t.after(() => {
    record.close(commonDir);
    if (linked) rmSync(root, { recursive: true, force: true }); // removes the link, not its target
    rmSync(real, { recursive: true, force: true });
  });
  const { base, git, fakeGit } = golden.seedGit(real, which);
  const fakeIntegrity = golden.fakeOf(integrity, base);

  const fake = golden.fakeGh({ branch, repoLabels, headOf: (b) => git.remoteSha(mainRoot, b) });
  for (const l of labels) fake.labels.add(l);
  const inner = fake.gh;
  fake.gh = async (args, cwd, input) => {
    const [noun, verb] = args;
    if (noun === 'issue' && verb === 'view') {
      fake.calls.push({ args, cwd, input });
      return JSON.stringify({ number: Number(args[2]), title: 'Add two numbers', body: 'Add `add(a, b)`.', state: 'OPEN',
        labels: [...fake.labelsOf(Number(args[2]))].map((name) => ({ name })), blockedBy: [], subIssues: [], ...issue, ...issues[args[2]] });
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
  const previousGh = github.setGh(fake.gh);
  t.after(() => github.setGh(previousGh));

  const harness = fakeHarness({ transcriptDir: join(root, 'transcripts'), responses, capabilities: { cost: false, reasoningTokens: false } });
  const exec = {
    runShell: async (command, opts) => existsSync(join(opts.cwd, 'lib', 'add.mjs'))
      ? { code: 0, output: golden.GREEN_OUTPUT, timedOut: false } : { code: 1, output: golden.RED_OUTPUT, timedOut: false },
  };
  const logs = [];
  let now = Date.parse('2026-10-17T00:00:00Z');
  // No heartbeat fires: a Run's tests do not look at one.
  const clock = { now: () => now, sleep: async (ms) => { now += ms; }, every: () => () => {} };
  const cfg = testConfig(root, { harness: harnessName, fullFlow });
  const worktree = gitModule.worktreePath(cfg.worktreeRoot, 'main', TICKET);
  const options = { target: TICKET, config: cfg, harnesses: { fake: harness }, protectedPaths: golden.PROTECTED_PATHS, gh: github, git, exec, cwd: mainRoot,
    log: (m) => logs.push(m), clock, ...golden.injected(fakeIntegrity) };
  return {
    root, real, mainRoot, commonDir, base, worktree, gh: fake, harness, exec, logs, clock, options, fakeGit,
    readEvents: () => events.readEvents(commonDir),
    worktrees: () => (fakeGit ? fakeGit.worktreeCount(mainRoot) : sh(mainRoot, 'worktree', 'list').split('\n').length),
    loadRow: () => record.openDb(commonDir).prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?").get(TICKET)?.json,
    comments: () => fake.comments.filter((c) => c.number === TICKET).map((c) => c.body),
    labelAdds: () => fake.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit')
      .flatMap((c) => c.args.filter((a, i) => c.args[i - 1] === '--add-label')),
  };
}

// An Execution of the fixture's Ticket run straight through the interpreter, as an earlier Run left it.
export async function seedExecution(f, { git = f.options.git, crashAt, exec = f.exec, integrity = f.options.integrity } = {}) {
  await git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  const flow = flowModule.resolveFlow(f.options.config);
  const rec = record.createExecution({ commonDir: f.commonDir, ticket: TICKET, epic: null, flow: { name: flow.name, entry: flow.ticket.entry },
    configHash: 'cfg-hash', run: '20261016T000000Z-seed00', worktree: f.worktree, branch: BRANCH, base: 'main' });
  await record.save(rec);
  await assert.rejects(interpreter.runExecution({
    flow, record: rec, harness: f.harness, gh: github, git, exec, events: events.eventLog(f.commonDir), log: () => {}, cwd: f.mainRoot,
    commands: { test: 'npm test' }, testPaths: [...checks.DEFAULT_TEST_GLOBS], ticket: { number: TICKET, title: 'Add two numbers', body: 'Add `add(a, b)`.', branch: BRANCH },
    base: 'main', labelPrefix: 'gg', others: [], clock: f.clock, crashAt: crashAt?.(rec),
    integrity, testImmutability: f.options.testImmutability, protectedPaths: f.options.protectedPaths,
  }), (err) => err instanceof interpreter.CrashError);
  return record.load(f.commonDir, 'ticket', TICKET);
}

// Spawns a process holding the lock `name`, resolving once it reports its handle; killing it releases the lock. By
// default it holds longer than any case, so only the case releases it.
export function holdLock(t, commonDir, name, holdMs = 600_000) {
  const child = spawn(process.execPath, [contender, commonDir, name, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
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

export const ticketResult = (results) => results.find((r) => r.ticket === TICKET);

// A merge conflict left in the worktree: conflict.txt at stages 1 to 3 with the markers on disk. git write-tree refuses
// such an index, so the snapshot cannot fingerprint it.
export function conflict(worktree) {
  const blob = (text) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: worktree, input: text, encoding: 'utf8' }).trim();
  const stages = ['base\n', 'ours\n', 'theirs\n'].map((text, i) => `100644 ${blob(text)} ${i + 1}\tconflict.txt`);
  execFileSync('git', ['update-index', '--index-info'], { cwd: worktree, input: `${stages.join('\n')}\n` });
  writeFileSync(join(worktree, 'conflict.txt'), '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n');
  return { unmerged: sh(worktree, 'ls-files', '-u'), bytes: readFileSync(join(worktree, 'conflict.txt'), 'utf8') };
}

// The green commit was intended, its implementation staged, and the process died before the commit landed.
export const crashBeforeCommit = (f) => seedExecution(f, { crashAt: (r) => ({ marker: golden.markerOf(r, 'green', 1, 'commit', 0), point: 'before-effect' }) });

// Makes every comment POST fail with HTTP 502 while `on` is set, its retries too; `lost` lets the comment land first, as
// a lost response does.
export function failComment(f, { lost = false } = {}) {
  const inner = f.gh.gh;
  const failing = { on: true };
  github.setGh(async (args, cwd, input) => {
    if (failing.on && golden.isCommentPost(args)) {
      if (lost) await inner(args, cwd, input);
      else f.gh.calls.push({ args, cwd, input });
      throw golden.ghError(args, { status: 502 });
    }
    return inner(args, cwd, input);
  });
  return failing;
}
export const endsOf = (f, execution) => f.readEvents().filter((e) => e.type === 'ticket_end' && e.execution === execution);
export const lastRun = (f) => f.readEvents().findLast((e) => e.type === 'run_start').run;
export const loadTicket = (f) => record.load(f.commonDir, 'ticket', TICKET);

// A worktree with a human file: fresh, or the worktree of an Execution whose commit was interrupted (with its Visits).
// The real integrity over the fake git sees the file on disk without running git.
export async function dirtyTicket(t, seeded) {
  const f = fixture(t, { labels: seeded ? [IN_PROGRESS] : [], integrity: 'real', git: 'fake' });
  const seededRec = seeded ? await crashBeforeCommit(f) : null;
  if (!seeded) await f.options.git.ensureWorktree({ mainRoot: f.mainRoot, path: f.worktree, branch: BRANCH, base: 'main' });
  writeFileSync(join(f.worktree, 'human.txt'), 'mine\n');
  return { f, seededRec };
}

export function failHoldLabel(f) {
  const inner = f.gh.gh;
  const failing = { on: true };
  github.setGh(async (args, cwd, input) => {
    if (failing.on && args[0] === 'issue' && args[1] === 'edit' && args.includes(NEEDS_HUMAN)) {
      f.gh.calls.push({ args, cwd, input });
      throw new Error(`gh issue edit ${args[2]} exited 1\nHTTP 502: Bad Gateway`);
    }
    return inner(args, cwd, input);
  });
  return failing;
}

export const EPIC = 20;

// The issue views of an epic whose sub-issues are `children`, with `extra` overriding single issues.
export const epicOf = (children, extra = {}) => ({ [EPIC]: { title: 'An epic', subIssues: children.map((number) => ({ number })) }, ...extra });

export const worktreeOf = (f, n) => gitModule.worktreePath(f.options.config.worktreeRoot, 'main', n);
export const addsLabel = (args, n, label) => args[0] === 'issue' && args[1] === 'edit' && args[2] === String(n)
  && args.some((a, i) => a === label && args[i - 1] === '--add-label');

// Opened once. A broken interleaving fails at its case's timeout; a shorter bound of its own failed correct
// interleavings whenever the machine was loaded enough that the other Ticket's whole Execution outlasted it.
export function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, wait: () => opened };
}

// One fake Harness per Ticket behind the name `fake`, chosen by the worktree each call runs in; `before` runs first.
export function ticketHarnesses(f, tickets, { responses = {}, before = async () => {} } = {}) {
  const fakes = Object.fromEntries(tickets.map((n) => [n, fakeHarness({ transcriptDir: join(f.root, 'transcripts', String(n)),
    responses: responses[n] ?? golden.firstVisitResponses, capabilities: { cost: false, reasoningTokens: false } })]));
  const ticketOf = (cwd) => tickets.find((n) => pathKey(cwd) === pathKey(worktreeOf(f, n)));
  f.options.harnesses.fake = { ...fakes[tickets[0]], run: async (call) => {
    const n = ticketOf(call.cwd);
    await before(n, call);
    return fakes[n].run(call);
  } };
  return fakes;
}

// Every gh call passes through `hook` first.
export function hookGh(f, hook) {
  const inner = f.gh.gh;
  github.setGh(async (args, cwd, input) => {
    await hook(args);
    return inner(args, cwd, input);
  });
}
