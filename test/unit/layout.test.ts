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
  // lib/git.ts's helper modules, which it builds its verbs from, run git as it does.
  const gitModules = ['lib/git.ts', 'lib/git-temp-index.ts', 'lib/git-default-branch.ts'];
  const others = modules.filter((path) => !gitModules.includes(path));
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

// The read side of the event log takes its Event types from lib/event-read.ts's check, never from an assertion or
// an `any` (#350): the type-aware rules, on exactly the lib modules that read through it.
const READ_SIDE_RULES = [
  '@typescript-eslint/no-unsafe-type-assertion',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-return',
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-call',
];

// An import of lib/event-read.ts from lib/ or any directory under it.
const IMPORTS_EVENT_READ = /from '(?:\.\.?\/)+event-read\.ts'/;

test('the importer census finds lib/event-read.ts imported from any lib directory', () => {
  const specifiers = ["from './event-read.ts'", "from '../event-read.ts'", "from '../../event-read.ts'"];
  assert.deepEqual(
    specifiers.filter((specifier) => !IMPORTS_EVENT_READ.test(specifier)),
    [],
  );
  assert.equal(IMPORTS_EVENT_READ.test("from './events.ts'"), false);
});

test('the read-side rules hold exactly the lib modules that import lib/event-read.ts', async () => {
  const configured = new ESLint({ cwd: root });
  const libFiles = readdirSync(`${root}lib`, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `lib/${file.replaceAll('\\', '/')}`);
  const importers = libFiles.filter(
    (file) => file === 'lib/event-read.ts' || IMPORTS_EVENT_READ.test(readFileSync(root + file, 'utf8')),
  );
  assert.ok(importers.includes('lib/terminal-report.ts'), importers.join());
  const ruled: string[] = [];
  for (const file of libFiles) {
    const { rules } = await configured.calculateConfigForFile(file);
    const severities = READ_SIDE_RULES.map((rule) => [rule, rules?.[rule]?.[0] ?? 0]);
    if (severities.some(([, severity]) => severity !== 0)) {
      assert.deepEqual(
        severities,
        READ_SIDE_RULES.map((rule) => [rule, 2]),
        file,
      );
      ruled.push(file);
    }
  }
  assert.deepEqual(ruled, importers);
});

test('lint fails an Event typed by an assertion or an any on the read side, in any form', async () => {
  const header = [
    "import type * as events from './events.ts';",
    'declare const value: unknown;',
    'declare const text: string;',
    'declare const end: events.TicketEndEvent;',
    'declare const takes: (event: events.Event) => void;',
    'type ReadEvent =',
    '  | events.TicketEndEvent',
    '  | null;',
    'type Wrapped<Extra> = events.Event & Extra;',
    'type OfAlias = ReadEvent;',
  ];
  const samples: [string, string | null][] = [
    ['export const a = value as events.Event;', 'no-unsafe-type-assertion'],
    ['export const b = text as unknown as events.ActionEvent;', 'no-unsafe-type-assertion'],
    ['export const c = value as ReadEvent;', 'no-unsafe-type-assertion'],
    ['export const d = value as Wrapped<{ extra: 1 }>;', 'no-unsafe-type-assertion'],
    ['export const e = value as OfAlias;', 'no-unsafe-type-assertion'],
    ['export const f = value as readonly events.Event[];', 'no-unsafe-type-assertion'],
    ['export const g = <events.Event>value;', 'no-unsafe-type-assertion'],
    ['export const h = (): events.Event => JSON.parse(text);', 'no-unsafe-return'],
    ['export const i: events.Event = JSON.parse(text);', 'no-unsafe-assignment'],
    ['export const j = takes(JSON.parse(text));', 'no-unsafe-argument'],
    ['export const k = end as events.Event;', null],
    ["export const l = 'action' as const;", null],
  ];
  const text = [...header, ...samples.map(([sample]) => sample)].join('\n');
  const [result] = await typedEslint.lintText(`${text}\n`, { filePath: 'lib/event-read.ts' });
  const found = samples.map((_sample, index) =>
    result.messages
      .filter((message) => message.line === header.length + index + 1 && message.ruleId?.includes('no-unsafe'))
      .map((message) => message.ruleId),
  );
  assert.deepEqual(
    found,
    samples.map(([, rule]) => (rule ? [`@typescript-eslint/${rule}`] : [])),
  );
});

// gg's own code narrows what JSON.parse gives with a check, so an assertion on it is refused however it is spelled; a
// test may type a parse by what the case expects (#354).
const PARSE_ASSERTIONS = [
  'JSON.parse(text) as string',
  '(JSON.parse(text)) as string',
  '<string>JSON.parse(text)',
  'JSON.parse(text) as unknown as string',
  'globalThis.JSON.parse(text) as string',
  "JSON['parse'](text) as string",
  'JSON.parse(text)! as string',
];
const OTHER_ASSERTIONS = ['parser.parse(text) as string', 'JSON.stringify(text) as string', "'parse' as const"];
const parseAssertions = async (filePath: string, samples: string[]) => {
  const header = ['declare const text: string;', 'declare const parser: { parse(source: string): unknown };'];
  const lines = [...header, ...samples.map((sample, i) => `export const sample${i} = ${sample};`)];
  const [result] = await typedEslint.lintText(`${lines.join('\n')}\n`, { filePath });
  return samples.map((sample, i) => [
    sample,
    result.messages.filter(
      (message) => message.line === header.length + i + 1 && message.ruleId === 'gg/no-json-parse-assertion',
    ).length,
  ]);
};

test('lint fails an assertion on what JSON.parse gives in lib, bin and scripts, and not in a test', async (t) => {
  for (const filePath of ['lib/config.ts', 'bin/gg.ts', 'scripts/run-suite.ts']) {
    const found = await parseAssertions(filePath, [...PARSE_ASSERTIONS, ...OTHER_ASSERTIONS]);
    await t.test(`in ${filePath}`, () => {
      assert.deepEqual(found, [
        ...PARSE_ASSERTIONS.map((sample) => [sample, 1]),
        ...OTHER_ASSERTIONS.map((sample) => [sample, 0]),
      ]);
    });
  }
  assert.deepEqual(
    await parseAssertions('test/unit/layout.test.ts', PARSE_ASSERTIONS),
    PARSE_ASSERTIONS.map((sample) => [sample, 0]),
  );
});

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
  'declare const readonlyMap: Readonly<Map<string, number>>;',
  'declare const readonlySet: Readonly<Set<string>>;',
  'class VisitCounts extends Map<string, number> {}',
  'declare const serialised: { counts: Map<string, number> } & { toJSON(): string };',
  'declare const nested: { deeper: { counts: Map<string, number> }; shallow: Map<string, number> | null };',
  'declare const flows: Record<string, model.ResolvedFlowJson>;',
  'declare const savedRow: record.ExecutionRecordJson;',
  'declare const maybeReplacer: ((key: string, value: unknown) => unknown) | undefined;',
  'const local = { stringify: (value: unknown) => String(value) };',
  'class TrackedCounts extends Map<string, number> {',
  '  override has(key: string) {',
  '    return super.has(key);',
  '  }',
  '}',
  'declare const either: Map<string, number> | Set<string>;',
  "declare const hasOnly: Pick<Map<string, number>, 'has'>;",
  "declare const getOnly: Pick<Map<string, number>, 'get'>;",
  "declare const withoutClear: Omit<Map<string, number>, 'clear'>;",
  "declare const withoutHas: Omit<Map<string, number>, 'has'>;",
  'declare const converting: (key: string, value: unknown) => unknown;',
  'declare const replacers: (typeof converting)[];',
  'declare const argumentsTuple: [Map<string, number>, ...typeof replacers];',
  'declare const pickNone: Pick<Map<string, number>, never>;',
  'declare const omitAll: Omit<Map<string, number>, keyof Map<string, number>>;',
  "declare const rejoined: Omit<Map<string, number>, 'clear'> & Pick<Map<string, number>, 'clear'>;",
  'declare const maybeMap: Pick<Map<string, number> | null, never>;',
  'declare const leading: readonly [Map<string, number>?];',
  'type Visits = Map<string, number>;',
  'declare const bySymbol: Record<symbol, Map<string, number>>;',
  'class Holder {',
  '  #counts = new Map<string, number>();',
  '  label = String(this.#counts.size);',
  '}',
];
// Each sample is linted as `export const sampleN = <sample>;`, with what the rules find on its line.
const typedFindings = async (samples: string[]) => {
  const lines = [...TYPED_HEADER, ...samples.map((sample, i) => `export const sample${i} = ${sample};`)];
  const [result] = await typedEslint.lintText(`${lines.join('\n')}\n`, { filePath: 'test/unit/layout.test.ts' });
  return samples.map((_sample, i) => result.messages.filter((message) => message.line === TYPED_HEADER.length + i + 1));
};
const holdsMapBoundary = async (
  t: TestContext,
  { rule, flagged, passed }: { rule: string; flagged: [string, string][]; passed: string[] },
) => {
  const found = await typedFindings([...flagged.map(([sample]) => sample), ...passed]);
  for (const [i, [sample, where]] of flagged.entries())
    await t.test(`fails ${sample}`, () => {
      assert.deepEqual(
        found[i].map((message) => message.ruleId),
        [rule],
      );
      assert.ok(found[i][0].message.includes(where), found[i][0].message);
    });
  for (const [i, sample] of passed.entries())
    await t.test(`passes ${sample}`, () => {
      assert.deepEqual(found[flagged.length + i], []);
    });
};

test('lint fails JSON.stringify of a value whose type holds a Map or Set', async (t) => {
  await holdsMapBoundary(t, {
    rule: 'gg/no-map-to-json',
    flagged: [
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
      ['JSON.stringify(readonlyMap)', 'the value (Map)'],
      ['JSON.stringify(readonlySet)', 'the value (Set)'],
      ['JSON.stringify(new VisitCounts())', 'the value (Map)'],
      ['JSON.stringify(nested)', 'the value.shallow (Map)'],
      ['JSON.stringify(executionRecord, undefined, 2)', 'the value.visits (Map)'],
      ["JSON.stringify(executionRecord, ['visits'])", 'the value.visits (Map)'],
      ['JSON.stringify(executionRecord, maybeReplacer)', 'the value.visits (Map)'],
      ['globalThis.JSON.stringify(executionRecord)', 'the value.visits (Map)'],
      ["JSON['stringify'](executionRecord)", 'the value.visits (Map)'],
      ['JSON.stringify(new TrackedCounts())', 'the value (Map)'],
      ['JSON.stringify(either)', 'the value (Map)'],
    ],
    passed: [
      'JSON.stringify(flow.name)',
      'JSON.stringify(state.recovery)',
      'JSON.stringify(flows)',
      'JSON.stringify(savedRow, null, 2)',
      'JSON.stringify({ startedAt: new Date() })',
      'JSON.stringify(serialised)',
      'JSON.stringify(executionRecord, (_key, value: unknown) => value)',
      'JSON.stringify([...executionRecord.visits.values()])',
      'local.stringify(executionRecord)',
      'JSON.stringify(Object.fromEntries(executionRecord.visits))',
    ],
  });
});

test("lint fails JSON.stringify of a slice of a Map's type, and reads spread arguments", async (t) => {
  await holdsMapBoundary(t, {
    rule: 'gg/no-map-to-json',
    flagged: [
      ['JSON.stringify(...([executionRecord.visits] as const))', 'the value (Map)'],
      ['JSON.stringify(...([executionRecord.visits, null, 2] as const))', 'the value (Map)'],
      ['JSON.stringify(...[executionRecord.visits])', 'the value (Map)'],
      // A slice of a Map's type may be a real Map or a plain object; lint cannot tell, so it asks for the whole type.
      ['JSON.stringify(hasOnly)', 'the value has a type made from part of a Map'],
      ['JSON.stringify(getOnly)', 'the value has a type made from part of a Map'],
      ['JSON.stringify(withoutClear)', 'the value has a type made from part of a Map'],
      ['JSON.stringify(withoutHas)', 'the value has a type made from part of a Map'],
      ['JSON.stringify({ lookup: hasOnly })', 'the value.lookup has a type made from part of a Map'],
      ['JSON.stringify(pickNone)', 'the value has a type made from part of a Map'],
      ['JSON.stringify(omitAll)', 'the value has a type made from part of a Map'],
      ['JSON.stringify(rejoined)', 'the value (Map)'],
      ['JSON.stringify(maybeMap)', 'the value has a type made from part of a Map'],
      [
        '<Held extends Map<string, number> | null>(held: Pick<Held, never>) => JSON.stringify(held)',
        'the value has a type made from part of a Map',
      ],
      ['JSON.stringify(...leading)', 'the value (Map)'],
      [
        '<Rest extends (typeof converting)[]>(passed: [Visits, ...Rest]) => JSON.stringify(...passed)',
        'the value (Map)',
      ],
      // A spread that may be empty may pass no replacer.
      ['JSON.stringify(executionRecord.visits, ...replacers)', 'the value (Map)'],
      ['JSON.stringify(...argumentsTuple)', 'the value (Map)'],
    ],
    // Without its Map, leading leaves converting as the value; with it, converting is its replacer.
    passed: [
      'JSON.stringify(...([executionRecord, converting] as const))',
      'JSON.stringify(...leading, converting)',
      '<Rest extends [typeof converting]>(passed: [Visits, ...Rest]) => JSON.stringify(...passed)',
      // A constraint that names itself ends, rather than overflowing the stack.
      '<Held extends Pick<Held, never>>(held: Pick<Held, never>) => JSON.stringify(held)',
    ],
  });
});

// JSON writes string keys only: not a symbol key, a symbol index signature or a private field.
test('lint passes what JSON does not write, and fails a string key that only looks like a symbol', async (t) => {
  await holdsMapBoundary(t, {
    rule: 'gg/no-map-to-json',
    flagged: [
      ["JSON.stringify({ '__@counts': executionRecord.visits })", 'the value.__@counts (Map)'],
      ["JSON.stringify({ '__#counts': executionRecord.visits })", 'the value.__#counts (Map)'],
    ],
    passed: [
      'JSON.stringify({ [Symbol.iterator]: executionRecord.visits })',
      'JSON.stringify(bySymbol)',
      'JSON.stringify(new Holder())',
    ],
  });
});

test('lint fails an object spread of a Map, and allows a record spread and a string spread', async (t) => {
  await holdsMapBoundary(t, {
    rule: '@typescript-eslint/no-misused-spread',
    flagged: [
      ['{ ...executionRecord.visits }', 'Object.fromEntries'],
      ['{ ...flow.ticket.vertices }', 'Object.fromEntries'],
    ],
    passed: ['{ ...executionRecord }', '[...text]'],
  });
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
