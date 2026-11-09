import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as config from '../../lib/config.ts';
import * as doctor from '../../lib/doctor.ts';
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
  copiedDoctor.init(repo, { baseBranch: 'main', userDirectory: join(root, '..', 'user') });
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
    config.sourceProblems(loaded).map((problem) => `${problem.at} ${problem.code}`),
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
    doctor.init(roots.repo, { baseBranch: 'main', userDirectory: roots.user });
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
  assert.equal(config.layerFile(loaded.repository.files, name), '# a persona named __proto__\n');
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

const REPOSITORY_FILE = '/repo/.agents/gg/gg.json';
const USER_FILE = '/home/.agents/gg/gg.json';
// Settings that pass every check, which a case breaks one at a time.
const SETTINGS = {
  repository: { commands: { test: 'npm test' }, testPaths: ['test/**'], labelPrefix: 'gg', baseBranch: 'main' },
  user: { maxParallel: 2, worktreeRoot: '~/worktrees' },
};
// The Problems the two sources give with `repository` and `user` set over the settings above (undefined leaves a
// key out).
function settingsProblems({ repository = {}, user = {} }: { repository?: object; user?: object }) {
  const without = (value: object) => ({
    ...Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)),
    files: {},
  });
  return config.sourceProblems({
    repository: without({ ...SETTINGS.repository, ...repository }),
    user: without({ ...SETTINGS.user, ...user }),
    repositoryFile: REPOSITORY_FILE,
    userFile: USER_FILE,
  });
}
const firedSettings = (changes: { repository?: object; user?: object }) =>
  settingsProblems(changes).map((problem) => `${problem.at} ${problem.code}`);

test('settings that pass every check give no Problem', () => {
  assert.deepEqual(firedSettings({}), []);
});

for (const [key, value, code] of [
  ['labelPrefix', undefined, 'required-key-missing'],
  ['labelPrefix', 1, 'not-a-string'],
  ['labelPrefix', null, 'not-a-string'],
  ['labelPrefix', 'a:b', 'invalid-name'],
  ['labelPrefix', 'a b', 'invalid-name'],
  ['labelPrefix', '', 'invalid-name'],
  ['baseBranch', undefined, 'required-key-missing'],
  ['baseBranch', ['main'], 'not-a-string'],
  ['baseBranch', 'a b', 'invalid-name'],
  ['baseBranch', 'a..b', 'invalid-name'],
  ['baseBranch', '-main', 'invalid-name'],
  ['baseBranch', '', 'invalid-name'],
] as const) {
  test(`a repository ${key} of ${JSON.stringify(value)} is ${code}`, () => {
    assert.deepEqual(firedSettings({ repository: { [key]: value } }), [`${key} ${code}`]);
  });
}

for (const [key, value, code] of [
  ['maxParallel', undefined, 'required-key-missing'],
  ['maxParallel', 'two', 'not-a-positive-integer'],
  ['maxParallel', 0, 'not-a-positive-integer'],
  ['maxParallel', -1, 'not-a-positive-integer'],
  ['maxParallel', 1.5, 'not-a-positive-integer'],
  ['worktreeRoot', undefined, 'required-key-missing'],
  ['worktreeRoot', 1, 'not-a-string'],
  ['worktreeRoot', '', 'not-a-string'],
  ['worktreeRoot', '  ', 'not-a-string'],
] as const) {
  test(`a user ${key} of ${JSON.stringify(value)} is ${code}`, () => {
    assert.deepEqual(firedSettings({ user: { [key]: value } }), [`user:${key} ${code}`]);
  });
}

/* eslint-disable id-denylist -- a Problem's key is at */
test('each setting Problem names its file and key', () => {
  assert.deepEqual(settingsProblems({ repository: { labelPrefix: undefined }, user: { maxParallel: 0 } }), [
    {
      at: 'labelPrefix',
      code: 'required-key-missing',
      message: `${REPOSITORY_FILE} declares no labelPrefix; set "labelPrefix": "gg" in it`,
      params: { key: 'labelPrefix', file: REPOSITORY_FILE },
    },
    {
      at: 'user:maxParallel',
      code: 'not-a-positive-integer',
      message: `${USER_FILE}: maxParallel must be a positive integer, the most Tickets a Run carries at once`,
      params: { file: USER_FILE },
    },
  ]);
  assert.deepEqual(settingsProblems({ repository: { baseBranch: 'a b' }, user: { worktreeRoot: undefined } }), [
    {
      at: 'baseBranch',
      code: 'invalid-name',
      message:
        `${REPOSITORY_FILE}: baseBranch "a b" must be a branch name: non-empty, not starting with "-", ` +
        'with no "..", whitespace or any of ~ ^ : ? * [ \\',
      params: { name: 'a b', file: REPOSITORY_FILE },
    },
    {
      at: 'user:worktreeRoot',
      code: 'required-key-missing',
      message: `${USER_FILE} declares no worktreeRoot; set it to the directory ticket worktrees go under`,
      params: { key: 'worktreeRoot', file: USER_FILE },
    },
  ]);
  assert.deepEqual(settingsProblems({ repository: { labelPrefix: 'a:b' }, user: { worktreeRoot: 3 } }), [
    {
      at: 'labelPrefix',
      code: 'invalid-name',
      message: `${REPOSITORY_FILE}: labelPrefix "a:b" must be non-empty with no ":" or whitespace`,
      params: { name: 'a:b', file: REPOSITORY_FILE },
    },
    {
      at: 'user:worktreeRoot',
      code: 'not-a-string',
      message: `${USER_FILE}: worktreeRoot must be a non-empty string`,
      params: { file: USER_FILE },
    },
  ]);
});

test('an unknown key in either gg.json is a Problem naming the file and key', () => {
  assert.deepEqual(settingsProblems({ repository: { maxParalel: 2 }, user: { labelprefix: 'gg' } }), [
    {
      at: 'maxParalel',
      code: 'unknown-key',
      message: `${REPOSITORY_FILE}: unknown key "maxParalel"`,
      params: { key: 'maxParalel', file: REPOSITORY_FILE },
    },
    {
      at: 'user:labelprefix',
      code: 'unknown-key',
      message: `${USER_FILE}: unknown key "labelprefix"`,
      params: { key: 'labelprefix', file: USER_FILE },
    },
  ]);
});

// The repository contract is the repository's alone (ADR 0022): no Flow, and no user, sets it.
for (const key of ['commands', 'testPaths', 'approvers', 'labelPrefix', 'baseBranch']) {
  test(`a ${key} key in the user's gg.json is a Problem naming the file`, () => {
    assert.deepEqual(
      settingsProblems({ user: { [key]: (SETTINGS.repository as Record<string, unknown>)[key] ?? [] } }),
      [
        {
          at: `user:${key}`,
          code: 'unknown-key',
          message:
            `${USER_FILE}: ${key} belongs to the repository contract, which only the repository's gg.json declares, ` +
            `at ${REPOSITORY_FILE}`,
          params: { key, file: USER_FILE },
        },
      ],
    );
  });
}

// The machine settings follow the person, not the repository.
for (const key of ['maxParallel', 'worktreeRoot']) {
  test(`a ${key} key in the repository's gg.json is a Problem naming the file`, () => {
    assert.deepEqual(firedSettings({ repository: { [key]: (SETTINGS.user as Record<string, unknown>)[key] } }), [
      `${key} unknown-key`,
    ]);
    assert.match(
      settingsProblems({ repository: { [key]: (SETTINGS.user as Record<string, unknown>)[key] } })[0]!.message,
      new RegExp(`is a machine setting, which only the user's gg\\.json declares`),
    );
  });
}

// Request 3.9's migration table: feature-flow's keys name what replaces them.
for (const [key, replacement] of [
  ['stageTools', 'agents'],
  ['toolkit', 'harnesses'],
  ['escalationEnabled', 'flows'],
  ['maxReviewRounds', 'flows'],
  ['contextBudget', 'agents'],
] as const) {
  test(`feature-flow's ${key} key is an unknown key naming ${replacement}`, () => {
    const [problem] = settingsProblems({ repository: { [key]: true } });
    assert.equal(problem?.code, 'unknown-key');
    assert.equal(
      problem?.message,
      `${REPOSITORY_FILE}: unknown key "${key}", which feature-flow read; gg declares it under ${replacement}`,
    );
  });
}

// An unqualified Flow name is the repository's and user:<name> the user's, so no repository Flow takes that form.
test('a repository Flow named user:<name> is a reserved name', () => {
  assert.deepEqual(firedSettings({ repository: { flows: { 'user:strict': {} } } }), [
    'flows.user:strict reserved-name',
  ]);
});
/* eslint-enable id-denylist */

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

// The sentences a repository Layer check gives, for the cases about its wording.
const commandMessages = (declared: unknown, file: string) =>
  config.commandProblems(declared, file).map((problem) => problem.message);
const testPathsMessages = (testPaths: unknown, file: string) =>
  config.testPathsProblems(testPaths, file).map((problem) => problem.message);
const approversMessages = (approvers: unknown, file: string) =>
  config.approversProblems(approvers, file).map((problem) => problem.message);
// The message for a testPaths entry that is not a glob relative to the repository root.
const notAGlob = (shown: string) =>
  `${REPOSITORY_FILE}: testPaths entry ${shown} must be a glob relative to the repository root: non-empty segments ` +
  'split by "/", no "." or ".." segment, "**" only as a whole segment, and no [ ] ? \\ : or control character';

test('commandProblems accepts a valid set and names each malformed entry', () => {
  const missing = `${REPOSITORY_FILE} declares no test command; merge {"commands":{"test":"<command line>"}} into it`;
  assert.deepEqual(commandMessages({ test: 'npm test', 'lint-js': 'x' }, REPOSITORY_FILE), []);
  assert.deepEqual(commandMessages(undefined, REPOSITORY_FILE), [missing]);
  assert.deepEqual(commandMessages({ Test: 'npm test' }, REPOSITORY_FILE), [
    `${REPOSITORY_FILE}: command name "Test" must match [a-z][a-z0-9-]*`,
    missing,
  ]);
});

for (const bad of ['', '  ', 'a\nb', 'a\rb', 1, null]) {
  test(`commandProblems names a test command of ${JSON.stringify(bad)} as malformed`, () => {
    assert.deepEqual(commandMessages({ test: bad }, REPOSITORY_FILE), [
      `${REPOSITORY_FILE}: command test must be a non-empty single-line string`,
    ]);
  });
}

for (const bad of [['npm test'], 'npm test', null]) {
  test(`commandProblems names commands of ${JSON.stringify(bad)} as not an object`, () => {
    assert.deepEqual(commandMessages(bad, REPOSITORY_FILE), [
      `${REPOSITORY_FILE}: commands must be an object from name to command line`,
    ]);
  });
}

test('testPathsProblems names a missing, empty or malformed testPaths', () => {
  const notAList = `${REPOSITORY_FILE}: testPaths must be a non-empty list of glob strings`;
  assert.deepEqual(testPathsMessages(['test/**', '**/*.spec.*'], REPOSITORY_FILE), []);
  assert.deepEqual(testPathsMessages(undefined, REPOSITORY_FILE), [
    `${REPOSITORY_FILE} declares no testPaths; merge {"testPaths":["<glob>"]} into it`,
  ]);
  assert.deepEqual(testPathsMessages([], REPOSITORY_FILE), [notAList]);
  assert.deepEqual(testPathsMessages('test/**', REPOSITORY_FILE), [notAList]);
  assert.deepEqual(testPathsMessages({ globs: ['test/**'] }, REPOSITORY_FILE), [notAList]);
  assert.deepEqual(testPathsMessages(['test/**', 1, '', ' ', 'a\nb', null], REPOSITORY_FILE), [
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
      testPathsMessages(
        ['spec', 'spec/**', '**/x/**', 'de*/**/z.mjs', 'spec/é*', 'scripts/run-suite.mjs'],
        REPOSITORY_FILE,
      ),
      [],
    );
    assert.deepEqual(
      testPathsMessages(['../tests/**', '/abs/**', 'C:/x/**', './test/**', 'test//x', 'test/'], REPOSITORY_FILE),
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
      testPathsMessages(
        ['spec/[ab].mjs', 'spec\\a.mjs', '**.test.mjs', 'deep**', 'a/***/b', 'a\u0000b', 'spec/a?.mjs'],
        REPOSITORY_FILE,
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

test('a malformed approvers list fails admission', () => {
  const file = '/repo/.agents/gg/gg.json';
  const notAList = `${file}: approvers must be a list of GitHub logins, each non-empty with no surrounding space`;
  assert.deepEqual(approversMessages(undefined, file), []);
  assert.deepEqual(approversMessages([], file), []);
  assert.deepEqual(approversMessages(['some-login'], file), []);
  assert.deepEqual(approversMessages('some-login', file), [notAList]);
  assert.deepEqual(approversMessages([''], file), [notAList]);
  assert.deepEqual(approversMessages([' '], file), [notAList]);
  assert.deepEqual(approversMessages([' some-login '], file), [notAList], 'it could never match a login');
  assert.deepEqual(approversMessages(['some-login', 3], file), [notAList]);
});

test('approvers change the Config Hash, and none leaves it as it was', () => {
  const pinned = { flow: {}, files: {}, harnesses: {}, commands: {}, testPaths: [] };
  const hash = config.configHash(pinned);
  assert.notEqual(config.configHash({ ...pinned, approvers: ['some-login'] }), hash);
  assert.equal(config.configHash({ ...pinned, approvers: undefined }), hash);
});

/* eslint-disable id-denylist -- a Problem's key is at */
// Each repository contract problem is a Problem like the validator's (#301): located at its key, coded by the rule it
// breaks, and carrying the values its sentence names, the gg.json among them.
test('each repository contract problem carries its location, code and params', () => {
  const file = REPOSITORY_FILE;
  assert.deepEqual(config.commandProblems({ Test: 'npm test', lint: '' }, file), [
    {
      at: 'commands',
      code: 'invalid-name',
      message: `${file}: command name "Test" must match [a-z][a-z0-9-]*`,
      params: { name: 'Test', file },
    },
    {
      at: 'commands.lint',
      code: 'invalid-command-line',
      message: `${file}: command lint must be a non-empty single-line string`,
      params: { command: 'lint', file },
    },
    {
      at: 'commands',
      code: 'required-key-missing',
      message: `${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it`,
      params: { key: 'test', file },
    },
  ]);
  const codes = (problems: { at: string; code: string; params?: unknown }[]) =>
    problems.map(({ at, code, params }) => ({ at, code, params }));
  assert.deepEqual(codes(config.commandProblems('npm test', file)), [
    { at: 'commands', code: 'not-an-object', params: { file } },
  ]);
  assert.deepEqual(codes(config.testPathsProblems(undefined, file)), [
    { at: 'testPaths', code: 'required-key-missing', params: { key: 'testPaths', file } },
  ]);
  assert.deepEqual(codes(config.testPathsProblems([], file)), [
    { at: 'testPaths', code: 'empty-list', params: { file } },
  ]);
  assert.deepEqual(codes(config.testPathsProblems('test/**', file)), [
    { at: 'testPaths', code: 'not-a-list', params: { file } },
  ]);
  assert.deepEqual(codes(config.testPathsProblems(['test/**', '../x'], file)), [
    { at: 'testPaths[1]', code: 'invalid-glob', params: { glob: '../x', file } },
  ]);
  assert.deepEqual(codes(config.approversProblems('some-login', file)), [
    { at: 'approvers', code: 'not-a-list', params: { file } },
  ]);
  assert.deepEqual(codes(config.approversProblems(['some-login', 3], file)), [
    { at: 'approvers', code: 'invalid-name', params: { file } },
  ]);
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('the repository contract problems are its commands, testPaths, approvers, labelPrefix and baseBranch problems, in that order', () => {
  const repository = {
    commands: { Test: 'x', test: 'x' },
    testPaths: [],
    approvers: 3,
    labelPrefix: 'a:b',
    baseBranch: 1,
  };
  assert.deepEqual(
    config.contractProblems(repository, REPOSITORY_FILE).map(({ at, code }) => `${at} ${code}`),
    [
      'commands invalid-name',
      'testPaths empty-list',
      'approvers not-a-list',
      'labelPrefix invalid-name',
      'baseBranch not-a-string',
    ],
  );
});
