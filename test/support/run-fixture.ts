// The `gg run` fixture: a temp origin and clone (on the fake git unless a case asks for real git by name), the fake gh
// answering one standalone Ticket, and the fake harness, with the options runTarget takes. `fixture` builds it and runs
// nothing; a case calls run.runTarget(f.options).
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as config from '../../lib/config.ts';
import * as events from '../../lib/events.ts';
import * as gitModule from '../../lib/git.ts';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as model from '../../lib/model.ts';
import type * as runModule from '../../lib/run.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as record from '../../lib/record.ts';
import * as validate from '../../lib/validate/index.ts';
import * as addSuite from './add-suite.ts';
import * as caseDatabase from './case-database.ts';
import * as executionContext from './execution-context.ts';
import * as exampleLayer from './example-layer.ts';
import * as executionReads from './execution-reads.ts';
import * as fakeGh from './fake-gh.ts';
import * as fakeHarnessModule from './fake-harness.ts';
import * as gitShell from './git-shell.ts';
import * as golden from './golden.ts';
import * as shippedFlow from './shipped-flow.ts';
import * as tempDirectory from './temp-directory.ts';

export { BRANCH, TICKET } from './golden.ts';
const { BRANCH, TICKET } = golden;

type Repository = config.Source & {
  agents: Record<string, Record<string, unknown>>;
  flows: Record<string, golden.ConfiguredFlow>;
  procedures: Record<string, { actions: { id: string; [key: string]: unknown }[] }>;
};
// The fixture's two sources: the repository's, and the user's with its machine settings.
interface Configuration extends config.Configuration {
  repository: Repository;
  user: config.Source & { maxParallel: number; worktreeRoot: string };
}

// The repository source gg shipped until #120 with every Agent on `harness`, its test command and, unless `fullFlow`,
// a red, green and publish Flow to ready-for-qa, whose publish reads green's report and evidence.
export function testConfig(_root: string, { harness = 'fake', fullFlow = false } = {}): Repository {
  const { maxParallel: _maxParallel, worktreeRoot: _worktreeRoot, ...configured } = shippedFlow.shippedLayer();
  const repository = configured as unknown as Repository;
  repository.commands = { test: 'npm test' };
  repository.testPaths = [...exampleLayer.TEST_GLOBS];
  for (const agent of Object.values(repository.agents))
    Object.assign(agent, { harness, model: 'model-x', effort: 'high' });
  if (!fullFlow) {
    const shipped = repository.flows.default as golden.ConfiguredFlow;
    const { routes, vertices } = shipped.ticket;
    shipped.ticket = {
      entry: 'red',
      routes,
      vertices: {
        red: { use: 'implementer', procedure: 'tests-fail', route: { ok: 'green' } },
        green: { use: 'implementer', procedure: 'implement', inputs: vertices.green?.inputs, route: { ok: 'publish' } },
        publish: {
          procedure: 'publish',
          inputs: golden.implementationInputs(['green']),
          route: { ok: { end: 'ready-for-qa' } },
        },
      },
    };
  }
  return repository;
}

export interface RunFixtureOptions {
  responses?: fakeHarnessModule.ScriptedResponses;
  // Every label edit fails as gh does.
  failEdit?: boolean;
  failCreate?: boolean;
  repoLabels?: string[];
  labels?: string[];
  branch?: string;
  harness?: string;
  fullFlow?: boolean;
  // Overrides fields of every issue view, and of one issue number's.
  issue?: Record<string, unknown>;
  issues?: Record<string, Record<string, unknown>>;
  rootName?: string;
  // Every path gg is given goes through a junction, as through a symlinked TMPDIR or a Windows 8.3 name.
  linked?: boolean;
  integrity?: golden.Which;
  git?: golden.Which;
}

// The fake gh answering one standalone Ticket: its issue view has the fixture Ticket's title and body.
function ticketGh(mainRoot: string, git: runContext.RunGit, options: RunFixtureOptions) {
  const {
    branch = BRANCH,
    repoLabels,
    labels = [],
    issue = {},
    issues = {},
    failEdit = false,
    failCreate = false,
  } = options;
  const headOf = (head: string) => git.remoteSha(mainRoot, head);
  const fake = fakeGh.fakeGh({ branch, ticket: TICKET, repoLabels, headOf });
  for (const label of labels) fake.labels.add(label);
  fake.gh = fakeGh.ghThrough(fake, async (call, next) => {
    const [noun, verb, number] = call.args;
    if (noun === 'issue' && verb === 'view') {
      fake.calls.push(call);
      return JSON.stringify({
        number: Number(number),
        title: 'Add two numbers',
        body: 'Add `add(a, b)`.',
        state: 'OPEN',
        labels: [...fake.labelsOf(Number(number))].map((name) => ({ name })),
        blockedBy: [],
        subIssues: [],
        ...issue,
        ...issues[number as string],
      });
    }
    if (failEdit && noun === 'issue' && verb === 'edit') {
      fake.calls.push(call);
      throw new Error(`gh issue edit ${number} exited 1\nHTTP 502: Bad Gateway`);
    }
    if (failCreate && noun === 'label' && verb === 'create') {
      fake.calls.push(call);
      throw new Error('HTTP 403: label creation denied');
    }
    return next();
  });
  return fake;
}

// No heartbeat fires: a Run's tests do not look at one.
function runClock() {
  const time = { now: Date.parse('2026-10-17T00:00:00Z') };
  return {
    now: () => time.now,
    sleep: async (ms: number) => {
      time.now += ms;
    },
    every: () => () => {},
  };
}

// A root under the temp directory, or a junction to it when `linked`. git and the State Database live under it.
function fixtureRoot(t: TestContext, { rootName = 'gg-run-', linked = false }: RunFixtureOptions) {
  const linkOf = (real: string) => (linked ? `${real}-link` : real);
  const real = tempDirectory.tempDirectory(t, rootName, (directory) => join(linkOf(directory), 'main', '.git'));
  const root = linkOf(real);
  if (linked) {
    symlinkSync(real, root, 'junction');
    t.after(() => rmSync(root, { recursive: true, force: true })); // removes the link, not its target
  }
  return { real, root };
}

// The repository's source testConfig gives, and a user source with the machine settings and no Flow.
const fixtureSources = (
  root: string,
  mainRoot: string,
  options: { harness?: string; fullFlow?: boolean },
): Configuration => ({
  repository: testConfig(root, options),
  user: { maxParallel: 2, worktreeRoot: join(root, 'wt'), files: {} },
  repositoryFile: join(mainRoot, '.agents', 'gg', 'gg.json'),
  userFile: join(root, 'home', 'gg.json'),
});

// git is the fake unless the case asks for real git by name.
export function fixture(t: TestContext, fixtureOptions: RunFixtureOptions = {}) {
  const { responses = golden.firstVisitResponses, harness: harnessName, fullFlow } = fixtureOptions;
  const { integrity = 'fake', git: which = 'fake' } = fixtureOptions;
  const { real, root } = fixtureRoot(t, fixtureOptions);
  const mainRoot = join(root, 'main');
  const commonDir = join(mainRoot, '.git');
  const { base, git, fakeGit } = golden.seedGit(real, which);
  const fakeIntegrity = golden.fakeIntegrityFor(integrity, base, git);
  const gh = ticketGh(mainRoot, git, fixtureOptions);
  const harness = golden.goldenHarness(join(root, 'transcripts'), responses);
  const logs: string[] = [];
  const clock = runClock();
  const configured = fixtureSources(root, mainRoot, { harness: harnessName, fullFlow });
  const worktree = gitModule.worktreePath(configured.user.worktreeRoot, 'main', TICKET);
  const exec = addSuite.addSuite({ worktree });
  const options = {
    target: TICKET,
    config: configured,
    harnesses: { fake: harness } as Record<string, unknown>,
    protectedPaths: golden.PROTECTED_PATHS,
    deps: {
      gh: github.createGh(gh.gh),
      git,
      exec,
      database: caseDatabase.caseDatabase(t),
      clock,
      ...(fakeIntegrity && { integrity: fakeIntegrity.integrity }),
    } as runContext.Deps,
    cwd: mainRoot,
    log: (line: string): void => {
      logs.push(line);
    },
    ...(fakeIntegrity && { testImmutability: fakeIntegrity.testImmutability }),
  } satisfies runModule.RunOptions;
  return {
    root,
    real,
    mainRoot,
    commonDir,
    base,
    worktree,
    gh,
    harness,
    exec,
    logs,
    clock,
    options,
    fakeGit,
    readEvents: () => events.readEvents(commonDir),
    worktrees: () =>
      fakeGit ? fakeGit.worktreeCount(mainRoot) : gitShell.sh(mainRoot, 'worktree', 'list').split('\n').length,
    loadRow: () => caseDatabase.savedJson(commonDir, 'ticket', TICKET),
    comments: () => gh.comments.filter((comment) => comment.number === TICKET).map((comment) => comment.body),
    labelAdds: () =>
      gh.calls
        .filter((call) => call.args[0] === 'issue' && call.args[1] === 'edit')
        .flatMap((call) => call.args.filter((_, i) => call.args[i - 1] === '--add-label')),
  };
}

// The `gg run` fixture: `options` is what runTarget takes, and `options.deps.git` the git gg is given; `fakeGit` holds
// the fake git's own verbs and the steps a human takes outside gg (null on real git).
export type RunFixture = ReturnType<typeof fixture>;

// An Execution of the fixture's Ticket run straight through the interpreter, as an earlier Run left it.
export async function seedExecution(
  runFixture: RunFixture,
  {
    git = runFixture.options.deps.git,
    crashAt,
    exec = runFixture.exec,
    integrity = runFixture.options.deps.integrity,
  }: {
    git?: runContext.RunGit;
    crashAt?: (executionRecord: record.ExecutionRecord) => runContext.ExecutionOptions['crashAt'];
    exec?: runContext.Deps['exec'];
    integrity?: runContext.Deps['integrity'];
  } = {},
) {
  const { mainRoot, worktree, commonDir, options } = runFixture;
  await git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  const configured = options.config.repository;
  const flows = validate.validate(configured, {
    harnesses: options.harnesses,
    readSchema: (name: string) => JSON.parse(config.namedFile(configured.files, name)),
    readTemplate: (name: string) => config.namedFile(configured.files, name),
  }).flows as Record<string, unknown>;
  const flow = model.fromJson(flows.default);
  const executionRecord = record.createExecutionRecord({
    commonDir,
    ticket: TICKET,
    epic: null,
    flow: { name: flow.name, entry: flow.ticket.entry as string },
    configHash: 'cfg-hash',
    run: '20261016T000000Z-seed00',
    worktree,
    branch: BRANCH,
    base: 'main',
  });
  const database = options.deps.database as record.StateDatabase;
  database.save(executionRecord);
  await assert.rejects(
    interpreter.runExecution({
      deps: { gh: options.deps.gh, git, exec, database, clock: runFixture.clock, integrity },
      flow,
      record: executionRecord,
      harness: runFixture.harness as unknown as runContext.Harness,
      events: events.eventLog(commonDir, {}, database),
      log: () => {},
      cwd: mainRoot,
      commands: { test: 'npm test' },
      testPaths: [...exampleLayer.TEST_GLOBS],
      ticket: { number: TICKET, title: 'Add two numbers', body: 'Add `add(a, b)`.', branch: BRANCH },
      base: 'main',
      labelPrefix: 'gg',
      others: [],
      crashAt: crashAt?.(executionRecord),
      testImmutability: options.testImmutability,
      protectedPaths: options.protectedPaths,
      files: options.config.repository.files,
    }),
    (err) => err instanceof interpreter.CrashError,
  );
  return executionReads.loadTicket(runFixture);
}

// The green commit was intended, its implementation staged, and the process died before the commit landed.
export const crashBeforeCommit = (runFixture: RunFixture) =>
  seedExecution(runFixture, {
    crashAt: (executionRecord) => ({
      marker: golden.markerOf(executionRecord, 'green', 1, 'commit', 0),
      point: 'before-effect',
    }),
  });

// green's push was intended, and the process died before it was made.
export const crashBeforePush = (runFixture: RunFixture) =>
  seedExecution(runFixture, {
    crashAt: (executionRecord) => ({
      marker: golden.markerOf(executionRecord, 'green', 1, 'push', 0),
      point: 'before-effect',
    }),
  });

// A merge conflict left in the worktree: conflict.txt at stages 1 to 3 with the markers on disk. git write-tree refuses
// such an index, so the snapshot cannot fingerprint it.
export function conflict(worktree: string) {
  const blob = (text: string) => gitShell.sh(worktree, 'hash-object', '-w', '--stdin', { input: text });
  const stages = ['base\n', 'ours\n', 'theirs\n'].map((text, i) => `100644 ${blob(text)} ${i + 1}\tconflict.txt`);
  gitShell.sh(worktree, 'update-index', '--index-info', { input: `${stages.join('\n')}\n` });
  writeFileSync(join(worktree, 'conflict.txt'), '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n');
  return {
    unmerged: gitShell.sh(worktree, 'ls-files', '-u'),
    bytes: readFileSync(join(worktree, 'conflict.txt'), 'utf8'),
  };
}

// A worktree with a human file: fresh, or the worktree of an Execution whose commit was interrupted (with its Visits).
// The real integrity over the fake git sees the file on disk without running git.
export async function dirtyTicket(t: TestContext, seeded: boolean) {
  const runFixture = fixture(t, {
    labels: seeded ? [executionContext.IN_PROGRESS_LABEL] : [],
    integrity: 'real',
    git: 'fake',
  });
  const seededRecord = seeded ? await crashBeforeCommit(runFixture) : null;
  if (!seeded) {
    const { mainRoot, worktree } = runFixture;
    await runFixture.options.deps.git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  }
  writeFileSync(join(runFixture.worktree, 'human.txt'), 'mine\n');
  return { runFixture, seededRecord };
}

export const ticketResult = <Result extends { ticket: number }>(results: Result[]) =>
  results.find((result) => result.ticket === TICKET);
export const endsOf = (runFixture: RunFixture, execution: string) =>
  runFixture
    .readEvents()
    .filter((event): event is events.TicketEndEvent => event.type === 'ticket_end' && event.execution === execution);
export const lastRun = (runFixture: RunFixture) =>
  runFixture.readEvents().findLast((event) => event.type === 'run_start')?.run;

// Makes every comment POST fail with HTTP 502 while `on` is set, its retries too; `lost` lets the comment land first,
// as a lost response does.
export function failComment(runFixture: RunFixture, { lost = false } = {}) {
  const failing = { on: true };
  const transport = fakeGh.ghThrough(runFixture.gh, async (call, next) => {
    if (!failing.on || !fakeGh.isCommentPost(call.args)) return next();
    if (lost) await next();
    else runFixture.gh.calls.push(call);
    throw fakeGh.ghError(call.args, { status: 502 });
  });
  runFixture.options.deps.gh = github.createGh(transport);
  return failing;
}

// Makes every needs-human label edit fail as gh does while `on` is set.
export function failHoldLabel(runFixture: RunFixture) {
  const failing = { on: true };
  const transport = fakeGh.ghThrough(runFixture.gh, async (call, next) => {
    const [noun, verb, number] = call.args;
    if (!failing.on || noun !== 'issue' || verb !== 'edit' || !call.args.includes(executionContext.NEEDS_HUMAN_LABEL))
      return next();
    runFixture.gh.calls.push(call);
    throw new Error(`gh issue edit ${number} exited 1\nHTTP 502: Bad Gateway`);
  });
  runFixture.options.deps.gh = github.createGh(transport);
  return failing;
}

// Every gh call passes through `hook` first.
export function hookGh(runFixture: RunFixture, hook: (args: string[]) => unknown) {
  const transport = fakeGh.ghThrough(runFixture.gh, async ({ args }, next) => {
    await hook(args);
    return next();
  });
  runFixture.options.deps.gh = github.createGh(transport);
}
