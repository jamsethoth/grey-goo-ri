import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// lib/json-parse.d.ts makes JSON.parse give `unknown`, so tsc refuses its result wherever no check has narrowed it
// (#354). The type checker finds JSON.parse however it is spelled: a call is one when it resolves to the `parse` of an
// `interface JSON`, and a value is one when its type has that signature.
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const OVERLOAD = `${root}lib/json-parse.d.ts`;

function readConfig(): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    `${root}tsconfig.json`,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('tsconfig.json did not parse');
  return parsed;
}
const configured = readConfig();

const isJsonParse = (declaration: ts.Declaration | undefined): declaration is ts.MethodSignature =>
  declaration !== undefined &&
  ts.isMethodSignature(declaration) &&
  ts.isIdentifier(declaration.name) &&
  declaration.name.text === 'parse' &&
  ts.isInterfaceDeclaration(declaration.parent) &&
  declaration.parent.name.text === 'JSON' &&
  !ts.isExternalModule(declaration.getSourceFile());

// Whether `node` is the callee of a call, through parentheses, a `!` or a `satisfies`.
function isCallee(node: ts.Node) {
  let child = node;
  while (
    ts.isParenthesizedExpression(child.parent) ||
    ts.isNonNullExpression(child.parent) ||
    ts.isSatisfiesExpression(child.parent)
  )
    child = child.parent;
  return ts.isCallExpression(child.parent) && child.parent.expression === child;
}
// A name or an access that may hold a value: not the member name of an access, and not a name inside a type.
const holdsValue = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node) ||
  ts.isElementAccessExpression(node) ||
  (ts.isIdentifier(node) &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
    !ts.isQualifiedName(node.parent));

// In `files` of `program`: every call of JSON.parse, with the declaration it resolves to and its type; and every place
// JSON.parse's value goes other than straight into a call (an alias, a destructuring, call, apply or bind, a callback),
// since a parse result can only be known to come from the overload when JSON.parse is called where it is read.
function census(program: ts.Program, files: (sourceFile: ts.SourceFile) => boolean) {
  const checker = program.getTypeChecker();
  const calls: { where: string; declaredIn: string; unknown: boolean }[] = [];
  const uncalled = new Set<string>();
  for (const sourceFile of program.getSourceFiles().filter(files)) {
    const where = (node: ts.Node) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      return `${sourceFile.fileName.slice(root.length)}:${line + 1}`;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (isJsonParse(declaration))
          calls.push({
            where: where(node),
            declaredIn: declaration.getSourceFile().fileName,
            unknown: (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Unknown) !== 0,
          });
      }
      const signatures = holdsValue(node) ? checker.getTypeAtLocation(node).getCallSignatures() : [];
      if (signatures.some((signature) => isJsonParse(signature.getDeclaration())) && !isCallee(node))
        uncalled.add(where(node));
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { calls, uncalled: [...uncalled] };
}

test('every JSON.parse in lib, bin, scripts and test is called where it is read, and gives unknown', () => {
  const program = ts.createProgram(configured.fileNames, configured.options);
  const { calls, uncalled } = census(program, (sourceFile) => !sourceFile.isDeclarationFile);
  // The census is not empty: it finds parses in lib and in test.
  assert.ok(
    calls.some(({ where }) => where.startsWith('lib/config.ts:')),
    'a parse in lib/config.ts is found',
  );
  assert.ok(
    calls.some(({ where }) => where.startsWith('test/support/example-layer.ts:')),
    'a parse in test/support is found',
  );
  assert.deepEqual(
    calls.filter(({ declaredIn, unknown }) => declaredIn !== OVERLOAD || !unknown).map(({ where }) => where),
    [],
    'these calls of JSON.parse do not resolve to lib/json-parse.d.ts, or do not give unknown',
  );
  assert.deepEqual(uncalled, [], 'JSON.parse is read here other than to be called');
});

// A program of the overload and one planted file, `lib/planted-parse.ts`, holding `text`.
function plantedProgram(text: string) {
  const planted = `${root}lib/planted-parse.ts`;
  const host = ts.createCompilerHost(configured.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === planted
      ? ts.createSourceFile(fileName, text, languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram([planted, OVERLOAD], { ...configured.options, types: [] }, host);
  return { program, plantedFile: program.getSourceFile(planted)! };
}

// A file beside the overload that uses a parse's result unchecked, where a value of a type is wanted.
const UNCHECKED = [
  'declare const text: string;',
  'declare const takes: (value: string) => void;',
  'export const assigned: string = JSON.parse(text);',
  'export const returned = (): string => JSON.parse(text);',
  'takes(JSON.parse(text));',
  'export const checked: unknown = JSON.parse(text);',
].join('\n');

test('tsc refuses a parse result assigned, returned or passed where a type is wanted', () => {
  const { program, plantedFile } = plantedProgram(UNCHECKED);
  const lines = program
    .getSemanticDiagnostics(plantedFile)
    .map((diagnostic) => diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!).line + 1);
  assert.deepEqual(lines, [3, 4, 5], 'tsc refuses lines 3 to 5 and accepts line 6');
});

// Each spelling of a call the census counts, then each place JSON.parse's value goes other than into a call.
const SPELLINGS = [
  'declare const text: string;',
  "declare const method: 'parse';",
  'export const direct = JSON.parse(text);',
  "export const computed = JSON['parse'](text);",
  'export const byConstant = JSON[method](text);',
  'export const parenthesized = (JSON.parse)(text);',
  'export const nonNull = JSON.parse!(text);',
  'export const optional = JSON?.parse(text);',
  'export const global = globalThis.JSON.parse(text);',
  'const alias = JSON.parse;',
  'const { parse } = JSON;',
  'export const viaCall = JSON.parse.call(JSON, text);',
  "export const viaComputedCall = JSON.parse['call'](JSON, text);",
  'export const viaApply = JSON[method].apply(JSON, [text]);',
  'export const bound = JSON.parse.bind(JSON);',
  'export const mapped = [text].map(JSON.parse);',
  'export const aliased = [alias(text), parse(text)];',
  'export const satisfied = (JSON.parse satisfies typeof JSON.parse)(text);',
].join('\n');

test('the census counts every spelling of a JSON.parse call, and finds JSON.parse read other than to be called', () => {
  const { program, plantedFile } = plantedProgram(SPELLINGS);
  const { calls, uncalled } = census(program, (sourceFile) => sourceFile === plantedFile);
  const line = (where: string) => Number(where.split(':').at(-1));
  assert.deepEqual(
    calls.map(({ where, unknown }) => [line(where), unknown]),
    [3, 4, 5, 6, 7, 8, 9, 17, 17, 18].map((lineNumber) => [lineNumber, true]),
    'the direct spellings and the aliases are calls that give unknown',
  );
  assert.deepEqual(uncalled.map(line), [10, 11, 12, 13, 14, 15, 16], 'every read that is not a call is found');
});

test("the census passes a module's own interface named JSON", () => {
  const { program, plantedFile } = plantedProgram(
    [
      'interface JSON {',
      '  parse(text: string): string;',
      '}',
      'declare const own: JSON;',
      "export const parsed = [own.parse('7'), own.parse];",
    ].join('\n'),
  );
  assert.deepEqual(
    census(program, (sourceFile) => sourceFile === plantedFile),
    { calls: [], uncalled: [] },
  );
});
