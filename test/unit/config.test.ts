import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as checks from '../../lib/checks.ts';
import * as config from '../../lib/config.ts';
import * as validate from '../../lib/validate/index.ts';
import * as exampleLayer from '../support/example-layer.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const personaPath = (name: string) => join(repoRoot, 'defaults', 'personas', name);
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
// A Layer file as loadLayers gives it: its text and the hash of its bytes.
const layerFile = (bytes: string) => ({ bytes, hash: sha256(bytes) });

// Rebuilds an object with every key in reverse order, so only key order differs.
function reversed<Value>(value: Value): Value {
  if (Array.isArray(value)) return value.map(reversed) as Value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reversed(entry)]),
  ) as Value;
}

test('loadDefaults reads the shipped flow', () => {
  const defaults: exampleLayer.Layer = config.loadDefaults();
  assert.equal(defaults.flows.default.ticket.entry, 'red');
});

for (const name of ['implementer.md', 'reviewer.md']) {
  test(`loadDefaults reads the shipped persona ${name} with its hash`, () => {
    const file = readFileSync(personaPath(name));
    const persona = config.loadDefaults().files[`personas/${name}`];
    assert.ok(persona, `${name} is loaded`);
    assert.equal(String(persona.bytes), file.toString('utf8'));
    assert.equal(persona.hash, sha256(file));
  });
}

test('loadLayers reads the Layer identified by layerPath', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-layer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = config.layerPath(directory);
  assert.equal(file, join(directory, '.agents', 'gg', 'gg.json'));
  mkdirSync(join(directory, '.agents', 'gg'), { recursive: true });
  writeFileSync(file, JSON.stringify({ baseBranch: 'layer-base' }));
  assert.equal(config.loadLayers(directory, join(directory, 'no-user-layer')).baseBranch, 'layer-base');
});

test('configHash changes with persona, vertex, command and testPaths changes and ignores key order', () => {
  const defaults: exampleLayer.Layer = config.loadDefaults();
  const base = {
    flow: defaults.flows.default,
    files: defaults.files,
    harnesses: { claude: {} },
    launchProfile: null,
    commands: { test: 'npm test' },
    testPaths: ['test/**'],
  };
  const hash = config.configHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(config.configHash(structuredClone(base)), hash, 'stable for equal input');
  assert.equal(config.configHash(reversed(base)), hash, 'stable across key order');

  const persona = structuredClone(base);
  const bytes = `${String(persona.files['personas/implementer.md'].bytes)} `;
  persona.files['personas/implementer.md'] = { bytes, hash: sha256(bytes) };
  assert.notEqual(config.configHash(persona), hash, 'a Persona byte changes the hash');

  const vertex = structuredClone(base);
  vertex.flow.ticket.vertices.reviewer.route.changes.max = 3;
  assert.notEqual(config.configHash(vertex), hash, 'a Vertex field changes the hash');

  const command = structuredClone(base);
  command.commands.test = 'npm run test:all';
  assert.notEqual(config.configHash(command), hash, 'a Declared Command changes the hash');

  const testPaths = structuredClone(base);
  testPaths.testPaths.push('spec/**');
  assert.notEqual(config.configHash(testPaths), hash, 'a test path changes the hash');
});

// gg's lib, defaults and runtime dependencies copied under `root`, laid out as an install lays them out.
function copyInstall(root: string) {
  for (const directory of ['lib', 'defaults'])
    cpSync(join(repoRoot, directory), join(root, directory), { recursive: true });
  const { dependencies = {} } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const name of Object.keys(dependencies))
    cpSync(join(repoRoot, 'node_modules', name), join(root, 'node_modules', name), { recursive: true });
}

// A copy of gg installed under its own root, with `edit` applied to the copy, and the Config Hash input and hash it
// gives the defaults.
async function installed(t: TestContext, install: string, edit = (_root: string) => {}) {
  const root = join(mkdtempSync(join(tmpdir(), `gg-install-${install}-`)), 'gg');
  t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  copyInstall(root);
  edit(root);
  // The copy's own module, so its paths are the copy's: a namespace import would load this checkout's.
  const copied = await import(pathToFileURL(join(root, 'lib', 'config.ts')).href);
  const defaults = copied.loadDefaults();
  const input = { flow: defaults.flows.default, files: defaults.files, harnesses: {}, commands: {} };
  return { root: JSON.stringify(root).slice(1, -1), input: JSON.stringify(input), hash: copied.configHash(input) };
}

test('asset bytes change the Config Hash but installation paths do not', async (t) => {
  // Two copies of gg installed under different roots must hash the shipped defaults the same.
  const one = await installed(t, 'one');
  const two = await installed(t, 'two');
  assert.ok(!one.input.includes(one.root), 'no install path in the hashed input');
  assert.ok(!two.input.includes(two.root), 'no install path in the hashed input');
  assert.equal(one.hash, two.hash);
  const edited = await installed(t, 'edited', (root) =>
    writeFileSync(join(root, 'defaults', 'personas', 'reviewer.md'), '# reviewer, edited\n'),
  );
  assert.notEqual(edited.hash, one.hash, 'a shipped Persona byte changes the hash');
});

// A repository root and a home directory, each with the Layer text given (or none).
function layers(t: TestContext, { repo, home }: { repo?: string; home?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gg-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const roots = { repo: join(directory, 'repo'), home: join(directory, 'home') };
  for (const [name, text] of Object.entries({ repo, home }) as ['repo' | 'home', string | undefined][]) {
    mkdirSync(join(roots[name], '.agents', 'gg'), { recursive: true });
    if (text !== undefined) writeFileSync(config.layerPath(roots[name]), text);
  }
  return roots;
}

// Writes `files` (name to text) beside the Layer of `root`.
function beside(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, '.agents', 'gg', name), text);
}

test('loadLayers reads each file from the Layer that declares its name', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({ agents: { implementer: { persona: 'repo-implementer.md' } } }),
    home: JSON.stringify({
      procedures: {
        probe: {
          actions: [
            { id: 'ask', do: 'agent', brief: 'ask.md', schema: 'ask.schema.json' },
            { id: 'pr', do: 'pr-upsert', body: 'body.md' },
          ],
          recover: { max: 1, brief: 'again.md' },
          claimTokens: { halt: { stop: true, comment: 'stopped.md' } },
        },
      },
    }),
  });
  beside(repo, { 'repo-implementer.md': '# repo implementer\n' });
  beside(home, {
    'ask.md': 'ask',
    'ask.schema.json': '{}',
    'body.md': 'body',
    'again.md': 'again',
    'stopped.md': 'stopped',
  });
  const { files } = config.loadLayers(repo, home);
  assert.deepEqual(files['repo-implementer.md'], layerFile('# repo implementer\n'));
  assert.deepEqual(files['ask.md'], layerFile('ask'));
  assert.deepEqual(files['ask.schema.json'], layerFile('{}'));
  assert.deepEqual(files['body.md'], layerFile('body'));
  assert.deepEqual(files['again.md'], layerFile('again'));
  assert.deepEqual(files['stopped.md'], layerFile('stopped'));
  assert.equal(
    files['personas/implementer.md'].bytes,
    readFileSync(personaPath('implementer.md'), 'utf8'),
    'the defaults keep their own files',
  );
});

test('an inherited file reference keeps its declaring Layer', (t) => {
  const { repo, home } = layers(t, {
    home: JSON.stringify({ agents: { implementer: { persona: 'shared.md' } } }),
    repo: JSON.stringify({
      agents: { implementer: { harness: 'claude' } },
      procedures: {
        probe: {
          actions: [{ id: 'check', do: 'check', kind: 'command', command: 'test', recoverBrief: 'fix-it.md' }],
        },
      },
    }),
  });
  beside(home, { 'shared.md': '# from the user Layer\n' });
  beside(repo, { 'shared.md': '# a repository file no Layer names\n', 'fix-it.md': 'fix it' });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.equal(loaded.agents.implementer.persona, 'shared.md');
  assert.equal(loaded.files['shared.md'].bytes, '# from the user Layer\n');
  assert.equal(loaded.files['fix-it.md'].bytes, 'fix it');
});

test('an inline Vertex persona loads from its declaring Layer', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({ flows: { default: { ticket: { vertices: { red: { persona: 'red-persona.md' } } } } } }),
  });
  beside(repo, { 'red-persona.md': '# red only\n' });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.equal(loaded.flows.default.ticket.vertices.red.persona, 'red-persona.md');
  assert.deepEqual(loaded.files['red-persona.md'], layerFile('# red only\n'));
});

test('a name two Layers declare for different files is a load error naming both', (t) => {
  const { repo, home } = layers(t, {
    home: JSON.stringify({ agents: { implementer: { persona: 'same.md' } } }),
    repo: JSON.stringify({ agents: { reviewer: { persona: 'same.md' } } }),
  });
  beside(home, { 'same.md': '# home\n' });
  beside(repo, { 'same.md': '# repo\n' });
  assert.throws(() => config.loadLayers(repo, home), {
    message:
      `file "same.md" is declared by ${config.layerPath(home)} and by ${config.layerPath(repo)}, ` +
      'each beside its own Layer; give one of them another name',
  });
});

test('a declared file that does not exist is a load error naming the Layer file and the name', (t) => {
  const { repo, home } = layers(t, { repo: JSON.stringify({ agents: { implementer: { persona: 'missing.md' } } }) });
  assert.throws(() => config.loadLayers(repo, home), {
    message: `${config.layerPath(repo)} names file "missing.md", which cannot be read (ENOENT)`,
  });
});

test('a Flow or Procedure a later Layer declares replaces the earlier one of its name whole', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({
      procedures: { review: { actions: [{ id: 'look', do: 'check', kind: 'command', command: 'test' }] } },
      flows: {
        default: { plan: null, actionCap: 5, ticket: { entry: 'look', vertices: { look: { procedure: 'review' } } } },
      },
    }),
  });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.deepEqual(loaded.procedures.review, {
    actions: [{ id: 'look', do: 'check', kind: 'command', command: 'test' }],
  });
  assert.deepEqual(loaded.flows.default, {
    actionCap: 5,
    ticket: { entry: 'look', vertices: { look: { procedure: 'review' } } },
  });
  assert.equal(loaded.procedures.implement.actions[0].id, 'green', 'a Procedure the Layer does not declare stays');
});

// The validator's result for a loaded configuration, as gg doctor and admission read it.
function validated(loaded: config.Config) {
  return validate.validate(loaded, {
    harnesses: {},
    readSchema: (name) => JSON.parse(config.layerFile(loaded.files, name)),
    readTemplate: (name) => config.layerFile(loaded.files, name),
  });
}
// A Layer declaring a Flow `small`, one Check of its own Procedure `probe`, with `flow` over the Flow's keys.
const smallFlowLayer = (flow: Record<string, unknown> = {}) =>
  JSON.stringify({
    commands: { test: 'npm test' },
    procedures: { probe: { actions: [{ id: 'look', do: 'check', kind: 'command', command: 'test' }] } },
    flows: {
      small: {
        actionCap: 5,
        ticket: { entry: 'look', routes: { '*': { end: 'needs-human' } }, vertices: { look: { procedure: 'probe' } } },
        ...flow,
      },
    },
  });
// Each error at or under `location`, as its location and the rule it broke.
const brokenUnder = (errors: ReturnType<typeof validated>['errors'], location: string) =>
  errors.filter((problem) => problem.at.startsWith(location)).map((problem) => `${problem.at}: ${problem.code}`);
const smallFlowErrors = (t: TestContext, flow: Record<string, unknown>) => {
  const { repo, home } = layers(t, { repo: smallFlowLayer(flow) });
  return brokenUnder(validated(config.loadLayers(repo, home)).errors, 'flows.small');
};
// The errors of a repository Layer whose Procedure `ask` asks an agent for a reason and findings, with `keys` over the
// Procedure's own.
function askErrors(t: TestContext, keys: Record<string, unknown>) {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({
      procedures: {
        ask: {
          actions: [{ id: 'ask', do: 'agent', brief: 'ask.md', schema: 'ask.schema.json' }],
          claimTokens: { ok: { requires: [] } },
          otherwise: 'changes',
          ...keys,
        },
      },
    }),
  });
  const severity = { type: 'string', enum: ['blocker', 'minor'] };
  const finding = {
    type: 'object',
    additionalProperties: false,
    required: ['severity'],
    properties: { severity },
  };
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['claim', 'reason', 'findings'],
    properties: {
      claim: { type: 'string', enum: ['ok'] },
      reason: { type: 'string', enum: ['bad-test', 'misscoped'] },
      findings: { type: 'array', items: finding },
    },
  };
  beside(repo, { 'ask.md': 'ask', 'ask.schema.json': JSON.stringify(schema) });
  return validated(config.loadLayers(repo, home)).errors;
}

test("a Layer's null deletes an Agent, and a Vertex using it reports undeclared-agent", (t) => {
  const { repo, home } = layers(t, { repo: JSON.stringify({ agents: { reviewer: null } }) });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.equal(Object.hasOwn(loaded.agents, 'reviewer'), false);
  assert.ok(
    brokenUnder(validated(loaded).errors, 'flows.default').includes(
      'flows.default.ticket.vertices.reviewer: undeclared-agent',
    ),
  );
});

test("a later Layer's null deletes what an earlier Layer set", (t) => {
  const { repo, home } = layers(t, {
    home: JSON.stringify({ agents: { implementer: { model: 'home-model', effort: 'high' } } }),
    repo: JSON.stringify({ agents: { implementer: { model: null } } }),
  });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.equal(Object.hasOwn(loaded.agents.implementer, 'model'), false);
  assert.equal(loaded.agents.implementer.effort, 'high');
});

test('a null array item stays, since an item is not a key', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({ procedures: { probe: { actions: [null] } }, testPaths: ['test/**', null] }),
  });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.deepEqual(loaded.procedures.probe.actions, [null]);
  assert.deepEqual(loaded.testPaths, ['test/**', null]);
});

test('a null key of an object in a list is left out', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({ procedures: { probe: { actions: [{ id: null, do: 'check', kind: 'command' }] } } }),
  });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.deepEqual(loaded.procedures.probe.actions, [{ do: 'check', kind: 'command' }]);
  assert.deepEqual(
    validated(loaded)
      .errors.filter((problem) => problem.at === 'procedures.probe.actions[0]')
      .map((problem) => problem.message),
    ['an Action must have an id', 'Check with no id must name a command'],
  );
});

test("a Layer's null does not reach the files key, which stays gg's own", (t) => {
  const { repo, home } = layers(t, { repo: JSON.stringify({ files: null }) });
  const { files } = config.loadLayers(repo, home);
  assert.equal(files['personas/reviewer.md'].bytes, readFileSync(personaPath('reviewer.md'), 'utf8'));
});

test('a Flow with plan left out or null resolves to plan null, with no problem', (t) => {
  const leftOut = layers(t, { repo: smallFlowLayer() });
  const present = layers(t, { repo: smallFlowLayer({ plan: null }) });
  const fromLeftOut = validated(config.loadLayers(leftOut.repo, leftOut.home));
  const fromPresent = validated(config.loadLayers(present.repo, present.home));
  assert.deepEqual(brokenUnder(fromLeftOut.errors, 'flows.small'), []);
  assert.deepEqual(brokenUnder(fromPresent.errors, 'flows.small'), []);
  assert.equal((fromLeftOut.flows.small as exampleLayer.Layer).plan, null);
  assert.equal((fromPresent.flows.small as exampleLayer.Layer).plan, null);
});

test('a Flow with a plan section reports plan-not-null', (t) => {
  assert.deepEqual(smallFlowErrors(t, { plan: { entry: 'planner' } }), ['flows.small.plan: plan-not-null']);
});

test("a resolved Flow's hash is the same for a Layer that differs only in plan: null", (t) => {
  const leftOut = layers(t, { repo: smallFlowLayer() });
  const present = layers(t, { repo: smallFlowLayer({ plan: null }) });
  const hash = config.hashOf(validated(config.loadLayers(leftOut.repo, leftOut.home)).flows.small);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(config.hashOf(validated(config.loadLayers(present.repo, present.home)).flows.small), hash);
});

test('a null ticket entry reports required-key-missing', (t) => {
  const ticket = { entry: null, routes: { '*': { end: 'needs-human' } }, vertices: { look: { procedure: 'probe' } } };
  assert.deepEqual(smallFlowErrors(t, { ticket }), ['flows.small.ticket.entry: required-key-missing']);
});

test("a Vertex's null procedure reports required-key-missing", (t) => {
  const ticket = { entry: 'look', vertices: { look: { procedure: null } } };
  assert.deepEqual(smallFlowErrors(t, { ticket }), ['flows.small.ticket.vertices.look: required-key-missing']);
});

// Left out, the second row's condition would go and the row would fire for any reason (T10).
test('a null when condition alone in a row reports invalid-rule-condition', (t) => {
  const errors = askErrors(t, {
    passed: [
      { when: { 'response.reason': 'bad-test' }, outcome: 'bad-test' },
      { when: { 'response.reason': null }, outcome: 'misscoped' },
    ],
  });
  assert.deepEqual(brokenUnder(errors, 'procedures.ask'), ['procedures.ask.passed[1]: invalid-rule-condition']);
});

test('a null when condition beside another condition reports invalid-rule-condition', (t) => {
  const errors = askErrors(t, {
    passed: [{ when: { claim: 'ok', 'response.reason': null }, outcome: 'misscoped' }],
  });
  assert.deepEqual(brokenUnder(errors, 'procedures.ask'), ['procedures.ask.passed[0]: invalid-rule-condition']);
});

// A Vertex, Agent or Outcome may be named `when`: only a row of a list holds conditions there.
test('an object named when outside a list still has its null keys left out', (t) => {
  const { repo, home } = layers(t, { repo: JSON.stringify({ agents: { when: { model: null, effort: 'high' } } }) });
  const loaded: exampleLayer.Layer = config.loadLayers(repo, home);
  assert.deepEqual(loaded.agents.when, { effort: 'high' });
});

// `where` holds values to match, as `when` does: left out, `all` would hold of every item, a blocker finding included.
test('a null where value stays, so it reports condition-value-mismatch', (t) => {
  const errors = askErrors(t, {
    actions: [
      { id: 'ask', do: 'agent', brief: 'ask.md', schema: 'ask.schema.json' },
      { id: 'verdict', do: 'check', kind: 'response', all: 'findings', where: { severity: null } },
    ],
  });
  assert.deepEqual(brokenUnder(errors, 'procedures.ask'), ['procedures.ask.actions[1]: condition-value-mismatch']);
});

test('loadLayers takes Declared Commands whole from the repository Layer', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({ commands: { test: 'npm test', 'lint-js': 'npm run lint' } }),
    home: JSON.stringify({ baseBranch: 'dev' }),
  });
  const loaded = config.loadLayers(repo, home);
  assert.deepEqual(loaded.commands, { test: 'npm test', 'lint-js': 'npm run lint' });
  assert.equal(loaded.baseBranch, 'dev');
  assert.equal(Object.hasOwn(config.loadDefaults(), 'commands'), false, 'the shipped defaults declare no commands');
});

test('loadLayers reads no Declared Commands from AGENTS.md', (t) => {
  const { repo, home } = layers(t);
  writeFileSync(join(repo, 'AGENTS.md'), '# r\n\n## Commands\n\n- test: `npm test`\n');
  assert.equal(config.loadLayers(repo, home).commands, undefined);
});

test('a commands key in the user Layer is a load error naming the file', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({ commands: { test: 'npm test' } }),
    home: JSON.stringify({ commands: { test: 'npm test' } }),
  });
  assert.throws(
    () => config.loadLayers(repo, home),
    (err: unknown) => {
      assert.equal((err as Error).message, `${config.layerPath(home)}: commands may be set only in a repository Layer`);
      return true;
    },
  );
});

test('a testPaths key in the user Layer is a load error naming the file', (t) => {
  const { repo, home } = layers(t, {
    repo: JSON.stringify({ testPaths: ['test/**'] }),
    home: JSON.stringify({ testPaths: ['spec/**'] }),
  });
  assert.throws(() => config.loadLayers(repo, home), {
    message: `${config.layerPath(home)}: testPaths may be set only in a repository Layer`,
  });
});

test('a testPaths key in the defaults Layer is a load error naming the file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-install-defaults-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyInstall(root);
  const file = join(root, 'defaults', 'gg.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testPaths: ['test/**'] }));
  // The copy's own module, so it reads the copy's defaults.
  const copied = await import(pathToFileURL(join(root, 'lib', 'config.ts')).href);
  assert.throws(() => copied.loadDefaults(), { message: `${file}: testPaths may be set only in a repository Layer` });
});

test('a Layer with a duplicate key in one object is a load error naming the file and key', (t) => {
  const repoDup = layers(t, { repo: '{"commands":{"test":"a","test":"b"}}' });
  assert.throws(() => config.loadLayers(repoDup.repo, repoDup.home), {
    message: `${config.layerPath(repoDup.repo)}: key "test" appears twice in one object`,
  });
  const userDup = layers(t, { home: '{"agents":{"implementer":{"model":"a","model":"b"}}}' });
  assert.throws(() => config.loadLayers(userDup.repo, userDup.home), {
    message: `${config.layerPath(userDup.home)}: key "model" appears twice in one object`,
  });
  // Equal keys in sibling objects, in array elements and inside a string value are not duplicates.
  const fine = layers(t, { repo: '{"a":{"k":1},"b":{"k":"\\"k\\": 2"},"c":[{"k":1},{"k":2}],"d":{"k\\"":1,"k":2}}' });
  // eslint-disable-next-line id-length -- the key the Layer's text declares
  assert.deepEqual(config.loadLayers(fine.repo, fine.home).b, { k: '"k": 2' });
});

// V8's own message names no position for an early end or a trailing comma, and quotes the Layer's text.
test('a Layer that is not JSON is a load error naming the file, line and column of its first error', (t) => {
  for (const [text, where] of [
    ['{"agents": {}\n "flows": {}}\n', '2:2: invalid JSON, comma expected'],
    ['{\n  "testPaths": [\n    "test/**",\n  ]\n}\n', '4:3: invalid JSON, value expected'],
    ['{"testPaths":\r\n  ["test/**",]}', '2:14: invalid JSON, value expected'],
    ['', '1:1: invalid JSON, value expected'],
    ['\r', '2:1: invalid JSON, value expected'],
    ['{"agents":\n  {"implementer":', '2:18: invalid JSON, value expected'],
    ['x', '1:1: invalid JSON, invalid symbol'],
    ['{"a position 5":x}', '1:17: invalid JSON, invalid symbol'],
    ['[\u000b]', '1:2: invalid JSON, invalid symbol'],
    ['{ // note\n "a": 1}', '1:3: invalid JSON, invalid comment token'],
  ]) {
    const { repo, home } = layers(t, { repo: text });
    assert.throws(() => config.loadLayers(repo, home), { message: `${config.layerPath(repo)}:${where}` });
  }
});

const layerPath = config.layerPath('repo');
// The message for a testPaths entry that is not a glob relative to the repository root.
const notAGlob = (shown: string) =>
  `${layerPath}: testPaths entry ${shown} must be a glob relative to the repository root: non-empty segments split ` +
  'by "/", no "." or ".." segment, "**" only as a whole segment, and no [ ] ? \\ : or control character';

test('commandProblems accepts a valid set and names each malformed entry', () => {
  const missing = `${layerPath} declares no test command; merge {"commands":{"test":"<command line>"}} into it`;
  assert.deepEqual(config.commandProblems({ test: 'npm test', 'lint-js': 'x' }, layerPath), []);
  assert.deepEqual(config.commandProblems(undefined, layerPath), [missing]);
  assert.deepEqual(config.commandProblems({ Test: 'npm test' }, layerPath), [
    `${layerPath}: command name "Test" must match [a-z][a-z0-9-]*`,
    missing,
  ]);
});

for (const bad of ['', '  ', 'a\nb', 'a\rb', 1, null]) {
  test(`commandProblems names a test command of ${JSON.stringify(bad)} as malformed`, () => {
    assert.deepEqual(config.commandProblems({ test: bad }, layerPath), [
      `${layerPath}: command test must be a non-empty single-line string`,
    ]);
  });
}

for (const bad of [['npm test'], 'npm test', null]) {
  test(`commandProblems names commands of ${JSON.stringify(bad)} as not an object`, () => {
    assert.deepEqual(config.commandProblems(bad, layerPath), [
      `${layerPath}: commands must be an object from name to command line`,
    ]);
  });
}

test('testPathsProblems names a missing, empty or malformed testPaths', () => {
  const notAList = `${layerPath}: testPaths must be a non-empty list of glob strings`;
  assert.deepEqual(config.testPathsProblems(['test/**', '**/*.spec.*'], layerPath), []);
  assert.deepEqual(config.testPathsProblems(undefined, layerPath), [
    `${layerPath} declares no testPaths; merge {"testPaths":["<glob>"]} into it`,
  ]);
  assert.deepEqual(config.testPathsProblems([], layerPath), [notAList]);
  assert.deepEqual(config.testPathsProblems('test/**', layerPath), [notAList]);
  assert.deepEqual(config.testPathsProblems({ globs: ['test/**'] }, layerPath), [notAList]);
  assert.deepEqual(config.testPathsProblems(['test/**', 1, '', ' ', 'a\nb', null], layerPath), [
    notAGlob('1'),
    notAGlob('""'),
    notAGlob('" "'),
    notAGlob('"a\\nb"'),
    notAGlob('null'),
  ]);
});

// Git rejects a pathspec outside the repository only when the first Attempt lists its tests, after admission's
// effects, and reads brackets, backslashes, a partial "**" and "?" (one byte of a UTF-8 name) differently from Test
// Immutability, so preflight refuses them.
test(
  'testPathsProblems names a testPaths entry git would reject ' + 'or read differently from Test Immutability',
  () => {
    assert.deepEqual(
      config.testPathsProblems(
        ['spec', 'spec/**', '**/x/**', 'de*/**/z.mjs', 'spec/é*', 'scripts/run-suite.mjs'],
        layerPath,
      ),
      [],
    );
    assert.deepEqual(
      config.testPathsProblems(['../tests/**', '/abs/**', 'C:/x/**', './test/**', 'test//x', 'test/'], layerPath),
      [
        notAGlob('"../tests/**"'),
        notAGlob('"/abs/**"'),
        notAGlob('"C:/x/**"'),
        notAGlob('"./test/**"'),
        notAGlob('"test//x"'),
        notAGlob('"test/"'),
      ],
    );
    assert.deepEqual(
      config.testPathsProblems(
        ['spec/[ab].mjs', 'spec\\a.mjs', '**.test.mjs', 'deep**', 'a/***/b', 'a\u0000b', 'spec/a?.mjs'],
        layerPath,
      ),
      [
        notAGlob('"spec/[ab].mjs"'),
        notAGlob('"spec\\\\a.mjs"'),
        notAGlob('"**.test.mjs"'),
        notAGlob('"deep**"'),
        notAGlob('"a/***/b"'),
        notAGlob('"a\\u0000b"'),
        notAGlob('"spec/a?.mjs"'),
      ],
    );
  },
);

test('this repository Layer declares the default test globs as its testPaths', (t) => {
  const { home } = layers(t);
  assert.deepEqual(config.loadLayers(repoRoot, home).testPaths, checks.DEFAULT_TEST_GLOBS);
});

// Until the cutover (grey-goo-ri issue #97): feature-flow builds this repository and reads its AGENTS.md line.
test('this repository AGENTS.md Commands line matches its repository Layer', (t) => {
  const md = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const [, list] = md.match(/^## Commands\n\n((?:- .+\n)+)/m) as RegExpMatchArray;
  // A bullet whose name is a valid command name declares that command; `fast stage` is a usage note.
  const listed = Object.fromEntries(
    [...list.matchAll(/^- ([a-z][a-z0-9-]*): `([^`]+)`/gm)].map(([, name, line]) => [name, line]),
  );
  assert.equal(listed.test, 'node scripts/run-suite.ts');
  const { home } = layers(t);
  assert.deepEqual(config.loadLayers(repoRoot, home).commands, listed);
});
