import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));

// What makes a test medium (docs/testing.md, "Test sizes"), as it shows in a test file's source.
// shortcut: a text check misses a bare `sh(` or an unlisted spawning helper; a runtime guard if the fast stage slows
// (docs/testing.md, "Considered and deferred").
const MEDIUM: [RegExp, string][] = [
  [/['"](?:node:)?child_process['"]/, 'imports node:child_process'],
  [/['"](?:\.\.\/)+lib\/(?:exec|git)\.ts['"]/, 'imports lib/exec.ts or lib/git.ts'],
  [/\b(?:git|integrity):\s*['"]real['"]/, 'asks for real git'],
  [/\bset(?:Timeout|Interval)\s*\(|['"]node:timers/, 'uses a timer'],
  [
    /\b(?:golden|run|support|gitShell)\.sh\(|\b(?:holdLock|conflict|seedRepos|timeOutWhen|timedOutOrphan)\(/,
    'calls a support helper that spawns',
  ],
  [/\b(?:committingRepo|emptyWorktree|twoWorktrees)\(/, 'calls a support helper that spawns'],
  [/\b(?:rescueFixture|rescueRefs|inRef)\(/, 'calls a support helper that spawns'],
];
// This file is left out: its samples below spell every marker, and it only reads files.
const unitFiles = readdirSync(new URL('./', import.meta.url), { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file.endsWith('.test.ts') && file !== 'layout.test.ts');

const marked = [
  ["import { spawn } from 'node:child_process';", 'imports node:child_process'],
  ["import * as git from '../../lib/git.ts';", 'imports lib/exec.ts or lib/git.ts'],
  ["await golden.setup(t, { git: 'real' })", 'asks for real git'],
  ["fixture(t, { integrity: 'real' })", 'asks for real git'],
  ['await new Promise((r) => setTimeout(r, 5))', 'uses a timer'],
  ["import { setTimeout as sleep } from 'node:timers/promises';", 'uses a timer'],
  ['golden.sh(g.worktree, "log")', 'calls a support helper that spawns'],
  ['run.holdLock(t, f.commonDir, "repo")', 'calls a support helper that spawns'],
  ['committingRepo.committingRepo(t)', 'calls a support helper that spawns'],
  ['worktrees.emptyWorktree(t)', 'calls a support helper that spawns'],
  ['worktrees.twoWorktrees(t)', 'calls a support helper that spawns'],
];
for (const [text, what] of marked) {
  test(`the size check flags a unit file that ${what}: ${text}`, () => {
    assert.deepEqual(
      MEDIUM.filter(([re]) => re.test(text)).map(([, flagged]) => flagged),
      [what],
    );
  });
}

for (const file of unitFiles) {
  test(`test/unit/${file} spawns no process, uses no real git and sets no timer`, () => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.deepEqual(
      MEDIUM.filter(([re]) => re.test(text)).map(([, what]) => what),
      [],
    );
  });
}
const SKIPPED = new Set(['.git', 'node_modules']);
// Tools write these at a checkout's root, ignored or untracked: none of it is gg's code. Elsewhere the names are free.
const TOOL_OUTPUT = new Set(['.claude', 'coverage']);
const isSkipped = (path: string) => SKIPPED.has(path.split('/').at(-1) ?? '') || TOOL_OUTPUT.has(path);
function repoFiles(directory = ''): string[] {
  return readdirSync(root + directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory + entry.name;
    if (isSkipped(path)) return [];
    return entry.isDirectory() ? repoFiles(`${path}/`) : [path];
  });
}
// Every module under lib, so a new one is scanned without joining a list (grey-goo-ri issue #219).
const modules = repoFiles('lib/').filter((path) => path.endsWith('.ts'));
const codeFiles = ['lib/', 'bin/', 'scripts/', 'test/']
  .flatMap((directory) => repoFiles(directory))
  .filter((path) => path.endsWith('.ts'));

// The paths the AGENTS.md layout table names; a row ending in / covers the files under it.
const layoutRows = (agents: string) => {
  const section = /^## Layout$([\s\S]*?)^## /m.exec(agents)?.[1] ?? '';
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
};
const unlistedFiles = (files: string[], rows: string[]) =>
  files.filter((path) => !rows.some((row) => row === path || (row.endsWith('/') && path.startsWith(row))));

test('every module under lib imports', async () => {
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /^## Layout$/m);
  assert.match(agents, /^## Tests$/m);
  assert.doesNotMatch(agents, /The layout section here grows with the code/);
  for (const path of modules) {
    const mod = await import(pathToFileURL(root + path).href);
    assert.equal(typeof mod, 'object', path);
  }
});

test('every file under lib is scanned', () => {
  const libFiles = repoFiles('lib/');
  for (const path of ['lib/validate/index.ts', 'lib/reference-paths.ts', 'lib/harnesses/shipped.ts']) {
    assert.ok(modules.includes(path), `${path} is scanned`);
  }
  // Templates and the job-object script are not modules: they import nothing and run no git.
  assert.deepEqual(
    libFiles.filter((path) => !modules.includes(path) && !/\.(?:md|ps1)$/.test(path)),
    [],
  );
});

// A code file is named in lowercase words joined by hyphens, with a dot only before an area or test suffix
// (`run.branches.test.ts`), and never a grab-bag name that says nothing of its job (Angular's style guide).
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.ts$/;
const GRAB_BAG = /^(?:utils?|helpers?|common|misc|shared)\./;
const misnamed = (files: string[]) =>
  files.filter((path) => {
    const name = path.split('/').at(-1) ?? '';
    return !FILE_NAME.test(name) || GRAB_BAG.test(name);
  });

test('every code file is named in lowercase hyphenated words for its job', () => {
  const samples = ['lib/process-tree.ts', 'test/unit/run.branches.test.ts', 'lib/processTree.ts', 'lib/write_ahead.ts'];
  assert.deepEqual(misnamed([...samples, 'lib/utils.ts']), [
    'lib/processTree.ts',
    'lib/write_ahead.ts',
    'lib/utils.ts',
  ]);
  assert.ok(codeFiles.includes('lib/process-tree.ts') && codeFiles.includes('bin/gg.ts'), 'the code files are read');
  assert.deepEqual(
    misnamed(codeFiles),
    [],
    'rename the file: lowercase words joined by hyphens, named for what it does',
  );
});

test('every file under lib has a row in AGENTS.md', async () => {
  const sampleRows = ['lib/a.ts', 'lib/templates/'];
  assert.deepEqual(unlistedFiles(['lib/a.ts', 'lib/templates/t.md', 'lib/b.ts'], sampleRows), ['lib/b.ts']);
  const rows = layoutRows(await readFile(`${root}AGENTS.md`, 'utf8'));
  assert.ok(rows.includes('lib/validate/') && rows.includes('bin/gg.ts'), 'the layout table is read');
  assert.deepEqual(unlistedFiles(repoFiles('lib/'), rows), [], 'add a row to the AGENTS.md layout table');
  assert.deepEqual(
    rows.filter((path) => !existsSync(root + path)),
    [],
    'a layout row names a file that exists',
  );
});

// A helper is found by what it does, so no test/support file is named for the lib module it serves (#256's N45).
const sharingLibNames = (supportFiles: string[], libModules: string[]) => {
  const stem = (path: string) => path.replace(/^.*\//, '').replace(/\.ts$/, '');
  const libNames = new Set(libModules.map(stem));
  return supportFiles.filter((path) => libNames.has(stem(path)));
};

test('no test/support file shares a lib module name', () => {
  assert.deepEqual(
    sharingLibNames(['test/support/run.ts', 'test/support/run-fixture.ts'], ['lib/run.ts', 'lib/flow.ts']),
    ['test/support/run.ts'],
  );
  const supportFiles = repoFiles('test/support/');
  assert.ok(supportFiles.includes('test/support/execution-context.ts'), 'the support files are read');
  assert.deepEqual(sharingLibNames(supportFiles, modules), [], 'name the helper for its job, not its lib module');
});

// lib/git.ts is the one git interface (grey-goo-ri issue #144): every other module calls its verbs with gg's values.
// lib/git-temp-index.ts is its other half, which only it calls.
test('no module outside lib/git.ts passes git a command line', async () => {
  const git = await import(pathToFileURL(`${root}lib/git.ts`).href);
  assert.equal(git.runGit, undefined, 'runGit is not exported');
  const raw: [RegExp, string][] = [
    [/\brunGit\b/, 'runGit'],
    [/\b(?:run|spawn|spawnSync|execFile|execFileSync)\(\s*['"`]git['"`]/, 'a spawned git'],
    [/\^\{|\.\.\.HEAD|refs\/heads\/|['"`]HEAD['"`]/, 'git ref syntax'],
    [/['"`]:\([a-z,]+\)/, 'a git pathspec'],
    // bin/gg.ts passes lib/git.ts in; a module that imported it could fall back to it instead of the git it was given.
    [/from ['"`]\.\/git\.ts['"`]/, 'an import of lib/git.ts'],
  ];
  const others = modules.filter((path) => path !== 'lib/git.ts' && path !== 'lib/git-temp-index.ts');
  for (const path of [...others, 'bin/gg.ts', 'scripts/run-suite.ts']) {
    const text = await readFile(root + path, 'utf8');
    for (const [re, what] of raw) assert.doesNotMatch(text, re, `${path} builds ${what}`);
  }
});

// Every file gg runs from, except lib/harnesses/, the one place a Harness is named.
const filesOutsideHarnesses = [...repoFiles('lib/'), ...repoFiles('bin/')].filter(
  (path) => !path.startsWith('lib/harnesses/'),
);
const HARNESS_NAMES = /claude|codex|CLAUDE\.md|\.codex/i;

test('no module outside lib/harnesses names a Harness', () => {
  assert.ok(
    filesOutsideHarnesses.includes('lib/interpreter.ts') && filesOutsideHarnesses.includes('bin/gg.ts'),
    `scanned ${filesOutsideHarnesses.join(', ')}`,
  );
  const named = filesOutsideHarnesses.flatMap((path) =>
    readFileSync(root + path, 'utf8')
      .split('\n')
      .flatMap((line, i) => (HARNESS_NAMES.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(named, []);
});

// The one JavaScript file: ESLint 10.14 loads a .ts config only through the optional jiti package or an unstable flag.
// Revisit when ESLint loads TypeScript configs natively.
const LEGACY_MJS = ['eslint.config.mjs'];
const unlistedJavaScript = (files: string[]) =>
  files.filter((path) => /\.(?:[cm]?js|[cm]ts)$/.test(path) && !LEGACY_MJS.includes(path));

test('package.json keeps type module', async () => {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(pkg.type, 'module');
});

// Node will not strip types under node_modules, so an npm package of gg cannot start until #243 builds one (ADR 0018).
test('package.json is private, so npm refuses to publish gg until it is built for publishing', async () => {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(pkg.private, true);
});

// Only the range forms package.json uses: a bound like `<27` or a union has no single major to compare.
const rangeMajor = (range: string) => {
  const match = /^(?:\^|~|>=)(\d+)(?:\.\d+){0,2}$/.exec(range);
  assert.ok(match, `${range} is a ^, ~ or >= range`);
  return match[1];
};

// tsc checks the code against @types/node, so its major must be the Node gg runs on (ADR 0020).
test('the @types/node major in package.json is the engines.node major', async () => {
  const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  assert.equal(rangeMajor(pkg.devDependencies['@types/node']), rangeMajor(pkg.engines.node));
});

test('the major check reads ^, ~ and >= ranges and fails on any other', () => {
  assert.deepEqual(['^26.6.6', '~26.6', '>=26.13', '>=26'].map(rangeMajor), ['26', '26', '26', '26']);
  for (const range of ['<27', '*', '26.x || 27.x', '>=26 <28']) {
    assert.throws(() => rangeMajor(range), /a \^, ~ or >= range/, range);
  }
});

test('no JavaScript file is left in the code tree', () => {
  const samples = ['lib/new.mjs', 'bin/new.js', 'test/new.cjs', 'test/new.mts', 'test/new.cts'];
  assert.deepEqual(unlistedJavaScript([...LEGACY_MJS, ...samples, 'lib/new.ts']), samples);
  assert.deepEqual(unlistedJavaScript(repoFiles()), [], 'write the file as .ts (ADR 0018)');
  assert.ok(existsSync(root + LEGACY_MJS[0]), 'a converted file leaves LEGACY_MJS');
});

test('the scans skip tool output at the root only, and .git and node_modules anywhere', () => {
  const paths = ['.claude', 'coverage', '.git', 'node_modules', 'test/node_modules', 'test/coverage', 'lib/.claude'];
  assert.deepEqual(paths.filter(isSkipped), ['.claude', 'coverage', '.git', 'node_modules', 'test/node_modules']);
});

// A sample path such as lib/sample.ts is outside tsconfig.json's program, so these cases lint without types; the typed
// rules' cases below lint as a real program file.
const eslint = new ESLint({
  cwd: root,
  overrideConfig: [
    { files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked },
    { rules: { 'gg/no-map-to-json': 'off' } },
  ],
});
const lintFindings = async (filePath: string, text: string) => {
  const [result] = await eslint.lintText(text, { filePath });
  return result.messages.map((message) => message.ruleId);
};

test('the strict rules apply to a JavaScript file too', async () => {
  assert.deepEqual(await lintFindings('scripts/sample.mjs', 'export const cfg = 1;\n'), ['id-denylist']);
});

test('lint denies the name dir', async () => {
  assert.deepEqual(await lintFindings('lib/sample.ts', 'export const dir = 1;\n'), ['id-denylist']);
});

// A thrown class's name shows in String(err) and the first line of its stack. The rule reads parsed code, so a comment
// or a string that spells the name is not one, and any header is read.
const FIELD = "  name = 'AError';\n";
const IN_CONSTRUCTOR = "  constructor() {\n    super('x');\n    this.name = 'AError';\n  }\n";
const THROWN_CLASSES_FLAGGED = [
  ['with no name', 'export class AError extends Error {}\n'],
  ['with another name in a field', "export class AError extends Error {\n  name = 'BError';\n}\n"],
  [
    'with another name in its constructor',
    `export class AError extends Error {\n${IN_CONSTRUCTOR.replace('AError', 'BError')}}\n`,
  ],
  ['with its name in a line comment', "export class AError extends Error {}\n// name = 'AError';\n"],
  ['with its name in a block comment', "export class AError extends Error {}\n/*\nname = 'AError';\n*/\n"],
  ['with its name in a string', 'export class AError extends Error {}\nexport const note = "name = \'AError\'";\n'],
  [
    'with its name in a template literal',
    "export class AError extends Error {}\nexport const note = `\nname = 'AError';\n`;\n",
  ],
  [
    'with its name in a method',
    "export class AError extends Error {\n  later() {\n    this.name = 'AError';\n  }\n}\n",
  ],
  ['with its name on a static field', "export class AError extends Error {\n  static name = 'AError';\n}\n"],
  [
    'with its name set on another object',
    `export class AError extends Error {\n${IN_CONSTRUCTOR.replace('this.name', 'other.name')}}\n`,
  ],
  ['with its name on a computed field', "export class AError extends Error {\n  [name] = 'AError';\n}\n"],
  ['with its name on a private field', "export class AError extends Error {\n  #name = 'AError';\n}\n"],
  [
    'with its name set on a private field',
    `export class AError extends Error {\n  #name = '';\n${IN_CONSTRUCTOR.replace('this.name', 'this.#name')}}\n`,
  ],
  [
    'with its name added to, not set',
    "export class AError extends Error {\n  constructor() {\n    super('x');\n    this.name += 'AError';\n  }\n}\n",
  ],
  [
    'with its name set through a computed key',
    "export class AError extends Error {\n  constructor() {\n    super('x');\n    this[name] = 'AError';\n  }\n}\n",
  ],
  ['with its name in another class', `export class AError extends Error {}\nexport class Other {\n${FIELD}}\n`],
  ['with a generic', 'export class AError<Value> extends Error {\n  value?: Value;\n}\n'],
  ['with a nested generic', 'export class AError<Value extends Array<number>> extends Error {\n  value?: Value;\n}\n'],
  ['with a generic over lines', 'export class AError<\n  Value,\n> extends Error {\n  value?: Value;\n}\n'],
  ['with its header over lines', 'export class AError\n  extends Error {}\n'],
  ['through a namespace', 'export class AError extends exec.CommandError {}\n'],
  ['through a deeper namespace', 'export class AError extends outer.exec.CommandError {}\n'],
  ['as a class expression', 'export const made = class AError extends Error {};\n'],
  ['with no Error suffix', "export class Thing extends Error {\n  name = 'Thing';\n}\n"],
  [
    'with no Error suffix, through a namespace',
    "export class Thing extends exec.CommandError {\n  name = 'Thing';\n}\n",
  ],
];
const THROWN_CLASSES_PASSED = [
  ['its name in a field', `export class AError extends Error {\n${FIELD}}\n`],
  ['its name in its constructor', `export class AError extends Error {\n${IN_CONSTRUCTOR}}\n`],
  [
    'a generic and a namespace',
    `export class AError<Value> extends exec.CommandError {\n${FIELD}  value?: Value;\n}\n`,
  ],
];
const OTHER_CLASSES_PASSED = [
  ['a plain superclass', 'export class Thing extends Base {}\n'],
  ['a generic superclass', 'export class Thing<Value> extends Base<Value> {}\n'],
  ['a comment that looks like an error class', 'export class Thing<Value> extends Base<Value> {} // > extends Error\n'],
];
for (const [what, text] of THROWN_CLASSES_FLAGGED) {
  test(`lint fails a thrown class ${what}`, async () => {
    assert.deepEqual(await lintFindings('lib/sample.ts', text), ['gg/thrown-class']);
  });
}
for (const [what, text] of [...THROWN_CLASSES_PASSED, ...OTHER_CLASSES_PASSED]) {
  test(`lint passes a class with ${what}`, async () => {
    assert.deepEqual(await lintFindings('lib/sample.ts', text), []);
  });
}

test('lint reads a thrown class in every kind of code file', async () => {
  const thrown = ['gg/thrown-class'];
  const text = 'export class AError extends Error {}\n';
  assert.deepEqual(await lintFindings('test/support/sample.ts', text), thrown);
  assert.deepEqual(await lintFindings('test/unit/sample.test.ts', text), thrown);
  assert.deepEqual(await lintFindings('bin/sample.ts', text), thrown);
  assert.deepEqual(await lintFindings('scripts/sample.mjs', text), thrown);
});

// The rule keeps each call naming its module (#237). It reads parsed code, so an import a case spells in a string is
// not one.
test('lint fails a named import from lib in a test file, and not one spelled in a string', async () => {
  const sample = 'test/unit/sample.test.ts';
  assert.deepEqual(await lintFindings(sample, "import { pathKey } from '../../lib/paths.ts';\n"), [
    'no-restricted-syntax',
  ]);
  assert.deepEqual(await lintFindings(sample, "import * as paths from '../../lib/paths.ts';\n"), []);
  assert.deepEqual(await lintFindings(sample, "export const text = `\nimport { add } from '../lib/add.ts';\n`;\n"), []);
});

test('lint fails a type imported by name from lib in a test file, and allows it inside lib', async () => {
  const sample = 'test/support/sample.ts';
  const restricted = ['no-restricted-syntax'];
  assert.deepEqual(await lintFindings(sample, "import type { Deps } from '../../lib/run-context.ts';\n"), restricted);
  assert.deepEqual(await lintFindings(sample, "import { type Deps } from '../../lib/run-context.ts';\n"), restricted);
  assert.deepEqual(await lintFindings(sample, "import type * as runContext from '../../lib/run-context.ts';\n"), []);
  assert.deepEqual(await lintFindings('lib/sample.ts', "import type { Deps } from './run-context.ts';\n"), []);
});

// JSON.stringify and an object spread write a Map as {} in silence (#174, #327). The typed rules need a file of
// tsconfig.json's program, so the samples lint as this file, which nothing imports.
const typedEslint = new ESLint({ cwd: root });
const TYPED_HEADER = [
  "import type * as model from '../../lib/model.ts';",
  "import type * as record from '../../lib/record.ts';",
  "import type * as visit from '../../lib/visit.ts';",
  'declare const executionRecord: record.ExecutionRecord;',
  'declare const runContext: { record: record.ExecutionRecord };',
  'declare const running: { state: visit.VisitState };',
  'declare const state: visit.VisitState;',
  'declare const flow: model.ResolvedFlow;',
  "declare const renamed: { history: record.ExecutionRecord['visits'] };",
  'declare const byName: Record<string, Map<string, number>>;',
  'declare const partial: Partial<record.ExecutionRecord>;',
  'declare const seen: Set<string>;',
  'declare const text: string;',
];
// Each sample is linted as `export const sampleN = <sample>;`, with what the rule finds on its line.
const typedSamples = async (samples: (readonly [string, string | null])[]) => {
  const lines = [...TYPED_HEADER, ...samples.map(([sample], i) => `export const sample${i} = ${sample};`)];
  const [result] = await typedEslint.lintText(`${lines.join('\n')}\n`, { filePath: 'test/unit/layout.test.ts' });
  const found = (i: number) =>
    result.messages
      .filter((message) => message.line === TYPED_HEADER.length + i + 1)
      .map((message) => `${message.ruleId}: ${message.message}`);
  return samples.map(([sample, expected], i) => ({ sample, expected, found: found(i) }));
};
const holdsMapBoundary = async (t: TestContext, rule: string, samples: (readonly [string, string | null])[]) => {
  for (const { sample, expected, found } of await typedSamples(samples))
    await t.test(`${expected == null ? 'passes' : 'fails'} ${sample}`, () => {
      if (expected == null) assert.deepEqual(found, []);
      else {
        assert.equal(found.length, 1, found.join('\n'));
        assert.ok(found[0].startsWith(`${rule}: `) && found[0].includes(expected), found[0]);
      }
    });
};

test('lint fails JSON.stringify of a value whose type holds a Map or Set', async (t) => {
  await holdsMapBoundary(t, 'gg/no-map-to-json', [
    ['JSON.stringify(executionRecord, null, 2)', 'the value.visits (Map)'],
    ['JSON.stringify(runContext.record)', 'the value.visits (Map)'],
    ['JSON.stringify(running.state)', 'the value.runs (Map)'],
    ['JSON.stringify(state.checks)', 'the value (Map)'],
    ['JSON.stringify(executionRecord.visits)', 'the value (Map)'],
    ['JSON.stringify(flow.procedures, null, 2)', 'the value (ReadonlyMap)'],
    ['JSON.stringify(renamed.history)', 'the value (Map)'],
    ['JSON.stringify({ wrapped: executionRecord.visits })', 'the value.wrapped (Map)'],
    ['JSON.stringify(byName)', 'the value[key] (Map)'],
    ['JSON.stringify(partial)', 'the value.visits (Map)'],
    ['JSON.stringify([executionRecord])', 'the value[].visits (Map)'],
    ['JSON.stringify(seen)', 'the value (Set)'],
    [
      '<Counts extends ReadonlyMap<string, number>>(counts: Counts) => JSON.stringify(counts)',
      'the value (ReadonlyMap)',
    ],
    ['JSON.stringify(flow.name)', null],
    ['JSON.stringify(state.recovery)', null],
    ['JSON.stringify({ startedAt: new Date() })', null],
    ['JSON.stringify(executionRecord, (_key, value: unknown) => value)', null],
    ['JSON.stringify([...executionRecord.visits.values()])', null],
  ]);
});

test('lint fails an object spread of a Map, and allows a record spread and a string spread', async (t) => {
  await holdsMapBoundary(t, '@typescript-eslint/no-misused-spread', [
    ['{ ...executionRecord.visits }', 'Object.fromEntries'],
    ['{ ...flow.ticket.vertices }', 'Object.fromEntries'],
    ['{ ...executionRecord }', null],
    ['[...text]', null],
  ]);
});

// Documents agents read for today's paths. An ADR or a docs/research record is dated: it names paths as they were.
const LIVING_DOCUMENTS = [
  'AGENTS.md',
  'GLOSSARY.md',
  'README.md',
  'docs/adr/0014-procedures-are-data.md',
  'docs/interfaces/harness.md',
  'docs/library-survey.md',
  'docs/requests/node-harness-dag.md',
  'docs/testing.md',
];
// A path from the repository root, so not node_modules/eslint/bin/eslint.js or another project's src/lib/x.ts.
const CODE_PATH = /(?<![\w/.-])(?:lib|bin|scripts)\/[\w/.-]*\.(?:[cm]?js|ts)\b/g;
const codePathsIn = (text: string) => [...text.matchAll(CODE_PATH)].map((match) => match[0]);

test('a living document names only code files that exist', () => {
  assert.deepEqual(
    codePathsIn('See `lib/gone.mjs:12`, bin/gg.ts. Then node_modules/eslint/bin/eslint.js, src/lib/a.ts'),
    ['lib/gone.mjs', 'bin/gg.ts'],
  );
  const named = LIVING_DOCUMENTS.flatMap((document) => codePathsIn(readFileSync(root + document, 'utf8')));
  assert.ok(named.includes('lib/paths.ts'), 'the documents are read');
  assert.deepEqual(
    named.filter((path) => !existsSync(root + path)),
    [],
    'name the file as it is today',
  );
});
