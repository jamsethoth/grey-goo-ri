import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as config from '../../lib/config.mjs';
import * as flow from '../../lib/flow.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const personaPath = (name) => join(repoRoot, 'defaults', 'personas', name);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Rebuilds an object with every key in reverse order, so only key order differs.
const reversed = (value) => Array.isArray(value) ? value.map(reversed)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
    : value;

test('loadDefaults reads the shipped flow', () => {
  assert.equal(config.loadDefaults().flows.default.ticket.entry, 'implementer');
});

for (const name of ['implementer.md', 'reviewer.md']) {
  test(`loadDefaults reads the shipped persona ${name} with its hash`, () => {
    const file = readFileSync(personaPath(name));
    const persona = config.loadDefaults().personas[name];
    assert.ok(persona, `${name} is loaded`);
    assert.equal(String(persona.bytes), file.toString('utf8'));
    assert.equal(persona.hash, sha256(file));
  });
}

test('loadConfig reads the Layer identified by layerPath', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-layer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = config.layerPath(dir);
  assert.equal(file, join(dir, '.agents', 'gg', 'gg.json'));
  mkdirSync(join(dir, '.agents', 'gg'), { recursive: true });
  writeFileSync(file, '{"baseBranch":"layer-base"}');
  assert.equal(config.loadConfig(dir, join(dir, 'no-user-layer')).baseBranch, 'layer-base');
});

test('configHash changes with persona, vertex and command changes and ignores key order', () => {
  const defaults = config.loadDefaults();
  const base = {
    flow: flow.resolveFlow(defaults), personas: defaults.personas, harnesses: { claude: {} }, launchProfile: null,
    commands: { test: 'npm test' },
  };
  const hash = config.configHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(config.configHash(structuredClone(base)), hash, 'stable for equal input');
  assert.equal(config.configHash(reversed(base)), hash, 'stable across key order');

  const persona = structuredClone(base);
  const bytes = `${String(persona.personas['implementer.md'].bytes)} `;
  persona.personas['implementer.md'] = { bytes, hash: sha256(bytes) };
  assert.notEqual(config.configHash(persona), hash, 'a Persona byte changes the hash');

  const vertex = structuredClone(base);
  vertex.flow.ticket.vertices.reviewer.route.changes.max = 3;
  assert.notEqual(config.configHash(vertex), hash, 'a Vertex field changes the hash');

  const command = structuredClone(base);
  command.commands.test = 'npm run test:all';
  assert.notEqual(config.configHash(command), hash, 'a Declared Command changes the hash');
});

// A copy of gg's lib and defaults installed under its own root, and the Config Hash input and hash it gives the defaults.
async function installed(t, install) {
  const root = join(mkdtempSync(join(tmpdir(), `gg-install-${install}-`)), 'gg');
  t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  cpSync(join(repoRoot, 'lib'), join(root, 'lib'), { recursive: true });
  cpSync(join(repoRoot, 'defaults'), join(root, 'defaults'), { recursive: true });
  const c = await import(pathToFileURL(join(root, 'lib', 'config.mjs')).href);
  const f = await import(pathToFileURL(join(root, 'lib', 'flow.mjs')).href);
  const defaults = c.loadDefaults();
  const input = { flow: f.resolveFlow(defaults), personas: defaults.personas, harnesses: {}, commands: {} };
  return { root: JSON.stringify(root).slice(1, -1), input: JSON.stringify(input), hash: c.configHash(input) };
}

test('the Config Hash does not depend on the install path', async (t) => {
  // Two copies of gg installed under different roots must hash the shipped defaults the same.
  const one = await installed(t, 'one');
  const two = await installed(t, 'two');
  assert.ok(!one.input.includes(one.root), 'no install path in the hashed input');
  assert.ok(!two.input.includes(two.root), 'no install path in the hashed input');
  assert.equal(one.hash, two.hash);
});

// A repository root and a home directory, each with the Layer text given (or none).
function layers(t, { repo, home } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roots = { repo: join(dir, 'repo'), home: join(dir, 'home') };
  for (const [name, text] of Object.entries({ repo, home })) {
    mkdirSync(join(roots[name], '.agents', 'gg'), { recursive: true });
    if (text !== undefined) writeFileSync(config.layerPath(roots[name]), text);
  }
  return roots;
}

test('loadConfig takes Declared Commands whole from the repository Layer', (t) => {
  const { repo, home } = layers(t, { repo: '{"commands":{"test":"npm test","lint-js":"npm run lint"}}', home: '{"baseBranch":"dev"}' });
  const c = config.loadConfig(repo, home);
  assert.deepEqual(c.commands, { test: 'npm test', 'lint-js': 'npm run lint' });
  assert.equal(c.baseBranch, 'dev');
  assert.equal(Object.hasOwn(config.loadDefaults(), 'commands'), false, 'the shipped defaults declare no commands');
});

test('loadConfig reads no Declared Commands from AGENTS.md', (t) => {
  const { repo, home } = layers(t);
  writeFileSync(join(repo, 'AGENTS.md'), '# r\n\n## Commands\n\n- test: `npm test`\n');
  assert.equal(config.loadConfig(repo, home).commands, undefined);
});

test('a commands key in the user Layer is a load error naming the file', (t) => {
  const { repo, home } = layers(t, { repo: '{"commands":{"test":"npm test"}}', home: '{"commands":{"test":"npm test"}}' });
  assert.throws(() => config.loadConfig(repo, home), (err) => {
    assert.equal(err.message, `${config.layerPath(home)}: commands may be set only in a repository Layer`);
    return true;
  });
});

test('a Layer with a duplicate key in one object is a load error naming the file and key', (t) => {
  const repoDup = layers(t, { repo: '{"commands":{"test":"a","test":"b"}}' });
  assert.throws(() => config.loadConfig(repoDup.repo, repoDup.home),
    { message: `${config.layerPath(repoDup.repo)}: key "test" appears twice in one object` });
  const userDup = layers(t, { home: '{"agents":{"implementer":{"model":"a","model":"b"}}}' });
  assert.throws(() => config.loadConfig(userDup.repo, userDup.home),
    { message: `${config.layerPath(userDup.home)}: key "model" appears twice in one object` });
  // Equal keys in sibling objects, in array elements and inside a string value are not duplicates.
  const fine = layers(t, { repo: '{"a":{"k":1},"b":{"k":"\\"k\\": 2"},"c":[{"k":1},{"k":2}],"d":{"k\\"":1,"k":2}}' });
  assert.deepEqual(config.loadConfig(fine.repo, fine.home).b, { k: '"k": 2' });
});

const layerFile = config.layerPath('repo');

test('commandProblems accepts a valid set and names each malformed entry', () => {
  const missing = `${layerFile} declares no test command; merge {"commands":{"test":"<command line>"}} into it`;
  assert.deepEqual(config.commandProblems({ test: 'npm test', 'lint-js': 'x' }, layerFile), []);
  assert.deepEqual(config.commandProblems(undefined, layerFile), [missing]);
  assert.deepEqual(config.commandProblems({ Test: 'npm test' }, layerFile), [`${layerFile}: command name "Test" must match [a-z][a-z0-9-]*`, missing]);
});

for (const bad of ['', '  ', 'a\nb', 'a\rb', 1, null]) {
  test(`commandProblems names a test command of ${JSON.stringify(bad)} as malformed`, () => {
    assert.deepEqual(config.commandProblems({ test: bad }, layerFile), [`${layerFile}: command test must be a non-empty single-line string`]);
  });
}

for (const bad of [['npm test'], 'npm test', null]) {
  test(`commandProblems names commands of ${JSON.stringify(bad)} as not an object`, () => {
    assert.deepEqual(config.commandProblems(bad, layerFile), [`${layerFile}: commands must be an object from name to command line`]);
  });
}

// Until the cutover (grey-goo-ri issue #97): feature-flow builds this repository and reads its AGENTS.md line.
test('this repository AGENTS.md Commands line matches its repository Layer', (t) => {
  const md = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const [, line] = md.match(/^## Commands\n\n- test: `([^`]+)`/m);
  assert.equal(line, 'node scripts/run-suite.mjs');
  const { home } = layers(t);
  assert.deepEqual(config.loadConfig(repoRoot, home).commands, { test: line });
});
