// One Flow written over a set of names: every name the configuration gives (Flow, Agent, Procedure, Vertex, Action id,
// Claim token, Outcome, input, Declared Command, Layer file) comes from the set, so the same Flow can be named with
// ordinary names and with the names of Object.prototype's properties, and the two compared (#174).
import type { TestContext } from 'node:test';
import * as config from '../../lib/config.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as validate from '../../lib/validate/index.ts';
import type * as fakeHarnessModule from './fake-harness.ts';
import * as crashResume from './crash-resume.ts';
import * as executionReads from './execution-reads.ts';
import * as golden from './golden.ts';
import * as keys from './keys.ts';

export interface Names {
  flow: string;
  agent: string;
  writing: string;
  gating: string;
  first: string;
  second: string;
  ask: string;
  verify: string;
  commit: string;
  push: string;
  gate: string;
  pr: string;
  ready: string;
  halt: string;
  parked: string;
  draft: string;
  suite: string;
  persona: string;
  brief: string;
  body: string;
  schema: string;
}

// Each ordinary name is a word no message, key or template of gg uses, so renaming it in a result renames only it.
export const ORDINARY: Names = {
  flow: 'flowName',
  agent: 'agentName',
  writing: 'writingProcedure',
  gating: 'gatingProcedure',
  first: 'firstVertex',
  second: 'secondVertex',
  ask: 'askAction',
  verify: 'verifyAction',
  commit: 'commitAction',
  push: 'pushAction',
  gate: 'gateAction',
  pr: 'prAction',
  ready: 'readyAction',
  halt: 'haltToken',
  parked: 'parkedOutcome',
  draft: 'draftInput',
  suite: 'suiteCommand',
  persona: 'personaFile',
  brief: 'briefFile',
  body: 'bodyFile',
  schema: 'schemaFile',
};

// The same Flow named with Object.prototype's property names. Names of different kinds may repeat, as they may in any
// configuration; within a kind each is distinct.
export const PROTOTYPE: Names = {
  flow: '__proto__',
  agent: 'constructor',
  writing: 'toString',
  gating: '__proto__',
  first: 'constructor',
  second: '__proto__',
  ask: 'valueOf',
  verify: '__proto__',
  commit: 'toString',
  push: 'constructor',
  gate: '__proto__',
  pr: 'valueOf',
  ready: 'isPrototypeOf',
  halt: 'toLocaleString',
  parked: 'propertyIsEnumerable',
  draft: '__proto__',
  suite: '__proto__',
  persona: '__lookupGetter__',
  brief: '__defineSetter__',
  body: '__lookupSetter__',
  schema: 'propertyIsEnumerable',
};

// An object from entries, so a key __proto__ is an own key, as JSON.parse makes it in a Layer.
const keyed = (...entries: [string, unknown][]) => Object.fromEntries(entries);

// The first Vertex's Procedure: its agent writes lib/add.mjs, its Check passes and its work is committed and pushed.
// A halt Claim is the Outcome `parked`. The second Vertex's Procedure, which has no agent, checks again and readies
// the PR.
const namedProcedures = (names: Names) =>
  keyed(
    [
      names.writing,
      {
        tests: 'frozen',
        claimTokens: keyed(['ok', { requires: [names.verify] }], [names.halt, { stop: true }]),
        actions: [
          { id: names.ask, do: 'agent', brief: names.brief, schema: names.schema },
          { id: names.verify, do: 'check', kind: 'command', command: names.suite },
          { id: names.commit, do: 'commit', type: 'feat' },
          { id: names.push, do: 'push' },
        ],
        stopped: [{ when: { claim: names.halt }, outcome: names.parked }],
      },
    ],
    [
      names.gating,
      {
        actions: [
          { id: names.gate, do: 'check', kind: 'command', command: names.suite },
          { id: names.pr, do: 'pr-upsert', body: names.body, with: { draft: `inputs.${names.draft}` } },
          { id: names.ready, do: 'pr-ready' },
        ],
      },
    ],
  ) as golden.GoldenConfig['procedures'];

// The first Vertex runs the agent and goes on to the second, which reads the agent's response as an input; the Flow's
// routes send `parked` to needs-replan.
const namedFlowDeclaration = (names: Names) =>
  keyed([
    names.flow,
    {
      actionCap: 20,
      ticket: {
        entry: names.first,
        routes: keyed([names.parked, { end: 'needs-replan' }], ['*', { end: 'needs-human' }]),
        vertices: keyed(
          [
            names.first,
            {
              use: names.agent,
              procedure: names.writing,
              route: { ok: { to: names.second, max: 1, exhausted: { end: 'needs-human' } } },
            },
          ],
          [
            names.second,
            {
              procedure: names.gating,
              max: 1,
              exhausted: { end: 'needs-human' },
              inputs: keyed([names.draft, { from: `${names.first}.${names.ask}.response` }]),
              route: { ok: { end: 'ready-for-qa' } },
            },
          ],
        ),
      },
    },
  ]) as golden.GoldenConfig['flows'];

// The Persona, Brief, PR body and response schema the Flow names, beside the shipped files.
function namedFiles(names: Names): config.SourceFiles {
  const schema = {
    type: 'object',
    properties: { claim: { type: 'string', enum: ['ok', names.halt] }, summary: { type: 'string' } },
    required: ['claim', 'summary'],
    additionalProperties: false,
  };
  return {
    ...golden.goldenConfig().files,
    ...keyed(
      [names.persona, golden.layerFile(golden.PERSONA)],
      [names.brief, golden.layerFile('Write lib/add.mjs.\n')],
      [names.body, golden.layerFile('The change.\n{{#provenance}}| {{vertex}} | {{calls}} |\n{{/provenance}}')],
      [names.schema, golden.layerFile(`${JSON.stringify(schema)}\n`)],
    ),
  } as config.SourceFiles;
}

// The golden configuration's commands and test paths, with the Flow named with `names`.
export const namedConfig = (names: Names): golden.GoldenConfig => ({
  commands: keyed([names.suite, 'npm test']) as Record<string, string>,
  testPaths: golden.goldenConfig().testPaths,
  agents: keyed([names.agent, golden.implementerAgent(names.persona)]) as golden.GoldenConfig['agents'],
  procedures: namedProcedures(names),
  flows: namedFlowDeclaration(names),
  files: namedFiles(names),
});

// The validator's result for the Flow named with `names`, its schemas and templates read from its own files.
export function validated(names: Names) {
  const configured = namedConfig(names);
  return validate.validate(configured, {
    harnesses: { fake: {} },
    readSchema: (name) => JSON.parse(config.namedFile(configured.files, name)),
    readTemplate: (name) => config.namedFile(configured.files, name),
  });
}

// The first Vertex's agent answers `claim`, writing lib/add.mjs.
export const namedResponses = (names: Names, claim = 'ok'): fakeHarnessModule.ScriptedResponses => ({
  [keys.responseKey(names.first, 1, names.ask, 1)]: {
    files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' },
    response: { claim, summary: 'Add two numbers.' },
  },
});

// The golden fixture on the Flow named with `names`, its agent answering `claim`; it runs nothing.
export async function namedFixture(t: TestContext, names: Names, claim = 'ok') {
  const fixture = await golden.fixture(t, { responses: namedResponses(names, claim) });
  golden.configure(fixture, (configured) => Object.assign(configured, namedConfig(names)));
  Object.assign(fixture.options, { commands: fixture.config.commands, files: fixture.config.files });
  return fixture;
}

// What a run of the fixture left: its result, every Action Event, the record's counts and ending, and the PR's body,
// with the Execution's id, which differs per run, left out of its Action Markers.
async function left(fixture: golden.GoldenFixture, result: Awaited<ReturnType<typeof interpreter.runExecution>>) {
  const { visits, traversals, cursor, terminalReason, state, execution } = executionReads.loadTicket(fixture);
  const body = (fixture.gh.pr()?.body as string | undefined)?.replaceAll(execution, '<execution>') ?? null;
  return { result, trace: golden.trace(fixture.readEvents()), visits, traversals, cursor, terminalReason, state, body };
}

// Runs the Flow named with `names` to its end, its agent answering `claim`, and gives what the run left.
export async function runNamed(t: TestContext, names: Names, claim = 'ok') {
  const fixture = await namedFixture(t, names, claim);
  return left(fixture, await interpreter.runExecution(fixture.options));
}

// Runs the Flow named with `names` until it crashes after the first Vertex's commit, then resumes it on a freshly
// loaded record through Reconciliation to its end, and gives what the two runs left.
export async function restartNamed(t: TestContext, names: Names) {
  const fixture = await namedFixture(t, names);
  await crashResume.crashed(fixture, [names.first, 1, names.commit, 0], 'after-completion');
  const record = executionReads.loadTicket(fixture);
  return left(fixture, await interpreter.runExecution({ ...fixture.options, record }));
}

const ORDINARY_TO_PROTOTYPE = new Map(
  (Object.keys(ORDINARY) as (keyof Names)[]).map((kind) => [ORDINARY[kind], PROTOTYPE[kind]]),
);

// `value` with every ordinary name renamed to its Object.prototype name, in keys and inside strings, such as a
// reference path, a traversal key or a Terminal Reason. Objects are rebuilt from entries, so __proto__ stays an own
// key.
export function renamed(value: unknown): unknown {
  const rename = (text: string) => text.replace(/[A-Za-z]+/g, (word) => ORDINARY_TO_PROTOTYPE.get(word) ?? word);
  if (typeof value === 'string') return rename(value);
  if (Array.isArray(value)) return value.map(renamed);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [renamed(key), renamed(item)]));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [rename(key), renamed(item)]));
  return value;
}
