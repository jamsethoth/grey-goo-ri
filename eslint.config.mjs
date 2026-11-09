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

const NAMESPACE_MESSAGE =
  "Import a lib/ module as a namespace, `import * as paths from './paths.ts'`, and call `paths.canonical()`: " +
  'a missing export then fails where it is used, and each call names its module.';
const namespaceImport = (source) => ({
  selector:
    `ImportDeclaration[importKind='value'][source.value=${source}] > ` +
    ":matches(ImportSpecifier[importKind='value'], ImportDefaultSpecifier)",
  message: NAMESPACE_MESSAGE,
});
// A test names the module for its types too, where lib/ may import a type by name.
const namespaceImportWithTypes = (source) => ({
  selector: `ImportDeclaration[source.value=${source}] > :matches(ImportSpecifier, ImportDefaultSpecifier)`,
  message: NAMESPACE_MESSAGE,
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

// A rule, not a selector: a selector cannot compare the class's name with the one it sets.
// shortcut: a superclass behind a call or a computed key, `extends Mixin(Error)` or `extends exec['CommandError']`, is
// not read; widen superclassName if one appears.
const superclassName = ({ superClass }) => superClass?.name ?? superClass?.property?.name ?? '';
// Not `[name]` or `#name`: neither sets the name an error reports.
const isPublicName = (key, computed) => !computed && key.type === 'Identifier' && key.name === 'name';
const fieldSetsName = ({ type, key, value, computed, static: isStatic }, className) =>
  type === 'PropertyDefinition' && !isStatic && isPublicName(key, computed) && value?.value === className;
const assignsName = ({ type, operator, left, right }, className) =>
  type === 'AssignmentExpression' &&
  operator === '=' &&
  left.object?.type === 'ThisExpression' &&
  isPublicName(left.property, left.computed) &&
  right.value === className;
const constructorSetsName = ({ type, kind, value }, className) =>
  type === 'MethodDefinition' &&
  kind === 'constructor' &&
  (value.body?.body ?? []).some(({ expression }) => expression != null && assignsName(expression, className));
const THROWN_CLASS = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      suffix: 'A thrown class ends its name in Error. Rename it, and set `name` to the new name.',
      name: "A thrown class sets `name` to its class name, in a field or its constructor: `name = '{{className}}';`.",
    },
  },
  create(context) {
    const check = (node) => {
      if (!superclassName(node).endsWith('Error')) return;
      const className = node.id?.name ?? '';
      if (!className.endsWith('Error')) context.report({ node, messageId: 'suffix' });
      else if (
        !node.body.body.some((member) => fieldSetsName(member, className) || constructorSetsName(member, className))
      )
        context.report({ node, messageId: 'name', data: { className } });
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
};

const NO_MAP_TO_JSON = {
  meta: { type: 'problem', schema: [], messages: { lost: '{{where}}' } },
  create() {
    return {};
  },
};

// eslint-disable-next-line no-restricted-exports -- ESLint reads its configuration from the default export
export default defineConfig([
  {
    files: ['**/*.{ts,js,cjs,mjs}'],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      '@stylistic': stylistic,
      '@typescript-eslint': tseslint.plugin,
      gg: { rules: { 'thrown-class': THROWN_CLASS, 'no-map-to-json': NO_MAP_TO_JSON } },
    },
    rules: {
      '@typescript-eslint/naming-convention': ['error', ...NAMING],
      // Named exports only: a default export takes whatever name each importer gives it.
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true, named: true, defaultFrom: true } }],
      'gg/thrown-class': 'error',
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
    rules: {
      'id-length': ['error', { min: 2, exceptions: [...SHORT_NAMES, 't'] }],
      'no-restricted-syntax': ['error', namespaceImportWithTypes('/(^|[/])lib[/]/'), ...NO_MODULE_STATE],
    },
  },
  {
    files: ['test/**/*.test.ts'],
    rules: { 'max-lines': ['error', 800] },
  },
  {
    // The directories tsconfig.json includes: the typed rules read its program. eslint.config.mjs is outside it.
    files: ['lib/**/*.ts', 'bin/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { 'gg/no-map-to-json': 'error' },
  },
]);
