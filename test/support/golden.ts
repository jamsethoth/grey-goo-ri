// The golden-trace fixture: a temp origin and clone with a ticket worktree (on the fake git unless a case asks for real
// git by name), the fake gh, a fake test runner, the fake harness, and every harness, test, git and gh call tagged with
// the activity it observed. `fixture` builds it and runs nothing; test/support/golden-run.ts runs it.
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as checks from '../../lib/checks.ts';
import * as config from '../../lib/config.ts';
import * as events from '../../lib/events.ts';
import * as gitModule from '../../lib/git.ts';
import * as github from '../../lib/github.ts';
import * as shipped from '../../lib/harnesses/shipped.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as validate from '../../lib/validate/index.ts';
import * as addSuiteModule from './add-suite.ts';
import * as caseDatabase from './case-database.ts';
import * as fakeGhModule from './fake-gh.ts';
import * as fakeGitModule from './fake-git.ts';
import * as fakeHarnessModule from './fake-harness.ts';
import * as fakeIntegrityModule from './fake-integrity.ts';
import * as gitShell from './git-shell.ts';
import * as keys from './keys.ts';
import * as tempDirectory from './temp-directory.ts';
import * as templateRepos from './template-repos.ts';

export const TICKET = 15;
export const BRANCH = 'ticket/15-add-two-numbers';
export { GREEN_FAIL_OUTPUT, GREEN_OUTPUT, RED_OUTPUT, TEST_NAME } from './add-suite.ts';
export const PERSONA = '# implementer\nWrite the smallest change.\n';
// A Layer file as loadLayers loads it.
export const layerFile = (bytes: string) => ({ bytes, hash: createHash('sha256').update(bytes).digest('hex') });

export const redResponse = {
  claim: 'ok',
  summary: 'Failing test for add.',
  tests: [addSuiteModule.TEST_NAME],
  notes: 'add does not exist yet',
  diagnosis: '',
};

export const greenResponse = {
  claim: 'ok',
  summary: 'Add two numbers.',
  definitionOfDone: [{ item: 'add returns the sum', met: true, evidence: 'test/add.test.mjs' }],
  qa: {
    setup: 'npm test',
    steps: [{ action: 'run npm test', expected: 'it passes' }],
    edgeCases: ['negative numbers'],
    automated: ['adds two numbers'],
    manual: [],
  },
  diagnosis: '',
  notes: '',
};

export const firstVisitResponses: fakeHarnessModule.ScriptedResponses = {
  [keys.responseKey('red', 1, 'red', 1)]: {
    files: { 'test/add.test.mjs': "import { add } from '../lib/add.mjs';\n" },
    response: redResponse,
    result: { usage: { delta: { inputTokens: 100, outputTokens: 20 } } },
  },
  [keys.responseKey('green', 1, 'green', 1)]: {
    files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' },
    response: greenResponse,
    result: { usage: { delta: { inputTokens: 200, outputTokens: 40 } } },
  },
};

// The Agent every golden Vertex but a reviewer uses.
export const implementerAgent = (persona: string) => ({
  harness: 'fake',
  model: 'model-x',
  effort: 'high',
  persona,
  skills: [],
  mcp: [],
  plugins: [],
  access: 'workspace-write',
  network: false,
});

// The inputs the shipped Flow declares: green reads red's committed tests and Red Evidence; a reviewer or publish reads
// the latest implementation report and Green Evidence across the implementing Vertices, and the Red Evidence.
export const GREEN_INPUTS = { testFiles: { from: 'red.commit.files' }, red: { from: 'red.red-check.evidence' } };
export const implementationInputs = (vertices: string[]) => ({
  report: { from: vertices.map((vertex) => `${vertex}.${vertex === 'green' ? 'green' : 'fix'}.response`) },
  red: { from: 'red.red-check.evidence' },
  green: { from: vertices.map((vertex) => `${vertex}.test.evidence`) },
});

// A Flow as a case edits it in the configuration, before the validator resolves it.
export interface ConfiguredFlow {
  actionCap: number;
  ticket: { entry: string; routes: Record<string, unknown>; vertices: Record<string, Record<string, unknown>> };
}

// A red, green and publish Flow: red's tests-fail Visit, green's implement Visit, then publish's Visit, which has no
// Agent, to ready-for-qa. A misscoped Claim reaches the planner through the Flow's routes, as in the shipped Flow.
export const redGreenFlow = (): ConfiguredFlow => ({
  actionCap: 180,
  ticket: {
    entry: 'red',
    routes: { misscoped: { end: 'needs-replan' }, '*': { end: 'needs-human' } },
    vertices: {
      red: { use: 'implementer', procedure: 'tests-fail', route: { ok: 'green' } },
      green: { use: 'implementer', procedure: 'implement', inputs: GREEN_INPUTS, route: { ok: 'publish' } },
      publish: {
        procedure: 'publish',
        inputs: implementationInputs(['green']),
        route: { ok: { end: 'ready-for-qa' } },
      },
    },
  },
});

export interface GoldenConfig {
  commands: Record<string, string>;
  testPaths: string[];
  agents: Record<string, ReturnType<typeof implementerAgent>>;
  procedures: Record<string, { actions: { id: string; [key: string]: unknown }[]; [key: string]: unknown }>;
  flows: Record<string, ConfiguredFlow>;
  files: config.LayerFiles;
}

// The golden configuration: the shipped Procedures and their files, the implementer on the fake Harness with the golden
// Persona, the repository's commands and test paths, and the golden Flow.
export function goldenConfig(): GoldenConfig {
  const defaults = config.loadDefaults();
  return {
    commands: { test: 'npm test' },
    testPaths: [...checks.DEFAULT_TEST_GLOBS],
    agents: { implementer: implementerAgent('implementer.md') },
    procedures: defaults.procedures as GoldenConfig['procedures'],
    flows: { golden: redGreenFlow() },
    files: { ...defaults.files, 'implementer.md': layerFile(PERSONA) },
  };
}

// The configuration's one Flow as admission resolves it; a configuration the validator rejects fails the case.
export function resolve(goldenConfiguration: GoldenConfig): runContext.RunFlow {
  const { flows, errors } = validate.validate(goldenConfiguration, {
    harnesses: { fake: {} },
    readSchema: (name: string) => JSON.parse(config.layerFile(goldenConfiguration.files, name)),
    readTemplate: (name: string) => config.layerFile(goldenConfiguration.files, name),
  });
  if (errors.length) {
    const listed = errors.map((problem) => `${problem.at}: ${problem.message}`).join('\n');
    throw new Error(`the golden configuration is invalid:\n${listed}`);
  }
  return Object.values(flows)[0] as unknown as runContext.RunFlow;
}

// Reduces Action Events to what a golden trace asserts.
export const trace = (traced: events.Event[]) =>
  traced
    .filter((event): event is events.ActionEvent => event.type === 'action')
    .map(({ vertex, action, recovery, attempt, outcome }) => ({ vertex, action, recovery, attempt, outcome }));

// Where an Attempt is, in the Action Marker's part order: its Vertex, Visit and Action, its recovery pass and attempt.
export type MarkerPlace = [vertex: string, visit: number, action: string, recovery?: number, attempt?: number];

// The Action Marker of an Attempt of the record's Execution, in the Run that wrote it.
export const markerOf = (
  executionRecord: Pick<record.ExecutionRecord, 'execution' | 'run'>,
  ...[vertex, visit, action, recovery = 0, attempt = 1]: MarkerPlace
) =>
  marker.formatMarker({
    execution: executionRecord.execution,
    vertex,
    visit,
    action,
    recovery,
    run: executionRecord.run,
    attempt,
  });

// The Protected Files gg run passes: gg's own paths and every shipped Harness's.
export const PROTECTED_PATHS = interpreter.protectedFiles(shipped.HARNESSES);

export type Which = 'fake' | 'real';

// The fake integrity over `git`, or null for the real one. A case asks for real integrity and real git separately.
export const fakeIntegrityFor = (integrity: Which, head: string, git: runContext.RunGit) =>
  integrity === 'real' ? null : fakeIntegrityModule.fakeIntegrity({ head, git });

// The template's repos, in real git or in a fake git, and the git verbs to inject. Returns main's SHA as `base`.
export function seedGit(root: string, which: Which) {
  if (which === 'real')
    return { base: templateRepos.seedRepos(root), git: gitModule as runContext.RunGit, fakeGit: null };
  const fakeGit = fakeGitModule.fakeGit();
  const { base } = fakeGit.init(root, { files: { 'package.json': templateRepos.TEMPLATE_PACKAGE } });
  return { base, git: fakeGit.git as runContext.RunGit, fakeGit };
}

// The fake harness a golden Execution runs on, answering `responses`. Its Harness reports no cost or reasoning tokens.
export const goldenHarness = (transcriptDir: string, responses: fakeHarnessModule.ScriptedResponses) =>
  fakeHarnessModule.fakeHarness({
    transcriptDir,
    responses,
    capabilities: { costReporting: false, reasoningTokenReporting: false },
  });

export interface GoldenOptions {
  responses?: fakeHarnessModule.ScriptedResponses;
  integrity?: Which;
  git?: Which;
}

// git and integrity are fakes unless the case asks for either by name, for a test whose subject is git behaviour.
export async function fixture(t: TestContext, options: GoldenOptions = {}) {
  const { responses = firstVisitResponses, integrity = 'fake', git: which = 'fake' } = options;
  const root = tempDirectory.tempDirectory(t, 'gg-golden-', (directory) => join(directory, 'main', '.git'));
  const { base, git, fakeGit } = seedGit(root, which);
  const fakeIntegrity = fakeIntegrityFor(integrity, base, git);
  const mainRoot = join(root, 'main');
  const worktree = join(root, 'wt', 'ticket-15');
  if (which === 'real') gitShell.sh(mainRoot, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main');
  else await git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  const commonDir = join(mainRoot, '.git');
  const configured = goldenConfig();
  const flow = resolve(configured);
  const executionRecord = record.createExecutionRecord({
    commonDir,
    ticket: TICKET,
    epic: 1,
    flow: { name: flow.name, entry: flow.ticket.entry as string },
    configHash: 'cfg-hash',
    run: '20261015T000000Z-abc123',
    worktree,
    branch: BRANCH,
    base: 'main',
  });
  const database = caseDatabase.caseDatabase(t);
  await database.save(executionRecord);
  const repos = { root, mainRoot, worktree, commonDir, base, git, fakeGit, fakeIntegrity };
  return observedExecution(repos, { responses, configured, flow, executionRecord, database });
}

type Repos = {
  root: string;
  mainRoot: string;
  worktree: string;
  commonDir: string;
  base: string;
  git: runContext.RunGit;
  fakeGit: fakeGitModule.FakeGit | null;
  fakeIntegrity: fakeIntegrityModule.FakeIntegrity | null;
};
type Planned = {
  responses: fakeHarnessModule.ScriptedResponses;
  configured: GoldenConfig;
  flow: runContext.RunFlow;
  executionRecord: record.ExecutionRecord;
  database: record.StateDatabase;
};

// Every git verb is observed, including the ones lib modules call on their own (integrity snapshots).
const observedGit = (git: runContext.RunGit, observe: (what: string) => void) =>
  Object.fromEntries(
    Object.entries(git).map(([verb, call]) => [
      verb,
      typeof call === 'function'
        ? (...args: unknown[]) => {
            observe(`git ${verb}`);
            return call(...args);
          }
        : call,
    ]),
  ) as runContext.RunGit;

// The case's clock: every sleep is recorded, and `onSleep`, when a case sets it, runs before the clock moves on.
// `beat()` runs what is due on `every`, as a heartbeat timer firing.
function goldenClock() {
  const time = { now: Date.parse('2026-10-15T00:00:00Z') };
  const sleeps: number[] = [];
  const beats = new Set<() => void>();
  const clock = {
    onSleep: undefined as ((ms: number) => unknown) | undefined,
    now: () => time.now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await clock.onSleep?.(ms);
      time.now += ms;
    },
    every: (_ms: number, tick: () => void) => {
      beats.add(tick);
      return () => beats.delete(tick);
    },
    beat: () => {
      for (const tick of beats) tick();
    },
  };
  return { clock, sleeps };
}

// What the fixture passes runExecution: the golden Ticket on `deps`, its record, Flow and Layer files.
function executionOptions({
  repos,
  planned,
  deps,
  harness,
  logs,
}: {
  repos: Repos;
  planned: Planned;
  deps: runContext.Deps;
  harness: fakeHarnessModule.FakeHarness;
  logs: string[];
}) {
  const { fakeIntegrity } = repos;
  return {
    deps,
    flow: planned.flow,
    record: planned.executionRecord,
    harness: harness as unknown as runContext.Harness,
    events: events.eventLog(repos.commonDir, {}, planned.database),
    log: (line: string) => logs.push(line),
    cwd: repos.mainRoot,
    commands: planned.configured.commands,
    testPaths: planned.configured.testPaths,
    ticket: { number: TICKET, title: 'Add two numbers', body: 'Add `add(a, b)`.', branch: BRANCH },
    base: 'main',
    labelPrefix: 'gg',
    others: [] as string[],
    protectedPaths: PROTECTED_PATHS,
    files: planned.configured.files,
    ...(fakeIntegrity && { testImmutability: fakeIntegrity.testImmutability }),
  } satisfies runContext.ExecutionOptions;
}

function observedExecution(repos: Repos, planned: Planned) {
  const { root, mainRoot, worktree, commonDir, fakeIntegrity } = repos;
  const { configured, flow, executionRecord, database } = planned;
  // What every launched process saw of the worktree's activity, read from the saved row as another process would.
  const activity: Record<string, unknown>[] = [];
  const observe = (what: string) =>
    activity.push({ what, ...JSON.parse(caseDatabase.savedJson(commonDir, 'ticket', TICKET) as string).activity });
  const harness = goldenHarness(join(root, 'transcripts'), planned.responses);
  const run = harness.run;
  harness.run = (call) => {
    observe('harness');
    return run(call);
  };
  const shells: { command: string; cwd: string | undefined }[] = [];
  const onRun = (command: string, cwd: string | undefined) => {
    observe('test');
    shells.push({ command, cwd });
  };
  const exec = addSuiteModule.addSuite({ worktree, onRun });
  const headOf = (branch: string) => repos.git.remoteSha(mainRoot, branch);
  const gh = fakeGhModule.fakeGh({ branch: BRANCH, ticket: TICKET, observe, headOf });
  const logs: string[] = [];
  const { clock, sleeps } = goldenClock();
  const deps = {
    gh: github.createGh(gh.gh),
    git: observedGit(repos.git, observe),
    exec,
    database,
    clock,
    ...(fakeIntegrity && { integrity: fakeIntegrity.integrity }),
  } as runContext.Deps;
  const options = executionOptions({ repos, planned, deps, harness, logs });
  const { git: _git, ...seeded } = repos;
  return {
    ...seeded,
    flow,
    executionRecord,
    harness,
    gh,
    shells,
    activity,
    logs,
    options,
    config: configured,
    files: configured.files,
    clock,
    sleeps,
    readEvents: () => events.readEvents(commonDir),
  };
}

// The golden fixture: the temp repos, the Execution's record and options, and the fakes it runs on. `options.deps.git`
// is the git gg is given; `fakeGit` holds the fake git's own verbs and the steps a human takes outside gg (null on real
// git); `fakeIntegrity` scripts the fake integrity (null on the real one).
export type GoldenFixture = Awaited<ReturnType<typeof fixture>>;

// Edits the case's configuration with `edit(config)` and resolves the Flow again.
// A record that has entered no Vertex yet starts at the new entry.
export function configure(golden: GoldenFixture, edit: (configured: GoldenConfig) => void): void {
  edit(golden.config);
  golden.flow = golden.options.flow = resolve(golden.config);
  if (!Object.keys(golden.executionRecord.visits).length)
    golden.executionRecord.cursor.vertex = golden.flow.ticket.entry as string;
}
