// The example Layer `gg init` writes, run as the golden Execution: its Agents on the fake Harness, its Procedures, Flow
// and files, over a fake suite whose tests say what they require. `exampleFixture` builds it and runs nothing;
// `runExample` runs it.
import type { TestContext } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as addSuite from './add-suite.ts';
import * as exampleLayer from './example-layer.ts';
import type * as fakeHarnessModule from './fake-harness.ts';
import * as golden from './golden.ts';
import * as goldenRun from './golden-run.ts';
import * as keys from './keys.ts';

// A test file's requirement line: the test passes when the file at `path` holds `text`.
const REQUIRES = /^\/\/ requires (\S+): (.*)$/gm;
export const requires = (path: string, text: string) => `// requires ${path}: ${text}\n`;

// Each test file under test/ in `root`, by its test's name (the file's base name before `.test.mjs`).
function testFiles(root: string): Map<string, string> {
  const directory = join(root, 'test');
  if (!existsSync(directory)) return new Map();
  return new Map(
    (readdirSync(directory, { recursive: true }) as string[])
      .filter((path) => path.endsWith('.test.mjs'))
      .map((path) => [
        relative(directory, join(directory, path))
          .replace(/^.*[\\/]/, '')
          .replace(/\.test\.mjs$/, ''),
        path,
      ])
      .map(([name, path]) => [name, readFileSync(join(directory, path), 'utf8')]),
  );
}

// The suite a fake test runner runs over the worktree: every test file's requirements, each test printed as node's
// spec reporter prints it, failing when any requirement is unmet. A worktree with no tests passes. `onRun` sees each
// run first.
export function requiresSuite({ worktree, onRun = () => {} }: { worktree: string; onRun?: () => void }) {
  const runShell = async (_command: string, options?: { cwd?: string }) => {
    onRun();
    const root = options?.cwd ?? worktree;
    const results = [...testFiles(root)].map(([name, text]) => {
      const passed = [...text.matchAll(REQUIRES)].every(([, path, needed]) => {
        const file = join(root, path!);
        return existsSync(file) && readFileSync(file, 'utf8').includes(needed!);
      });
      return { name, passed };
    });
    const failed = results.filter((result) => !result.passed).length;
    const output = [
      ...results.map(({ name, passed }) => `${passed ? '✔' : '✖'} ${name} (1ms)`),
      `ℹ pass ${results.length - failed}`,
      `ℹ fail ${failed}`,
    ].join('\n');
    return { code: failed ? 1 : 0, output, timedOut: false, cleanup: addSuite.CONFIRMED };
  };
  return { runShell, cleanupConfirmed: () => true } as unknown as runContext.Deps['exec'];
}

// The example's Agents on the fake Harness, each Persona its own file.
const AGENTS = {
  implementer: golden.implementerAgent('implementer.md'),
  reviewer: { ...golden.implementerAgent('reviewer.md'), model: 'model-r', access: 'read-only' },
  senior: { ...golden.implementerAgent('implementer.md'), model: 'model-s' },
};

// The example as the golden configuration: its gg.json with the Agents above, and every file it names.
export function exampleConfig(): golden.GoldenConfig {
  const layer = exampleLayer.config();
  const named = exampleLayer.WRITTEN_NAMES.filter((name) => name !== 'gg.json');
  return {
    commands: layer.commands,
    testPaths: layer.testPaths,
    agents: structuredClone(AGENTS),
    procedures: layer.procedures,
    flows: layer.flows,
    files: Object.fromEntries(named.map((name) => [name, golden.layerFile(exampleLayer.fixtureText(name))])),
  };
}

// The golden Ticket's test and implementation, as the example's suite reads them.
export const ADDS_TEST = { 'test/adds.test.mjs': requires('lib/add.mjs', 'a + b') };
export const ADD = { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' };

export const redResponse = (tests = ['adds'], extra = {}) => ({
  ...golden.redResponse,
  reason: 'none',
  tests,
  ...extra,
});
export const greenResponse = (extra = {}) => ({ ...golden.greenResponse, reason: 'none', ...extra });
export const reviewResponse = (claim: string, extra = {}) => ({
  claim,
  reason: 'none',
  summary: `The review says ${claim}.`,
  definitionOfDoneMet: true,
  redGreenEvidenceOk: true,
  needsTest: false,
  findings: [],
  diagnosis: '',
  ...extra,
});
// A red Visit that claims no test is needed.
export const noTestResponse = (notes = 'A config default; no behaviour to test.') =>
  redResponse([], {
    claim: 'blocked',
    reason: 'no-test-needed',
    summary: 'No test is needed.',
    notes,
    diagnosis: 'The change has no observable behaviour.',
  });

// The scripted Attempt of `vertex`'s Visit `visit` of its agent Action `phase`, first attempt unless `attempt` says.
export const call = (vertex: string, visit: number, phase: string, attempt = 1) =>
  keys.responseKey(vertex, visit, phase, attempt);

// The first-visit pass: red writes a failing test, green implements it, and the reviewer accepts.
export const firstPass = (): fakeHarnessModule.ScriptedResponses => ({
  [call('red', 1, 'red')]: { files: ADDS_TEST, response: redResponse() },
  [call('green', 1, 'green')]: { files: ADD, response: greenResponse() },
  [call('reviewer', 1, 'review')]: { files: {}, response: reviewResponse('ok') },
});

// A review that asks for a test, with a minor Finding of its own so that no review repeats another.
export const needsTest = (issue: string): fakeHarnessModule.ScriptedResponse => ({
  files: {},
  response: reviewResponse('changes', {
    needsTest: true,
    findings: [{ severity: 'minor', file: 'test/adds.test.mjs', issue, fix: 'Add it.' }],
  }),
});
// A green Visit that implements the sum, then stops because it finds red's test wrong.
export const badTest = (diagnosis: string): fakeHarnessModule.ScriptedResponse => ({
  files: ADD,
  response: greenResponse({ claim: 'blocked', reason: 'bad-test', diagnosis }),
});

// How a passing Execution ends.
export const PASSED = ['publish', 'ready-for-qa'];

// The Brief of `vertex`'s Visit `visit`, as its first Attempt received it.
export const briefOf = (fixture: Pick<golden.GoldenFixture, 'harness'>, vertex: string, visit: number) =>
  fixture.harness.calls.find((made) => {
    const parts = marker.partsOf(made.marker as string);
    return parts.vertex === vertex && parts.visit === String(visit);
  })?.brief ?? '';
// An Action's saved outputs.
export const outputOf = (executionRecord: record.ExecutionRecord, vertex: string, action: string) =>
  executionRecord.outputs.find((output) => output.vertex === vertex && output.action === action)?.value;

// The golden fixture's options, with the example's first pass as the default responses.
export type ExampleOptions = golden.GoldenOptions;

// The golden fixture configured as the example, its Execution at `baseline`, on the requires suite. It runs nothing.
export async function exampleFixture(t: TestContext, options: ExampleOptions = {}) {
  const fixture = await golden.fixture(t, { responses: firstPass(), ...options });
  const configured = exampleConfig();
  golden.configure(fixture, (goldenConfig) => Object.assign(goldenConfig, configured));
  fixture.executionRecord.flow = fixture.flow.name;
  Object.assign(fixture.options, {
    commands: configured.commands,
    testPaths: configured.testPaths,
    files: configured.files,
  });
  fixture.files = configured.files;
  fixture.options.deps.exec = requiresSuite({ worktree: fixture.worktree });
  return fixture;
}

// Builds the example fixture and runs its Execution to its Terminal.
export const runExample = async (t: TestContext, options?: ExampleOptions) =>
  goldenRun.ranToEnd(await exampleFixture(t, options));

// Ticket 16's Execution in the same repository and State Database as `fixture`'s Ticket 15, on its own worktree and
// branch from the same base, with the same scripted Harness: the options to run it with. `onRun` sees each suite run.
export async function nextTicket(fixture: golden.GoldenFixture, onRun?: () => void) {
  const branch = 'ticket/16-add-again';
  const worktree = join(fixture.root, 'wt', 'ticket-16');
  await fixture.options.deps.git.ensureWorktree({ mainRoot: fixture.mainRoot, path: worktree, branch, base: 'main' });
  const next = record.createExecutionRecord({
    commonDir: fixture.commonDir,
    ticket: 16,
    epic: 1,
    flow: { name: fixture.flow.name, entry: fixture.flow.ticket.entry as string },
    configHash: 'cfg-hash',
    run: fixture.executionRecord.run,
    worktree,
    branch,
    base: 'main',
  });
  await fixture.options.deps.database!.save(next);
  return {
    record: next,
    options: {
      ...fixture.options,
      record: next,
      deps: { ...fixture.options.deps, exec: requiresSuite({ worktree, onRun }) },
      ticket: { number: 16, title: 'Add two numbers again', body: 'Add `add(a, b)` again.', branch },
    },
  };
}

// The Vertices the Execution entered, in order, one entry per Visit.
export const visited = (fixture: Pick<golden.GoldenFixture, 'readEvents'>) =>
  golden
    .trace(fixture.readEvents())
    .filter((event, index, all) => index === 0 || all[index - 1]!.vertex !== event.vertex)
    .map((event) => event.vertex);
