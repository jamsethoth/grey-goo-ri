import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import * as typeShape from '../support/type-shape.ts';

// The example configuration a case edits is typed by its own file, so tsc checks every read and refuses every edit out
// of its shape that does not go through putAt; no test reaches it through an `any`, a cast, an Object.assign or a
// place typed to take any key (#358, Q1 A).
const { root, configured } = typeShape;
const EXAMPLE_JSON = `${root}test/fixtures/example/gg.json`;
const EXAMPLE_MODULE = `${root}test/support/example-source.ts`;
// The one file whose subject is how a type treats an `any` (JsonValue's refusal of it), so its samples write one.
const WRITES_ANY = `${root}test/unit/json-value.test.ts`;

// What the census asks of a node, over `checker`: whether a type, a call or a value is the example's, and whether a
// place a value is handed to has stopped checking it.
function exampleReads(checker: ts.TypeChecker) {
  // A type that holds itself, such as JsonValue, is walked once.
  const fromExample = (type: ts.Type, walking = new Set<ts.Type>()): boolean => {
    if (walking.has(type)) return false;
    walking.add(type);
    if (type.isUnionOrIntersection()) return type.types.some((member) => fromExample(member, walking));
    if (checker.isArrayType(type) || checker.isTupleType(type))
      return checker.getTypeArguments(type as ts.TypeReference).some((member) => fromExample(member, walking));
    return (type.getSymbol()?.declarations ?? []).some(
      (declaration) => declaration.getSourceFile().fileName === EXAMPLE_JSON,
    );
  };
  const isConfigCall = (node: ts.Node) => {
    if (!ts.isCallExpression(node)) return false;
    // Only a call spelled config is resolved: resolving every call checks the whole program, and takes seconds more.
    const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
    const named = ts.isIdentifier(callee) && callee.text === 'config';
    const declaration = named ? checker.getResolvedSignature(node)?.declaration : undefined;
    return (
      declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.name?.text === 'config' &&
      declaration.getSourceFile().fileName === EXAMPLE_MODULE
    );
  };
  // A value read from the example: its type is the file's, or it is read through one that is.
  const reaches = (node: ts.Expression): boolean =>
    isConfigCall(node) ||
    fromExample(checker.getTypeAtLocation(node)) ||
    ((ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node)) &&
      reaches(node.expression));
  // A place that opens, and is not the example's.
  const widened = (type: ts.Type | undefined) => type !== undefined && !fromExample(type) && opens(checker, type);
  const isExample = (expression: ts.Expression) => fromExample(checker.getTypeAtLocation(expression));
  return { fromExample, isConfigCall, reaches, widened, isExample };
}

// A type that, at any depth, takes any key (a string index signature, such as Record<string, object>) or any value at
// a key (a property typed `unknown` or `any`): a value handed to it can be written there with nothing checked.
function opens(checker: ts.TypeChecker, type: ts.Type, walking = new Set<ts.Type>()): boolean {
  if (walking.has(type)) return false;
  walking.add(type);
  if (type.isUnionOrIntersection()) return type.types.some((member) => opens(checker, member, walking));
  if (checker.isArrayType(type) || checker.isTupleType(type))
    return checker.getTypeArguments(type as ts.TypeReference).some((member) => opens(checker, member, walking));
  if (type.getStringIndexType() !== undefined) return true;
  return checker.getPropertiesOfType(type).some((property) => {
    const held = checker.getTypeOfSymbol(property);
    return (held.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0 || opens(checker, held, walking);
  });
}

// A place the example is handed to that edits nothing, though its type opens.
function handedOff(node: ts.Node, checker: ts.TypeChecker) {
  const { parent } = node;
  // gg's own code reads what a case gives it, so an argument to a function declared outside test/ widens nothing.
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression))
    return !(checker.getResolvedSignature(parent)?.declaration?.getSourceFile().fileName ?? '').startsWith(
      `${root}test/`,
    );
  // The golden fixture's configuration is its own fixture type, which golden cases edit through that type; nothing
  // edits the example run's configuration today.
  if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent))
    return checker.getContextualType(parent.parent)?.getSymbol()?.name === 'GoldenConfig';
  // tsc gives a destructuring's binding pattern a contextual type with `unknown` properties.
  return ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name);
}

// What `node` does to the example that tsc does not check: a cast of it, an `any`, an Object.assign onto it, or the
// example handed to a place that no longer checks it, directly or through a type argument.
function escapes(node: ts.Node, checker: ts.TypeChecker, reads: ReturnType<typeof exampleReads>) {
  const { reaches, widened, isExample } = reads;
  const found = ts.isCallExpression(node) ? callEscapes(node, checker, reads) : [];
  if (isCast(node) && reaches(node.expression)) found.push('a cast of the example');
  if (node.kind === ts.SyntaxKind.AnyKeyword && node.getSourceFile().fileName !== WRITES_ANY) found.push('an any');
  // The contextual type is asked first: most expressions have none, and it is cheaper than the type of each.
  if (ts.isExpression(node) && widened(checker.getContextualType(node)) && isExample(node) && !handedOff(node, checker))
    found.push('the example widened to an index signature');
  return found;
}

function callEscapes(call: ts.CallExpression, checker: ts.TypeChecker, reads: ReturnType<typeof exampleReads>) {
  const { widened, isExample } = reads;
  const found: string[] = [];
  if (call.expression.getText() === 'Object.assign' && call.arguments[0] && isExample(call.arguments[0]))
    found.push('an Object.assign onto the example');
  const widening = call.typeArguments?.some((argument) => widened(checker.getTypeFromTypeNode(argument)));
  if (widening && call.arguments.some(isExample)) found.push('the example widened by a type argument');
  return found;
}

const isCast = (node: ts.Node): node is ts.AsExpression | ts.TypeAssertion =>
  (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !ts.isConstTypeReference(node.type);

// In `files` of `program`: every call of exampleSource.config(), and each place a test reaches the example around its
// type: a config() not typed by the example file, and each escape `escapes` names.
function census(program: ts.Program, files: (sourceFile: ts.SourceFile) => boolean) {
  const checker = program.getTypeChecker();
  const reads = exampleReads(checker);
  let configCalls = 0;
  const found: string[] = [];
  for (const sourceFile of program.getSourceFiles().filter(files)) {
    const where = (node: ts.Node) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      return `${sourceFile.fileName.slice(root.length)}:${line + 1}`;
    };
    const visit = (node: ts.Node): void => {
      if (reads.isConfigCall(node)) {
        configCalls += 1;
        if (!reads.fromExample(checker.getTypeAtLocation(node)))
          found.push(`${where(node)}: config() is not the example's type`);
      }
      for (const escape of escapes(node, checker, reads)) found.push(`${where(node)}: ${escape}`);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { configCalls, found };
}

// A program of one planted file beside the example module, `test/support/planted-example.ts`, holding `lines`.
function plantedProgram(lines: string[]) {
  const planted = `${root}test/support/planted-example.ts`;
  const host = ts.createCompilerHost(configured.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === planted
      ? ts.createSourceFile(fileName, lines.join('\n'), languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram([planted], configured.options, host);
  return { program, plantedFile: program.getSourceFile(planted)! };
}
const HEADER = ["import * as exampleSource from './example-source.ts';", 'const config = exampleSource.config();'];

test("every exampleSource.config() under test/ is the example's type, edited around it nowhere", () => {
  const program = ts.createProgram(configured.fileNames, configured.options);
  const { configCalls, found } = census(
    program,
    (sourceFile) => sourceFile.fileName.startsWith(`${root}test/`) && !sourceFile.isDeclarationFile,
  );
  assert.ok(configCalls > 200, `the census finds the calls of config(): ${configCalls}`);
  assert.deepEqual(found, [], 'read the example as its type, and edit it out of its shape through putAt');
});

const WIDENED = 'the example widened to an index signature';
// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('the census finds a config() not typed by the example, each cast of it, each any, and each edit around its type', () => {
  const samples: [string, string | null][] = [
    ['export const cast = config.flows as unknown;', 'a cast of the example'],
    ['export const angled = <never>config.flows.default;', 'a cast of the example'],
    ['export const field = config.labelPrefix as never;', 'a cast of the example'],
    ['export const parenthesized = (config.agents) as object;', 'a cast of the example'],
    ['export const loose: any = config;', 'an any'],
    ['export const entries = Object.entries<any>(config.flows);', 'an any'],
    ['Object.assign(config.agents.implementer, { mcp: [] });', 'an Object.assign onto the example'],
    ['export const site: Record<string, unknown> = config.agents.implementer;', WIDENED],
    ['((value: Record<string, unknown>) => value)(config.procedures.implement);', WIDENED],
    ['export const nested: Record<string, Record<string, unknown>> = config.flows.default.ticket.vertices;', WIDENED],
    ['export const deep: Record<string, Record<string, Record<string, unknown>>> = config.flows;', WIDENED],
    ['export const listed: Record<string, unknown>[] = Object.values(config.agents);', WIDENED],
    ['export const objects: Record<string, object> = config.flows.default.ticket.vertices;', WIDENED],
    ['export const named: { model?: unknown } = config.agents.implementer;', WIDENED],
    [
      'export const inner: { ticket: { vertices: Record<string, Record<string, unknown>> } } = config.flows.default;',
      WIDENED,
    ],
    [
      'export const each = Object.values<Record<string, unknown>>(config.agents);',
      'the example widened by a type argument',
    ],
    ['export const read = config.flows.default.actionCap;', null],
    ['export const values = Object.values(config.agents);', null],
    ["exampleSource.putAt(config, ['labelPrefix'], null);", null],
    ["export const constant = 'x' as const;", null],
    ["export const parsed = JSON.parse('{}') as typeof config;", null],
    ['export const { implement } = config.procedures;', null],
    ['export const typed: exampleSource.Source["agents"] = config.agents;', null],
  ];
  const { program, plantedFile } = plantedProgram([...HEADER, ...samples.map(([sample]) => sample)]);
  const { configCalls, found } = census(program, (sourceFile) => sourceFile === plantedFile);
  assert.equal(configCalls, 1);
  assert.deepEqual(
    found,
    samples.flatMap(([, what], index) =>
      what ? [`test/support/planted-example.ts:${HEADER.length + index + 1}: ${what}`] : [],
    ),
  );
});

test('tsc refuses an edit out of the example shape, and passes the same edit through putAt and a read of a key', () => {
  const samples: [string, number[]][] = [
    ['export const missing = config.noSuchKey;', [2339]],
    ['config.labelPrefix = null;', [2322]],
    ['delete config.agents;', [2790]],
    ["exampleSource.putAt(config, ['noSuchKey'], 1);", []],
    ["exampleSource.putAt(config, ['labelPrefix'], null);", []],
    ["exampleSource.putAt(config, ['agents']);", []],
    ['export const prefix: string = config.labelPrefix;', []],
  ];
  const { program, plantedFile } = plantedProgram([...HEADER, ...samples.map(([sample]) => sample)]);
  const diagnostics = program.getSemanticDiagnostics(plantedFile);
  const codesOn = (line: number) =>
    diagnostics
      .filter((diagnostic) => plantedFile.getLineAndCharacterOfPosition(diagnostic.start!).line + 1 === line)
      .map((diagnostic) => diagnostic.code);
  assert.deepEqual(
    samples.map(([sample], index) => [sample, codesOn(HEADER.length + index + 1)]),
    samples.map(([sample, codes]) => [sample, codes]),
  );
  assert.deepEqual(codesOn(1).concat(codesOn(2)), [], 'the header compiles');
});

// ADR 0022 replaced the merged configuration of its first design with two Sources read whole, so the old word names
// nothing in gg and GLOSSARY.md avoids it; the example module and its readers say Source. Spelled in parts, so this
// file passes its own scan.
const RETIRED_WORD = new RegExp(['la', 'yer'].join(''), 'gi');
const retiredWordsIn = (files: Record<string, string>) =>
  Object.entries(files).flatMap(([path, text]) => {
    const count = text.match(RETIRED_WORD)?.length ?? 0;
    return count ? [`${path}: ${count}`] : [];
  });

test('no file under test/ names the configuration word ADR 0022 retired', () => {
  const word = ['La', 'yer'].join('');
  assert.deepEqual(
    retiredWordsIn({
      'a.ts': `example${word}.config(); const ${word.toLowerCase()}File = 1;`,
      'b.md': `${word.toUpperCase()}S`,
      'c.ts': 'exampleSource.config();',
    }),
    ['a.ts: 2', 'b.md: 1'],
  );
  const testFiles = readdirSync(`${root}test`, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`.slice(root.length));
  assert.ok(testFiles.includes('test/support/golden.ts'), 'the files under test/ are read');
  assert.deepEqual(
    retiredWordsIn(Object.fromEntries(testFiles.map((path) => [path, readFileSync(root + path, 'utf8')]))),
    [],
    'say Source: example-source.ts, exampleSource, source, sourceFile',
  );
});
