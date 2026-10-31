import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as checks from '../../lib/checks.mjs';
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
  assert.equal(config.loadDefaults().flows.default.ticket.entry, 'red');
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

test('loadConfig reads the Layer identified by layerPath', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-layer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = config.layerPath(dir);
  assert.equal(file, join(dir, '.agents', 'gg', 'gg.json'));
  mkdirSync(join(dir, '.agents', 'gg'), { recursive: true });
  writeFileSync(file, '{"baseBranch":"layer-base"}');
  assert.equal(config.loadConfig(dir, join(dir, 'no-user-layer')).baseBranch, 'layer-base');
});

test('configHash changes with persona, vertex, command and testPaths changes and ignores key order', () => {
  const defaults = config.loadDefaults();
  const base = {
    flow: flow.resolveFlow(defaults), files: defaults.files, harnesses: { claude: {} }, launchProfile: null,
    commands: { test: 'npm test' }, testPaths: ['test/**'],
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

// A copy of gg's lib and defaults installed under its own root, with `edit` applied to the copy, and the Config Hash
// input and hash it gives the defaults.
async function installed(t, install, edit = () => {}) {
  const root = join(mkdtempSync(join(tmpdir(), `gg-install-${install}-`)), 'gg');
  t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  cpSync(join(repoRoot, 'lib'), join(root, 'lib'), { recursive: true });
  cpSync(join(repoRoot, 'defaults'), join(root, 'defaults'), { recursive: true });
  edit(root);
  const c = await import(pathToFileURL(join(root, 'lib', 'config.mjs')).href);
  const defaults = c.loadDefaults();
  const input = { flow: defaults.flows.default, files: defaults.files, harnesses: {}, commands: {} };
  return { root: JSON.stringify(root).slice(1, -1), input: JSON.stringify(input), hash: c.configHash(input) };
}

test('asset bytes change the Config Hash but installation paths do not', async (t) => {
  // Two copies of gg installed under different roots must hash the shipped defaults the same.
  const one = await installed(t, 'one');
  const two = await installed(t, 'two');
  assert.ok(!one.input.includes(one.root), 'no install path in the hashed input');
  assert.ok(!two.input.includes(two.root), 'no install path in the hashed input');
  assert.equal(one.hash, two.hash);
  const edited = await installed(t, 'edited', (root) => writeFileSync(join(root, 'defaults', 'personas', 'reviewer.md'), '# reviewer, edited\n'));
  assert.notEqual(edited.hash, one.hash, 'a shipped Persona byte changes the hash');
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

// Writes `files` (name to text) beside the Layer of `root`.
function beside(root, files) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, '.agents', 'gg', name), text);
}

test('loadConfig reads each file from the Layer that declares its name', (t) => {
  const { repo, home } = layers(t, {
    repo: '{"agents":{"implementer":{"persona":"repo-implementer.md"}}}',
    home: '{"procedures":{"probe":{"actions":[{"id":"ask","do":"agent","brief":"ask.md","schema":"ask.schema.json"},{"id":"pr","do":"pr-upsert","body":"body.md"}],"recover":{"max":1,"brief":"again.md"},"claims":{"halt":{"stop":true,"comment":"stopped.md"}}}}}',
  });
  beside(repo, { 'repo-implementer.md': '# repo implementer\n' });
  beside(home, { 'ask.md': 'ask', 'ask.schema.json': '{}', 'body.md': 'body', 'again.md': 'again', 'stopped.md': 'stopped' });
  const { files } = config.loadConfig(repo, home);
  assert.deepEqual(files['repo-implementer.md'], { bytes: '# repo implementer\n', hash: sha256('# repo implementer\n') });
  assert.deepEqual(files['ask.md'], { bytes: 'ask', hash: sha256('ask') });
  assert.deepEqual(files['ask.schema.json'], { bytes: '{}', hash: sha256('{}') });
  assert.deepEqual(files['body.md'], { bytes: 'body', hash: sha256('body') });
  assert.deepEqual(files['again.md'], { bytes: 'again', hash: sha256('again') });
  assert.deepEqual(files['stopped.md'], { bytes: 'stopped', hash: sha256('stopped') });
  assert.equal(files['personas/implementer.md'].bytes, readFileSync(personaPath('implementer.md'), 'utf8'), 'the defaults keep their own files');
});

test('an inherited file reference keeps its declaring Layer', (t) => {
  const { repo, home } = layers(t, {
    home: '{"agents":{"implementer":{"persona":"shared.md"}}}',
    repo: '{"agents":{"implementer":{"harness":"claude"}},"procedures":{"probe":{"actions":[{"id":"check","do":"check","kind":"command","command":"test","recoverBrief":"fix-it.md"}]}}}',
  });
  beside(home, { 'shared.md': '# from the user Layer\n' });
  beside(repo, { 'shared.md': '# a repository file no Layer names\n', 'fix-it.md': 'fix it' });
  const c = config.loadConfig(repo, home);
  assert.equal(c.agents.implementer.persona, 'shared.md');
  assert.equal(c.files['shared.md'].bytes, '# from the user Layer\n');
  assert.equal(c.files['fix-it.md'].bytes, 'fix it');
});

test('an inline Vertex persona loads from its declaring Layer', (t) => {
  const { repo, home } = layers(t, { repo: '{"flows":{"default":{"ticket":{"vertices":{"red":{"persona":"red-persona.md"}}}}}}' });
  beside(repo, { 'red-persona.md': '# red only\n' });
  const c = config.loadConfig(repo, home);
  assert.equal(c.flows.default.ticket.vertices.red.persona, 'red-persona.md');
  assert.deepEqual(c.files['red-persona.md'], { bytes: '# red only\n', hash: sha256('# red only\n') });
});

test('a name two Layers declare for different files is a load error naming both', (t) => {
  const { repo, home } = layers(t, {
    home: '{"agents":{"implementer":{"persona":"same.md"}}}',
    repo: '{"agents":{"reviewer":{"persona":"same.md"}}}',
  });
  beside(home, { 'same.md': '# home\n' });
  beside(repo, { 'same.md': '# repo\n' });
  assert.throws(() => config.loadConfig(repo, home), {
    message: `file "same.md" is declared by ${config.layerPath(home)} and by ${config.layerPath(repo)}, each beside its own Layer; give one of them another name`,
  });
});

test('a declared file that does not exist is a load error naming the Layer file and the name', (t) => {
  const { repo, home } = layers(t, { repo: '{"agents":{"implementer":{"persona":"missing.md"}}}' });
  assert.throws(() => config.loadConfig(repo, home), { message: `${config.layerPath(repo)} names file "missing.md", which cannot be read (ENOENT)` });
});

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

test('a testPaths key in the user Layer is a load error naming the file', (t) => {
  const { repo, home } = layers(t, { repo: '{"testPaths":["test/**"]}', home: '{"testPaths":["spec/**"]}' });
  assert.throws(() => config.loadConfig(repo, home), { message: `${config.layerPath(home)}: testPaths may be set only in a repository Layer` });
});

test('a testPaths key in the defaults Layer is a load error naming the file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-install-defaults-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(repoRoot, 'lib'), join(root, 'lib'), { recursive: true });
  cpSync(join(repoRoot, 'defaults'), join(root, 'defaults'), { recursive: true });
  const file = join(root, 'defaults', 'gg.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), testPaths: ['test/**'] }));
  const c = await import(pathToFileURL(join(root, 'lib', 'config.mjs')).href);
  assert.throws(() => c.loadDefaults(), { message: `${file}: testPaths may be set only in a repository Layer` });
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

test('testPathsProblems names a missing, empty or malformed testPaths', () => {
  const notAList = `${layerFile}: testPaths must be a non-empty list of glob strings`;
  const entry = (shown) => `${layerFile}: testPaths entry ${shown} must be a glob relative to the repository root: non-empty segments split by "/", no "." or ".." segment, "**" only as a whole segment, and no [ ] ? \\ : or control character`;
  assert.deepEqual(config.testPathsProblems(['test/**', '**/*.spec.*'], layerFile), []);
  assert.deepEqual(config.testPathsProblems(undefined, layerFile), [`${layerFile} declares no testPaths; merge {"testPaths":["<glob>"]} into it`]);
  assert.deepEqual(config.testPathsProblems([], layerFile), [notAList]);
  assert.deepEqual(config.testPathsProblems('test/**', layerFile), [notAList]);
  assert.deepEqual(config.testPathsProblems({ globs: ['test/**'] }, layerFile), [notAList]);
  assert.deepEqual(config.testPathsProblems(['test/**', 1, '', ' ', 'a\nb', null], layerFile),
    [entry('1'), entry('""'), entry('" "'), entry('"a\\nb"'), entry('null')]);
});

// Git rejects a pathspec outside the repository only when the first Attempt lists its tests, after admission's effects,
// and reads brackets, backslashes, a partial "**" and "?" (one byte of a UTF-8 name) differently from Test Immutability,
// so preflight refuses them.
test('testPathsProblems names a testPaths entry git would reject or read differently from Test Immutability', () => {
  const entry = (shown) => `${layerFile}: testPaths entry ${shown} must be a glob relative to the repository root: non-empty segments split by "/", no "." or ".." segment, "**" only as a whole segment, and no [ ] ? \\ : or control character`;
  assert.deepEqual(config.testPathsProblems(['spec', 'spec/**', '**/x/**', 'de*/**/z.mjs', 'spec/é*', 'scripts/run-suite.mjs'], layerFile), []);
  assert.deepEqual(config.testPathsProblems(['../tests/**', '/abs/**', 'C:/x/**', './test/**', 'test//x', 'test/'], layerFile),
    [entry('"../tests/**"'), entry('"/abs/**"'), entry('"C:/x/**"'), entry('"./test/**"'), entry('"test//x"'), entry('"test/"')]);
  assert.deepEqual(config.testPathsProblems(['spec/[ab].mjs', 'spec\\a.mjs', '**.test.mjs', 'deep**', 'a/***/b', 'a\u0000b', 'spec/a?.mjs'], layerFile),
    [entry('"spec/[ab].mjs"'), entry('"spec\\\\a.mjs"'), entry('"**.test.mjs"'), entry('"deep**"'), entry('"a/***/b"'), entry('"a\\u0000b"'),
      entry('"spec/a?.mjs"')]);
});

test('this repository Layer declares the default test globs as its testPaths', (t) => {
  const { home } = layers(t);
  assert.deepEqual(config.loadConfig(repoRoot, home).testPaths, checks.DEFAULT_TEST_GLOBS);
});

// Until the cutover (grey-goo-ri issue #97): feature-flow builds this repository and reads its AGENTS.md line.
test('this repository AGENTS.md Commands line matches its repository Layer', (t) => {
  const md = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const [, line] = md.match(/^## Commands\n\n- test: `([^`]+)`/m);
  assert.equal(line, 'node scripts/run-suite.mjs');
  const { home } = layers(t);
  assert.deepEqual(config.loadConfig(repoRoot, home).commands, { test: line });
});
