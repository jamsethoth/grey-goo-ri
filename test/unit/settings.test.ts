import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as settings from '../../lib/settings.ts';

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
  return (
    settings.parse({
      repository: without({ ...SETTINGS.repository, ...repository }),
      user: without({ ...SETTINGS.user, ...user }),
      repositoryFile: REPOSITORY_FILE,
      userFile: USER_FILE,
    }).errors ?? []
  );
}
const firedSettings = (changes: { repository?: object; user?: object }) =>
  settingsProblems(changes).map((problem) => `${problem.at} ${problem.code}`);

test('settings that pass every check give no Problem', () => {
  assert.deepEqual(firedSettings({}), []);
});

for (const [key, value, fired] of [
  ['labelPrefix', undefined, ['labelPrefix required-key-missing']],
  ['labelPrefix', 1, ['labelPrefix not-a-string']],
  ['labelPrefix', null, ['labelPrefix not-a-string']],
  ['labelPrefix', 'a:b', ['labelPrefix invalid-name']],
  ['labelPrefix', 'a b', ['labelPrefix invalid-name']],
  ['labelPrefix', '', ['labelPrefix invalid-name']],
  ['baseBranch', undefined, ['baseBranch required-key-missing']],
  ['baseBranch', ['main'], ['baseBranch not-a-string']],
  ['baseBranch', 'a b', ['baseBranch invalid-name']],
  ['baseBranch', 'a..b', ['baseBranch invalid-name']],
  ['baseBranch', '-main', ['baseBranch invalid-name']],
  ['baseBranch', '', ['baseBranch invalid-name']],
  ['baseBranch', 'release.lock', ['baseBranch invalid-name']],
  ['baseBranch', 'release/', ['baseBranch invalid-name']],
  ['baseBranch', 'release.', ['baseBranch invalid-name']],
  ['baseBranch', 'release@{1}', ['baseBranch invalid-name']],
  ['baseBranch', 'a//b', ['baseBranch invalid-name']],
  ['baseBranch', 'a/.b', ['baseBranch invalid-name']],
  ['baseBranch', '.main', ['baseBranch invalid-name']],
  ['baseBranch', '@', ['baseBranch invalid-name']],
  ['baseBranch', 'HEAD', ['baseBranch invalid-name']],
  ['baseBranch', 'foo.lock/bar', ['baseBranch invalid-name']],
  ['baseBranch', 'release/2026.11', []],
  ['baseBranch', 'feature/a-b_c@1', []],
  ['baseBranch', 'main\u0001', ['baseBranch invalid-name']],
  ['baseBranch', 'main\u007f', ['baseBranch invalid-name']],
] as const) {
  test(`a repository ${key} of ${JSON.stringify(value)} fires ${JSON.stringify(fired)}`, () => {
    assert.deepEqual(firedSettings({ repository: { [key]: value } }), fired);
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
        `${REPOSITORY_FILE}: baseBranch "a b" must be a branch name: not "@" or HEAD, not starting with "-", "." ` +
        'or "/", not ending with "/" or ".", with no part ending ".lock", and with no "..", "//", "/.", "@{", ' +
        'whitespace, control character or any of ~ ^ : ? * [ \\',
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
for (const [key, value] of [
  ['commands', { test: 'npm test' }],
  ['testPaths', ['test/**']],
  ['approvers', ['some-login']],
  ['labelPrefix', 'gg'],
  ['baseBranch', 'main'],
] as const) {
  test(`a ${key} key in the user's gg.json is a Problem naming the file`, () => {
    assert.deepEqual(settingsProblems({ user: { [key]: value } }), [
      {
        at: `user:${key}`,
        code: 'unknown-key',
        message:
          `${USER_FILE}: ${key} belongs to the repository contract, which only the repository's gg.json declares, ` +
          `at ${REPOSITORY_FILE}`,
        params: { key, file: USER_FILE },
      },
    ]);
  });
}

// The machine settings follow the person, not the repository.
for (const [key, value] of [
  ['maxParallel', 2],
  ['worktreeRoot', '~/worktrees'],
] as const) {
  test(`a ${key} key in the repository's gg.json is a Problem naming the file`, () => {
    assert.deepEqual(settingsProblems({ repository: { [key]: value } }), [
      {
        at: key,
        code: 'unknown-key',
        message:
          `${REPOSITORY_FILE}: ${key} is a machine setting, which only the user's gg.json declares, at ` + USER_FILE,
        params: { key, file: REPOSITORY_FILE },
      },
    ]);
  });
}

// Request 3.9's migration table: feature-flow's keys name what replaces them.
for (const [key, replacement] of [
  ['plan', 'flows'],
  ['implement', 'flows'],
  ['review', 'flows'],
  ['escalate', 'flows'],
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

// The sentences the parse gives for one repository setting, the others valid, for the cases about its wording.
const repositoryMessages = (key: string, value: unknown) =>
  settingsProblems({ repository: { [key]: value } }).map((problem) => problem.message);
const commandMessages = (declared: unknown) => repositoryMessages('commands', declared);
const testPathsMessages = (testPaths: unknown) => repositoryMessages('testPaths', testPaths);
const approversMessages = (approvers: unknown) => repositoryMessages('approvers', approvers);
// The message for a testPaths entry that is not a glob relative to the repository root.
const notAGlob = (shown: string) =>
  `${REPOSITORY_FILE}: testPaths entry ${shown} must be a glob relative to the repository root: non-empty segments ` +
  'split by "/", no "." or ".." segment, "**" only as a whole segment, and no [ ] ? \\ : or control character';

test('the parse accepts a valid set of commands and names each malformed entry', () => {
  const missing = `${REPOSITORY_FILE} declares no test command; merge {"commands":{"test":"<command line>"}} into it`;
  assert.deepEqual(commandMessages({ test: 'npm test', 'lint-js': 'x' }), []);
  assert.deepEqual(commandMessages(undefined), [missing]);
  assert.deepEqual(commandMessages({ Test: 'npm test' }), [
    `${REPOSITORY_FILE}: command name "Test" must match [a-z][a-z0-9-]*`,
    missing,
  ]);
});

for (const bad of ['', '  ', 'a\nb', 'a\rb', 1, null]) {
  test(`the parse names a test command of ${JSON.stringify(bad)} as malformed`, () => {
    assert.deepEqual(commandMessages({ test: bad }), [
      `${REPOSITORY_FILE}: command test must be a non-empty single-line string`,
    ]);
  });
}

for (const bad of [['npm test'], 'npm test', null]) {
  test(`the parse names commands of ${JSON.stringify(bad)} as not an object`, () => {
    assert.deepEqual(commandMessages(bad), [
      `${REPOSITORY_FILE}: commands must be an object from name to command line`,
    ]);
  });
}

test('the parse names a missing, empty or malformed testPaths', () => {
  const notAList = `${REPOSITORY_FILE}: testPaths must be a non-empty list of glob strings`;
  assert.deepEqual(testPathsMessages(['test/**', '**/*.spec.*']), []);
  assert.deepEqual(testPathsMessages(undefined), [
    `${REPOSITORY_FILE} declares no testPaths; merge {"testPaths":["<glob>"]} into it`,
  ]);
  assert.deepEqual(testPathsMessages([]), [notAList]);
  assert.deepEqual(testPathsMessages('test/**'), [notAList]);
  assert.deepEqual(testPathsMessages({ globs: ['test/**'] }), [notAList]);
  assert.deepEqual(testPathsMessages(['test/**', 1, '', ' ', 'a\nb', null]), [
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
test('the parse names a testPaths entry git would reject ' + 'or read differently from Test Immutability', () => {
  assert.deepEqual(
    testPathsMessages(['spec', 'spec/**', '**/x/**', 'de*/**/z.mjs', 'spec/é*', 'scripts/run-suite.mjs']),
    [],
  );
  assert.deepEqual(testPathsMessages(['../tests/**', '/abs/**', 'C:/x/**', './test/**', 'test//x', 'test/']), [
    notAGlob('"../tests/**"'),
    notAGlob('"/abs/**"'),
    notAGlob('"C:/x/**"'),
    notAGlob('"./test/**"'),
    notAGlob('"test//x"'),
    notAGlob('"test/"'),
  ]);
  assert.deepEqual(
    testPathsMessages(['spec/[ab].mjs', 'spec\\a.mjs', '**.test.mjs', 'deep**', 'a/***/b', 'a\u0000b', 'spec/a?.mjs']),
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
});

test('a malformed approvers list fails admission', () => {
  const file = '/repo/.agents/gg/gg.json';
  const notAList = `${file}: approvers must be a list of GitHub logins, each non-empty with no surrounding space`;
  assert.deepEqual(approversMessages(undefined), []);
  assert.deepEqual(approversMessages([]), []);
  assert.deepEqual(approversMessages(['some-login']), []);
  assert.deepEqual(approversMessages('some-login'), [notAList]);
  assert.deepEqual(approversMessages(['']), [notAList]);
  assert.deepEqual(approversMessages([' ']), [notAList]);
  assert.deepEqual(approversMessages([' some-login ']), [notAList], 'it could never match a login');
  assert.deepEqual(approversMessages(['some-login', 3]), [notAList]);
});

/* eslint-disable id-denylist -- a Problem's key is at */
// Each repository contract problem is a Problem like the validator's (#301): located at its key, coded by the rule it
// breaks, and carrying the values its sentence names, the gg.json among them.
test('each repository contract problem carries its location, code and params', () => {
  const file = REPOSITORY_FILE;
  assert.deepEqual(settingsProblems({ repository: { commands: { Test: 'npm test', lint: '' } } }), [
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
  assert.deepEqual(codes(settingsProblems({ repository: { commands: 'npm test' } })), [
    { at: 'commands', code: 'not-an-object', params: { file } },
  ]);
  assert.deepEqual(codes(settingsProblems({ repository: { testPaths: undefined } })), [
    { at: 'testPaths', code: 'required-key-missing', params: { key: 'testPaths', file } },
  ]);
  assert.deepEqual(codes(settingsProblems({ repository: { testPaths: [] } })), [
    { at: 'testPaths', code: 'empty-list', params: { file } },
  ]);
  assert.deepEqual(codes(settingsProblems({ repository: { testPaths: 'test/**' } })), [
    { at: 'testPaths', code: 'not-a-list', params: { file } },
  ]);
  assert.deepEqual(codes(settingsProblems({ repository: { testPaths: ['test/**', '../x'] } })), [
    { at: 'testPaths[1]', code: 'invalid-glob', params: { glob: '../x', file } },
  ]);
  assert.deepEqual(codes(settingsProblems({ repository: { approvers: 'some-login' } })), [
    { at: 'approvers', code: 'not-a-list', params: { file } },
  ]);
  assert.deepEqual(codes(settingsProblems({ repository: { approvers: ['some-login', 3] } })), [
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
    settingsProblems({ repository }).map(({ at, code }) => `${at} ${code}`),
    [
      'commands invalid-name',
      'testPaths empty-list',
      'approvers not-a-list',
      'labelPrefix invalid-name',
      'baseBranch not-a-string',
    ],
  );
});

// Settings when the two files hold no error, the errors otherwise, never both: tsc then stops a caller reading Settings
// it has not checked (#362, decision 4).
test('the parse gives every Setting when the settings hold no error, and only the errors otherwise', () => {
  const configuration = (repository: object) => ({
    repository: { ...SETTINGS.repository, approvers: ['some-login'], ...repository, files: {} },
    user: { ...SETTINGS.user, files: {} },
    repositoryFile: REPOSITORY_FILE,
    userFile: USER_FILE,
  });
  assert.deepEqual(settings.parse(configuration({})), {
    settings: {
      labelPrefix: 'gg',
      baseBranch: 'main',
      worktreeRoot: '~/worktrees',
      maxParallel: 2,
      commands: { test: 'npm test' },
      testPaths: ['test/**'],
      approvers: ['some-login'],
    },
  });
  const { approvers: _approvers, ...withoutApprovers } = configuration({}).repository;
  assert.deepEqual(
    settings.parse({ ...configuration({}), repository: withoutApprovers }).settings?.approvers,
    undefined,
  );
  const failed = settings.parse(configuration({ labelPrefix: 'a:b' }));
  assert.deepEqual(Object.keys(failed), ['errors']);
  assert.deepEqual(
    failed.errors?.map((problem) => problem.code),
    ['invalid-name'],
  );
});
