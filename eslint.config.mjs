// The readability rules of grey-goo-ri epic #193 (ADR 0018). They apply to .ts files only: an .mjs file is legacy until
// its ticket converts it, and no new .mjs file may be added (test/unit/layout.test.mjs). Agents read these messages, so
// each custom one says how to fix.
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
];
const SHORT_NAMES = ['i', 'j', '_'];

const namespaceImport = (source) => ({
  selector:
    `ImportDeclaration[importKind='value'][source.value=${source}] > ` +
    ":matches(ImportSpecifier[importKind='value'], ImportDefaultSpecifier)",
  message:
    "Import a lib/ module as a namespace, `import * as paths from './paths.ts'`, and call `paths.canonical()`: " +
    'a missing export then fails where it is used, and each call names its module.',
});
const NO_MODULE_STATE = [
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
];

export default defineConfig([
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@stylistic': stylistic },
    rules: {
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
      'no-restricted-syntax': ['error', namespaceImport('/(^|[/])lib[/]/'), ...NO_MODULE_STATE],
    },
  },
  {
    // Inside lib/, every relative import is a lib/ module.
    files: ['lib/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', namespaceImport('/^[.]/'), ...NO_MODULE_STATE] },
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
