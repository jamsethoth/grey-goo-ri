import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
import * as settings from '../../lib/settings.ts';
import * as exampleLayer from '../support/example-layer.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
// A file as loadSources gives it: its text and the hash of its bytes.
const sourceFile = (bytes: string) => ({ bytes, hash: sha256(bytes) });

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

// JSON.stringify and the hash's key sort see no entry of a Map, so a Map reaching the hash would hash as {} in silence;
// the model's toJson converts first (#174).
test('hashOf refuses a Map, which it would otherwise hash as an empty object', () => {
  assert.throws(() => config.hashOf({ flow: { vertices: new Map([['red', 1]]) } }), /Map/);
});

test('configHash changes with persona, vertex, command and testPaths changes and ignores key order', () => {
  const example = exampleLayer.config();
  const base = {
    flow: example.flows.default,
    files: Object.fromEntries(
      exampleLayer.PERSONA_NAMES.map((name) => [name, sourceFile(exampleLayer.fixtureText(name))]),
    ),
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
  const bytes = `${String(persona.files['implementer.md'].bytes)} `;
  persona.files['implementer.md'] = { bytes, hash: sha256(bytes) };
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

// gg's lib, examples, the example gg init writes and runtime dependencies copied under `root`, laid out as an install
// lays them out.
function copyInstall(root: string) {
  for (const directory of ['lib', 'examples', 'test/fixtures/example'])
    cpSync(join(repoRoot, directory), join(root, directory), { recursive: true });
  const { dependencies = {} } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const name of Object.keys(dependencies))
    cpSync(join(repoRoot, 'node_modules', name), join(root, 'node_modules', name), { recursive: true });
}

// A copy of gg installed under its own root, with `edit` applied to the copy, and the Config Hash input and hash it
// gives a repository its gg init wrote.
async function installed(t: TestContext, install: string, edit = (_root: string) => {}) {
  const root = join(mkdtempSync(join(tmpdir(), `gg-install-${install}-`)), 'gg');
  t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  copyInstall(root);
  edit(root);
  // The copy's own modules, so their paths are the copy's: a namespace import would load this checkout's.
  const copied = await import(pathToFileURL(join(root, 'lib', 'config.ts')).href);
  const copiedDoctor = await import(pathToFileURL(join(root, 'lib', 'doctor.ts')).href);
  const repo = join(root, '..', 'repo');
  copiedDoctor.init(repo, {
    baseBranch: 'main',
    userDirectory: join(root, '..', 'user'),
    commonDir: join(repo, '.git'),
  });
  const loaded = copied.loadSources(repo, join(root, '..', 'user')).repository;
  const input = { flow: loaded.flows.default, files: loaded.files, harnesses: {}, commands: {} };
  return { root: JSON.stringify(root).slice(1, -1), input: JSON.stringify(input), hash: copied.configHash(input) };
}

test('asset bytes change the Config Hash but installation paths do not', async (t) => {
  // Two copies of gg installed under different roots must hash what they ship the same.
  const one = await installed(t, 'one');
  const two = await installed(t, 'two');
  assert.ok(!one.input.includes(one.root), 'no install path in the hashed input');
  assert.ok(!two.input.includes(two.root), 'no install path in the hashed input');
  assert.equal(one.hash, two.hash);
  const edited = await installed(t, 'edited', (root) =>
    writeFileSync(join(root, 'test', 'fixtures', 'example', 'reviewer.md'), '# reviewer, edited\n'),
  );
  assert.notEqual(edited.hash, one.hash, 'a byte of a Persona gg init writes changes the hash');
});

// A repository root and a user directory, each with the gg.json text given (or none).
function sources(t: TestContext, { repo, user }: { repo?: string; user?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gg-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const roots = { repo: join(directory, 'repo'), user: join(directory, 'user') };
  const directories = { repo: config.repositoryDirectory(roots.repo), user: roots.user };
  for (const [name, text] of Object.entries({ repo, user }) as ['repo' | 'user', string | undefined][]) {
    mkdirSync(directories[name], { recursive: true });
    if (text !== undefined) writeFileSync(config.configFile(directories[name]), text);
  }
  return { ...roots, files: { repo: config.configFile(directories.repo), user: config.configFile(directories.user) } };
}

// Writes `files` (name to text) beside the gg.json in `directory`.
function beside(directory: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
}
const repositoryFiles = (repo: string, files: Record<string, string>) =>
  beside(config.repositoryDirectory(repo), files);

// The user's directory is GG_HOME, else ~/.agents/gg.
test("each source's gg.json sits in its directory, and GG_HOME moves the user's", () => {
  assert.equal(config.repositoryDirectory('/repo'), join('/repo', '.agents', 'gg'));
  assert.equal(config.configFile('/somewhere'), join('/somewhere', 'gg.json'));
  assert.equal(config.userDirectory({}, '/home/me'), join('/home/me', '.agents', 'gg'));
  assert.equal(config.userDirectory({ GG_HOME: '/elsewhere/gg' }, '/home/me'), '/elsewhere/gg');
});

test('loadSources reads each source whole, from its own gg.json', (t) => {
  const roots = sources(t, {
    repo: JSON.stringify({ baseBranch: 'trunk' }),
    user: JSON.stringify({ maxParallel: 3 }),
  });
  const loaded = config.loadSources(roots.repo, roots.user);
  assert.deepEqual(loaded.repository, { baseBranch: 'trunk', files: {} });
  assert.deepEqual(loaded.user, { maxParallel: 3, files: {} });
  assert.equal(loaded.repositoryFile, roots.files.repo);
  assert.equal(loaded.userFile, roots.files.user);
});

test('a source with no gg.json loads empty, and its required settings are Problems', (t) => {
  const roots = sources(t);
  const loaded = config.loadSources(roots.repo, roots.user);
  assert.deepEqual(loaded.repository, { files: {} });
  assert.deepEqual(loaded.user, { files: {} });
  assert.deepEqual(
    settings.sourceProblems(loaded).map((problem) => `${problem.at} ${problem.code}`),
    [
      'commands required-key-missing',
      'testPaths required-key-missing',
      'labelPrefix required-key-missing',
      'baseBranch required-key-missing',
      'user:maxParallel required-key-missing',
      'user:worktreeRoot required-key-missing',
    ],
  );
});

for (const name of ['implementer.md', 'reviewer.md']) {
  test(`loadSources reads the example Persona ${name} that gg init wrote, with its hash`, (t) => {
    const roots = sources(t);
    doctor.init(roots.repo, { baseBranch: 'main', userDirectory: roots.user, commonDir: join(roots.repo, '.git') });
    const file = readFileSync(join(config.repositoryDirectory(roots.repo), name));
    const persona = config.loadSources(roots.repo, roots.user).repository.files[name];
    assert.ok(persona, `${name} is loaded`);
    assert.equal(String(persona.bytes), file.toString('utf8'));
    assert.equal(persona.hash, sha256(file));
  });
}

// Nothing merges (ADR 0022): each source declares its own Flows, and a Flow's files resolve beside its own gg.json.
test('two sources with a same-named Flow load both, each with the files its own gg.json names', (t) => {
  const flow = { default: { ticket: { vertices: { red: { persona: 'red.md' } } } } };
  const roots = sources(t, { repo: JSON.stringify({ flows: flow }), user: JSON.stringify({ flows: flow }) });
  repositoryFiles(roots.repo, { 'red.md': '# the repository red\n' });
  beside(roots.user, { 'red.md': '# my red\n' });
  const loaded = config.loadSources(roots.repo, roots.user);
  assert.deepEqual(loaded.repository.flows, flow);
  assert.deepEqual(loaded.user.flows, flow);
  assert.deepEqual(loaded.repository.files['red.md'], sourceFile('# the repository red\n'));
  assert.deepEqual(loaded.user.files['red.md'], sourceFile('# my red\n'));
});

test('loadSources reads each file a source names beside that source', (t) => {
  const roots = sources(t, {
    user: JSON.stringify({ agents: { implementer: { persona: 'my-implementer.md' } } }),
    repo: JSON.stringify({
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
  beside(roots.user, { 'my-implementer.md': '# my implementer\n' });
  repositoryFiles(roots.repo, {
    'ask.md': 'ask',
    'ask.schema.json': '{}',
    'body.md': 'body',
    'again.md': 'again',
    'stopped.md': 'stopped',
  });
  const { repository, user } = config.loadSources(roots.repo, roots.user);
  assert.deepEqual(user.files, { 'my-implementer.md': sourceFile('# my implementer\n') });
  assert.deepEqual(repository.files, {
    'ask.md': sourceFile('ask'),
    'ask.schema.json': sourceFile('{}'),
    'body.md': sourceFile('body'),
    'again.md': sourceFile('again'),
    'stopped.md': sourceFile('stopped'),
  });
});

// A file name is a key of the source's file map, so one named after an Object.prototype property must load as data
// (#174).
test('a file named __proto__ loads like any other', (t) => {
  const name = '__proto__';
  const roots = sources(t, { repo: JSON.stringify({ agents: { implementer: { persona: name } } }) });
  // A computed key, which an object literal makes an own key; a literal __proto__: would set the prototype.
  repositoryFiles(roots.repo, { [name]: '# a persona named __proto__\n' });
  const loaded = config.loadSources(roots.repo, roots.user);
  assert.equal(config.namedFile(loaded.repository.files, name), '# a persona named __proto__\n');
});

test('an inline Vertex persona loads from its own source', (t) => {
  const roots = sources(t, {
    user: JSON.stringify({ flows: { default: { ticket: { vertices: { red: { persona: 'red-persona.md' } } } } } }),
  });
  beside(roots.user, { 'red-persona.md': '# red only\n' });
  const loaded = config.loadSources(roots.repo, roots.user);
  assert.deepEqual(loaded.user.files['red-persona.md'], sourceFile('# red only\n'));
  assert.deepEqual(loaded.repository.files, {});
});

test('a declared file that does not exist is a load error naming the gg.json and the name', (t) => {
  const roots = sources(t, { user: JSON.stringify({ agents: { implementer: { persona: 'missing.md' } } }) });
  assert.throws(() => config.loadSources(roots.repo, roots.user), {
    message: `${roots.files.user} names file "missing.md", which cannot be read (ENOENT)`,
  });
});

// In a configuration file null is never a value (#298). Nothing merges, so every null stays where it is written, for
// the validator to report.
test('a null in either source stays as written', (t) => {
  const roots = sources(t, {
    user: JSON.stringify({ agents: { reviewer: null } }),
    repo: JSON.stringify({ agents: { implementer: { effort: null } } }),
  });
  const loaded = config.loadSources(roots.repo, roots.user) as unknown as Record<string, { agents: object }>;
  assert.deepEqual(loaded.user!.agents, { reviewer: null });
  assert.deepEqual(loaded.repository!.agents, { implementer: { effort: null } });
});

test('loadSources reads no Declared Commands from AGENTS.md', (t) => {
  const roots = sources(t);
  writeFileSync(join(roots.repo, 'AGENTS.md'), '# r\n\n## Commands\n\n- test: `npm test`\n');
  assert.equal(config.loadSources(roots.repo, roots.user).repository.commands, undefined);
});

test('a gg.json with a duplicate key in one object is a load error naming the file and key', (t) => {
  const repoDuplicate = sources(t, { repo: '{"commands":{"test":"a","test":"b"}}' });
  assert.throws(() => config.loadSources(repoDuplicate.repo, repoDuplicate.user), {
    message: `${repoDuplicate.files.repo}: key "test" appears twice in one object`,
  });
  const userDuplicate = sources(t, { user: '{"agents":{"implementer":{"model":"a","model":"b"}}}' });
  assert.throws(() => config.loadSources(userDuplicate.repo, userDuplicate.user), {
    message: `${userDuplicate.files.user}: key "model" appears twice in one object`,
  });
  // Equal keys in sibling objects, in array elements and inside a string value are not duplicates.
  const fine = sources(t, { repo: '{"a":{"k":1},"b":{"k":"\\"k\\": 2"},"c":[{"k":1},{"k":2}],"d":{"k\\"":1,"k":2}}' });
  // eslint-disable-next-line id-length -- the key the gg.json's text declares
  assert.deepEqual(config.loadSources(fine.repo, fine.user).repository.b, { k: '"k": 2' });
});

// V8's own message names no position for an early end or a trailing comma, and quotes the gg.json's text.
test('a gg.json that is not JSON is a load error naming the file, line and column of its first error', (t) => {
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
    const roots = sources(t, { user: text });
    assert.throws(() => config.loadSources(roots.repo, roots.user), { message: `${roots.files.user}:${where}` });
  }
});

// The Config Hash fingerprints a Flow's content, not its source (Q25): a file the Flow does not use stays out of it.
test('usedFiles keeps only the files a Resolved Flow names', () => {
  const files = Object.fromEntries(
    ['persona.md', 'brief.md', 'a.schema.json', 'body.md', 'fix.md', 'again.md', 'stopped.md', 'unused.md'].map(
      (name) => [name, sourceFile(name)],
    ),
  );
  const flow = {
    procedures: {
      probe: {
        actions: [
          { id: 'ask', do: 'agent', brief: 'brief.md', schema: 'a.schema.json' },
          { id: 'test', do: 'check', recoverBrief: 'fix.md' },
          { id: 'pr', do: 'pr-upsert', body: 'body.md' },
        ],
        recover: { max: 1, brief: 'again.md' },
        claimTokens: { halt: { stop: true, comment: 'stopped.md' }, ok: { requires: [] } },
      },
    },
    ticket: { vertices: { red: { agent: { persona: 'persona.md' } }, publish: { agent: null } } },
  };
  const { 'unused.md': _unused, ...used } = files;
  assert.deepEqual(config.usedFiles(flow, files), used);
});

// U15, #96: the repository adds its test launcher, so Test Immutability freezes what `test` runs.
test("this repository declares the example's test globs and its suite launcher as its testPaths", (t) => {
  const { user } = sources(t);
  assert.deepEqual(config.loadSources(repoRoot, user).repository.testPaths, [
    ...exampleLayer.TEST_GLOBS,
    'scripts/run-suite.ts',
  ]);
});

// Until the cutover (grey-goo-ri issue #97): feature-flow builds this repository and reads its AGENTS.md line.
test("this repository AGENTS.md Commands line matches the repository's gg.json", (t) => {
  const md = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const [, list] = md.match(/^## Commands\n\n((?:- .+\n)+)/m) as RegExpMatchArray;
  // A bullet whose name is a valid command name declares that command; `fast stage` is a usage note.
  const listed = Object.fromEntries(
    [...list.matchAll(/^- ([a-z][a-z0-9-]*): `([^`]+)`/gm)].map(([, name, line]) => [name, line]),
  );
  assert.equal(listed.test, 'node scripts/run-suite.ts');
  const { user } = sources(t);
  assert.deepEqual(config.loadSources(repoRoot, user).repository.commands, listed);
});

test('approvers change the Config Hash, and none leaves it as it was', () => {
  const pinned = { flow: {}, files: {}, harnesses: {}, commands: {}, testPaths: [] };
  const hash = config.configHash(pinned);
  assert.notEqual(config.configHash({ ...pinned, approvers: ['some-login'] }), hash);
  assert.equal(config.configHash({ ...pinned, approvers: undefined }), hash);
});
