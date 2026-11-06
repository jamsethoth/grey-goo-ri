// The readability rules of grey-goo-ri epic #193 (ADR 0018), for every file. This is the one JavaScript file: ESLint
// 10.14 loads a .ts config only through the optional jiti package or an unstable flag (test/unit/layout.test.ts).
// Agents read these messages, so each custom one says how to fix.
import { defineConfig } from 'eslint/config';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

// Abbreviations a name may use: id, url, sha, err, gh, pr, json, ms. Every other short form is spelled out, a domain
// concept with its full GLOSSARY.md term in camelCase; the denylist names the common offenders.
const DENIED_NAMES = [
  'ctx',
  'opts',
  'cfg',
  'conf',
  'res',
  'req',
  'out',
  'rec',
  'at',
  'cmd',
  'tmp',
  'obj',
  'arr',
  'val',
  'str',
  'cb',
  'fn',
  'dir',
];
const SHORT_NAMES = ['i', 'j', '_'];
// Identifier casing, as in the Google TypeScript Style Guide's rules by identifier type. A leading underscore marks a
// binding left unused on purpose. Object and type properties are left free: they carry the names of the data or API
// they mirror (GitHub's `created_at`, kernel32's `CreateJobObjectW`, an operator such as `'<='`).
const NAMING = [
  { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
  { selector: 'variable', modifiers: ['const', 'global'], format: ['camelCase', 'UPPER_CASE'] },
  { selector: 'typeLike', format: ['PascalCase'] },
  { selector: 'import', format: ['camelCase', 'PascalCase'] },
  { selector: ['objectLiteralProperty', 'objectLiteralMethod', 'typeProperty'], format: null },
];

const namespaceImport = (source) => ({
  selector:
    `ImportDeclaration[importKind='value'][source.value=${source}] > ` +
    ":matches(ImportSpecifier[importKind='value'], ImportDefaultSpecifier)",
  message:
    "Import a lib/ module as a namespace, `import * as paths from './paths.ts'`, and call `paths.canonical()`: " +
    'a missing export then fails where it is used, and each call names its module.',
});
const EVERY_FILE_SYNTAX = [
  {
    selector:
      "Program > VariableDeclaration[kind='let'], Program > ExportNamedDeclaration > VariableDeclaration[kind='let']",
    message:
      'No module-level `let`: module state leaks between callers and between tests. Pass the value in as a ' +
      'parameter, or keep it inside the function that owns it.',
  },
  {
    selector:
      'ExportNamedDeclaration > FunctionDeclaration[id.name=/^set[A-Z]/], ' +
      'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/^set[A-Z]/], ' +
      'ExportSpecifier[exported.name=/^set[A-Z]/]',
    message:
      'No exported set* function: a setter swaps module state for every caller. Take the dependency as a ' +
      'parameter from the caller instead.',
  },
  {
    // The superClass's property form is `extends exec.CommandError`. The `name` half is in test/unit/layout.test.ts.
    selector:
      ':matches(ClassDeclaration, ClassExpression)[superClass.name=/Error$/]:not([id.name=/Error$/]), ' +
      ':matches(ClassDeclaration, ClassExpression)[superClass.property.name=/Error$/]:not([id.name=/Error$/])',
    message:
      'A thrown class ends its name in Error and sets `name` to it: ' +
      "`class CrashError extends Error { name = 'CrashError'; }`.",
  },
];

// eslint-disable-next-line no-restricted-exports -- ESLint reads its configuration from the default export
export default defineConfig([
  {
    files: ['**/*.{ts,js,cjs,mjs}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@stylistic': stylistic, '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/naming-convention': ['error', ...NAMING],
      // Named exports only: a default export takes whatever name each importer gives it.
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true, named: true, defaultFrom: true } }],
      'id-length': ['error', { min: 2, exceptions: SHORT_NAMES }],
      'id-denylist': ['error', ...DENIED_NAMES],
      '@stylistic/max-len': ['error', { code: 120 }],
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],
      'no-nested-ternary': 'error',
      'max-params': ['error', 4],
      'max-depth': ['error', 4],
      'max-lines-per-function': ['error', 60],
      complexity: ['error', 15],
      'max-lines': ['error', 400],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Outside lib/, a lib/ module is any path through a lib directory.
      'no-restricted-syntax': ['error', namespaceImport('/(^|[/])lib[/]/'), ...EVERY_FILE_SYNTAX],
    },
  },
  {
    // Inside lib/, every relative import is a lib/ module.
    files: ['lib/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', namespaceImport('/^[.]/'), ...EVERY_FILE_SYNTAX] },
  },
  {
    // `t` is node:test's test context, and only there.
    files: ['test/**/*.ts'],
    rules: { 'id-length': ['error', { min: 2, exceptions: [...SHORT_NAMES, 't'] }] },
  },
  {
    files: ['test/**/*.test.ts'],
    rules: { 'max-lines': ['error', 800] },
  },
]);
