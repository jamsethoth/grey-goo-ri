// The readability rules of grey-goo-ri epic #193 (ADR 0018), for every file. This is the one JavaScript file: ESLint
// 10.14 loads a .ts config only through the optional jiti package or an unstable flag (test/unit/layout.test.ts).
// Agents read these messages, so each custom one says how to fix.
import { defineConfig } from 'eslint/config';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import ts from 'typescript';

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

// JSON.stringify writes a Map or a Set as {} and raises nothing (ECMA-262 SerializeJSONObject), so the types it is
// given must hold none. A lib or package type is not gg's data, and a type with toJSON chooses its own form.
const LOST_BY_JSON = new Set(['Map', 'ReadonlyMap', 'WeakMap', 'Set', 'ReadonlySet', 'WeakSet']);
const inDefaultLib = (program, node) => program.isSourceFileDefaultLibrary(node.getSourceFile());
const fromLibOrPackage = (program, symbol) =>
  (symbol?.getDeclarations() ?? []).some(
    (declaration) =>
      inDefaultLib(program, declaration) || program.isSourceFileFromExternalLibrary(declaration.getSourceFile()),
  );
// Which of the six a type is made from, read from the members lib declares for it, and whether it has all of them.
// Readonly<Map>, a subclass (even one that overrides has) and an intersection have all; a slice such as
// Pick<Map, 'has'> has some, and lint cannot tell a Map typed that way from a plain object; a package's own class named
// Map has none of lib's.
const collectionOf = (checker, program, type, seen = new Set()) => {
  const properties = checker.getPropertiesOfType(type);
  const names = new Set(properties.map((property) => property.getName()));
  const owners = properties
    .flatMap((property) => property.getDeclarations() ?? [])
    .map((declaration) => declaration.parent)
    .filter((owner) => owner != null && inDefaultLib(program, owner) && LOST_BY_JSON.has(owner.name?.text));
  if (owners.length === 0) return aliasedCollection(checker, program, type, seen);
  const whole = owners.find((owner) =>
    checker
      .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(owner.name)))
      .every((member) => names.has(member.getName())),
  );
  return { name: (whole ?? owners[0]).name.text, whole: whole != null };
};
// A lib alias over a Map that keeps none of its members, such as Pick<Map, never> or Omit<Map, keyof Map>, is still
// made from one. Its source is its first argument: Record's second is the type of its values, read as they are held.
function aliasedCollection(checker, program, type, seen) {
  const fromLibAlias = (type.aliasSymbol?.getDeclarations() ?? []).some((declaration) =>
    inDefaultLib(program, declaration),
  );
  const [source] = type.aliasTypeArguments ?? [];
  const made = fromLibAlias && source ? collectionIn(checker, program, source, seen) : null;
  return made ? { name: made.name, whole: false } : null;
}
// A collection a type is, or one of its alternatives is (Pick<Map | null, never>, a parameter bound by a Map).
// `seen` ends a constraint that names itself: <Held extends Pick<Held, never>>.
function collectionIn(checker, program, type, seen) {
  if (seen.has(type)) return null;
  seen.add(type);
  const alternatives = alternativesOf(checker, type) ?? [];
  return (
    collectionOf(checker, program, type, seen) ??
    alternatives.map((member) => collectionIn(checker, program, member, seen)).find(Boolean) ??
    null
  );
}
// A mapped type (Record, Partial, Omit, Readonly) is anonymous, `__type`, and is walked even though lib declares it.
const isLibNamed = (program, symbol) => symbol?.getName() !== '__type' && fromLibOrPackage(program, symbol);
// The same value's alternatives: a union's or intersection's members, or a type parameter's constraint.
const alternativesOf = (checker, type) => {
  if (type.isUnionOrIntersection()) return type.types;
  if (type.isTypeParameter()) return [checker.getBaseConstraintOfType(type)].filter((constraint) => constraint);
  return null;
};
// JSON writes string keys only. The compiler names a symbol-keyed property `__@iterator@14` and a private one
// `__#1@#counts`, and escapes a string key that starts with two underscores to three, so the escaped name tells them
// apart.
const isWritten = (key) => !/^__[@#]/.test(key.escapedName);
const isSymbolIndex = (info) => (info.keyType.flags & ts.TypeFlags.ESSymbolLike) !== 0;
// The values a type holds: array and tuple elements, written properties and index signatures.
const heldBy = (checker, program, type, path) => {
  if (checker.isArrayType(type) || checker.isTupleType(type))
    return checker.getTypeArguments(type).map((element) => [element, `${path}[]`]);
  if (isLibNamed(program, type.getSymbol())) return [];
  return [
    ...checker
      .getPropertiesOfType(type)
      .filter(isWritten)
      .map((key) => [checker.getTypeOfSymbol(key), `${path}.${key.getName()}`]),
    ...checker
      .getIndexInfosOfType(type)
      .filter((info) => !isSymbolIndex(info))
      .map((info) => [info.type, `${path}[key]`]),
  ];
};
// The shallowest Map or Set inside a type, whole or in part, with its path, or null; `unknown` and `any` hide theirs.
// Alternatives are the same value, so they go to the front of the queue and add no depth.
function findLost(checker, program, rootType) {
  const seen = new Set();
  const pending = [[rootType, 'the value']];
  while (pending.length) {
    const [type, path] = pending.shift();
    if (seen.has(type) || checker.getPropertyOfType(type, 'toJSON')) continue;
    seen.add(type);
    const alternatives = alternativesOf(checker, type);
    // An intersection is read whole first: two slices may make a whole Map.
    const collection = type.isUnion() || type.isTypeParameter() ? null : collectionOf(checker, program, type);
    if (collection && (collection.whole || !alternatives)) return { path, ...collection };
    if (alternatives) pending.unshift(...alternatives.map((member) => [member, path]));
    else pending.push(...heldBy(checker, program, type, path));
  }
  return null;
}
// lib's JSON.stringify by any path to it (globalThis.JSON, JSON['stringify']); a local object named JSON is not it.
const isJsonStringify = (checker, services, { callee }) => {
  if (callee.type !== 'MemberExpression') return false;
  const { property: key } = callee;
  const named = callee.computed ? key.type === 'Literal' && key.value === 'stringify' : key.name === 'stringify';
  if (!named) return false;
  const symbol = checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(key));
  return (symbol?.getDeclarations() ?? []).some(
    (declaration) => inDefaultLib(services.program, declaration) && declaration.parent?.name?.text === 'JSON',
  );
};
// The elements a spread passes: a tuple's, each optional or repeating by its flags, a variadic one read through its
// constraint (<Rest extends [Replacer]> passes one); an array's element any number of times; null for an iterable.
function spreadElements(checker, type) {
  if (checker.isArrayType(type)) return [{ type: checker.getTypeArguments(type)[0], optional: true, repeats: true }];
  if (!checker.isTupleType(type)) return null;
  return checker.getTypeArguments(type).flatMap((element, i) => {
    const flags = type.target.elementFlags[i];
    const constraint = flags & ts.ElementFlags.Variadic ? checker.getBaseConstraintOfType(element) : null;
    const optional = (flags & ts.ElementFlags.Required) === 0;
    return (
      (constraint && spreadElements(checker, constraint)) ?? [
        { type: element, optional, repeats: (flags & ts.ElementFlags.Variable) !== 0 },
      ]
    );
  });
}
// Each element a call passes, in order, with a spread read by spreadElements; reading stops at an iterable's.
const passedElements = (checker, services, callArguments) => {
  const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
  const elements = [];
  for (const argument of callArguments) {
    const spread = argument.type === 'SpreadElement' ? spreadElements(checker, typeOf(argument.argument)) : undefined;
    if (spread === null) break;
    elements.push(...(spread ?? [{ type: typeOf(argument), optional: false, repeats: false }]));
  }
  return elements;
};
// Every [value, replacer] the elements can make: each optional element present or absent, each repeating one again.
const stringifyLayouts = (elements) => {
  const layouts = [];
  const fill = (index, filled) => {
    if (filled.length === 2 || index === elements.length) return void layouts.push(filled);
    const element = elements[index];
    if (element.optional) fill(index + 1, filled);
    fill(element.repeats ? index : index + 1, [...filled, element.type]);
  };
  fill(0, []);
  return layouts;
};
const NO_MAP_TO_JSON = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      lost:
        'JSON.stringify writes a Map or Set as {}: {{where}} ({{name}}). Convert it first, with ' +
        "Object.fromEntries or the owner's toJson, or pass a replacer that converts it.",
      part:
        '{{where}} has a type made from part of a {{name}}, so lint cannot tell whether it is one, and ' +
        'JSON.stringify writes a {{name}} as {}. Type it as the whole {{name}} if it is one, or as a plain object ' +
        'type if it is not.',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program) throw new Error('gg/no-map-to-json needs type information (parserOptions.projectService)');
    const checker = services.program.getTypeChecker();
    return {
      CallExpression(node) {
        if (!isJsonStringify(checker, services, node)) return;
        // A replacer function is its owner's conversion (lib/validate/inputs.ts); the rule does not judge it. An
        // array of keys, null or undefined converts nothing, and a replacer that may be absent does not guarantee it.
        const unconverted = stringifyLayouts(passedElements(checker, services, node.arguments))
          .filter(([value, replacer]) => value && !(replacer?.getCallSignatures().length > 0))
          .map(([value]) => value);
        const found = [...new Set(unconverted)]
          .map((value) => findLost(checker, services.program, value))
          .find(Boolean);
        if (found)
          context.report({
            node,
            messageId: found.whole ? 'lost' : 'part',
            data: { where: found.path, name: found.name },
          });
      },
    };
  },
};

// tsc accepts `unknown as T`, so lint refuses an assertion on a call resolving to JSON.parse, however spelled (#354).
const NO_JSON_PARSE_ASSERTION = {
  meta: { type: 'problem', schema: [], messages: { asserted: 'Check what JSON.parse gives; never assert its type.' } },
  create(context) {
    const { program, esTreeNodeToTSNodeMap: tsNodes } = context.sourceCode.parserServices ?? {};
    if (!program) throw new Error('gg/no-json-parse-assertion needs type information');
    const checker = program.getTypeChecker();
    const bare = (node) => (/^(TSNonNull|Chain)Expression$/.test(node.type) ? bare(node.expression) : node);
    const asserted = (node) => {
      const operand = bare(node.expression);
      if (operand.type !== 'CallExpression') return;
      const { name, parent } = checker.getResolvedSignature(tsNodes.get(operand))?.declaration ?? {};
      if (name?.text === 'parse' && parent?.name?.text === 'JSON' && !ts.isExternalModule(parent.getSourceFile()))
        context.report({ node, messageId: 'asserted' });
    };
    return { TSAsExpression: asserted, TSTypeAssertion: asserted };
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
      gg: {
        rules: {
          'thrown-class': THROWN_CLASS,
          'no-map-to-json': NO_MAP_TO_JSON,
          'no-json-parse-assertion': NO_JSON_PARSE_ASSERTION,
        },
      },
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
    rules: {
      // An object spread of a Map gives {}. `[...text]` iterates code points on purpose (lib/public-text.ts).
      '@typescript-eslint/no-misused-spread': ['error', { allow: [{ from: 'lib', name: 'string' }] }],
      'gg/no-map-to-json': 'error',
    },
  },
  // gg's own code checks what JSON.parse gives; a test may type it by what the case expects (#354).
  { files: ['lib/**/*.ts', 'bin/**/*.ts', 'scripts/**/*.ts'], rules: { 'gg/no-json-parse-assertion': 'error' } },
  {
    // Typed by a check, never by an assertion or an `any`: an Event by lib/event-read.ts (#350), a record's row by
    // lib/record-read.ts (#357). test/unit/layout.test.ts holds this list to their importers and modules.
    files: ['lib/{event-read,interpreter,run-context,terminal-report,record-*}.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
    },
  },
]);
