import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// lib/json-parse.d.ts makes JSON.parse give `unknown`, so tsc refuses its result wherever no check has narrowed it
// (#354). The type checker finds the calls: a call is JSON.parse when it resolves to the `parse` of an
// `interface JSON`, however it is spelled.
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
  declaration.parent.name.text === 'JSON';

// Every call of JSON.parse in the files tsconfig.json includes, with the declaration it resolves to and its type; and
// every reach of JSON.parse through call, apply or bind, which resolves past gg's overload to lib.es5's `any`.
function census() {
  const program = ts.createProgram(configured.fileNames, configured.options);
  const checker = program.getTypeChecker();
  const calls: { where: string; declaredIn: string; unknown: boolean }[] = [];
  const indirect: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
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
      if (ts.isPropertyAccessExpression(node) && ['call', 'apply', 'bind'].includes(node.name.text)) {
        const declarations = checker.getSymbolAtLocation(node.expression)?.getDeclarations() ?? [];
        if (declarations.some(isJsonParse)) indirect.push(where(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { calls, indirect };
}

test('every JSON.parse in lib, bin, scripts and test gives unknown, from gg overload', () => {
  const { calls, indirect } = census();
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
  assert.deepEqual(indirect, [], 'JSON.parse reached through call, apply or bind gives lib.es5 any');
});

// A file beside the overload that uses a parse's result unchecked, where a value of a type is wanted.
const PLANTED = [
  'declare const text: string;',
  'declare const takes: (value: string) => void;',
  'export const assigned: string = JSON.parse(text);',
  'export const returned = (): string => JSON.parse(text);',
  'takes(JSON.parse(text));',
  'export const checked: unknown = JSON.parse(text);',
].join('\n');

test('tsc refuses a parse result assigned, returned or passed where a type is wanted', () => {
  const planted = `${root}lib/planted-parse.ts`;
  const host = ts.createCompilerHost(configured.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === planted
      ? ts.createSourceFile(fileName, PLANTED, languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram([planted, OVERLOAD], { ...configured.options, types: [] }, host);
  const lines = program
    .getSemanticDiagnostics(program.getSourceFile(planted))
    .map((diagnostic) => diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!).line + 1);
  assert.deepEqual(lines, [3, 4, 5], 'tsc refuses lines 3 to 5 and accepts line 6');
});
