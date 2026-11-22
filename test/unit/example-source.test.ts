import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import * as typeShape from '../support/type-shape.ts';
import * as exampleSource from '../support/example-source.ts';

// The example configuration a case edits is typed by its own file, so tsc checks every read and refuses every edit out
// of its shape that does not go through putAt (#358, Q1 A). A value of the example's type therefore goes only where
// tsc checks it as that type, or to a place listed in `listed`; anywhere else, however it is typed, it escapes that
// check (D3 A). No test reaches the example through an `any` or a cast either.
const { root, configured } = typeShape;
const EXAMPLE_JSON = `${root}test/fixtures/example/gg.json`;
const EXAMPLE_MODULE = `${root}test/support/example-source.ts`;
// The one file whose subject is how a type treats an `any` (JsonValue's refusal of it), so its samples write one.
const WRITES_ANY = `${root}test/unit/json-value.test.ts`;
// Where tsc reads the standard library's declarations: its own lib files and Node's types.
const STANDARD_LIBRARY = ['/node_modules/typescript/lib/', '/node_modules/@types/node/'];
// The standard functions that only read what they are given, handing back its keys, its entries or a copy.
const STANDARD_READS = new Set(['entries', 'values', 'keys', 'structuredClone']);
const HANDED = 'the example handed to a place not typed by it';

// What the census asks of a node, over `checker`: whether a type, a call or a value is the example's.
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
  // An object literal that spreads the example holds its values, and its own type is not the file's (#358, m3).
  const isExample = (expression: ts.Expression): boolean =>
    fromExample(checker.getTypeAtLocation(expression)) ||
    (ts.isObjectLiteralExpression(expression) &&
      expression.properties.some((property) => ts.isSpreadAssignment(property) && isExample(property.expression)));
  // A place is the example's when it is typed by it; an intersection only when every member is, since an open record
  // beside the example lets any key in (#358, m2), at any depth of a union, list or tuple (round 5's m1).
  const isExamplePlace = (type: ts.Type, walking = new Set<ts.Type>()): boolean => {
    if (walking.has(type)) return false;
    walking.add(type);
    if (type.isIntersection()) return type.types.every((member) => isExamplePlace(member, walking));
    if (type.isUnion()) return type.types.some((member) => isExamplePlace(member, walking));
    if (checker.isArrayType(type) || checker.isTupleType(type))
      return checker.getTypeArguments(type as ts.TypeReference).some((member) => isExamplePlace(member, walking));
    return fromExample(type);
  };
  return { fromExample, isConfigCall, reaches, isExample, isExamplePlace };
}

// The call or `new` that `node` is an argument of, if any.
function callOf(node: ts.Node) {
  const { parent } = node;
  const isCall = ts.isCallExpression(parent) || ts.isNewExpression(parent);
  return isCall && parent.arguments?.includes(node as ts.Expression) ? parent : undefined;
}

const calleeOf = (call: ts.CallLikeExpression, checker: ts.TypeChecker) => {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  const name = declaration && !ts.isJSDocSignature(declaration) ? declaration.name?.getText() : undefined;
  return { declaration, file: declaration?.getSourceFile().fileName ?? '', name };
};

// The type tsc checks `node` against where it goes, or undefined when nothing receives it. A standard or other outside
// function's argument is judged by the parameter as declared, since tsc infers a generic one as the example's type; a
// function under test/ by the parameter as the call instantiates it, so a test helper typed by the example passes.
function placeOf(node: ts.Expression, checker: ts.TypeChecker) {
  const call = callOf(node);
  if (call === undefined) return checker.getContextualType(node);
  const { declaration, file } = calleeOf(call, checker);
  if (declaration === undefined || ts.isJSDocSignature(declaration) || file.startsWith(`${root}test/`))
    return checker.getContextualType(node);
  const { parameters } = declaration;
  const parameter = parameters[Math.min(call.arguments!.indexOf(node), parameters.length - 1)];
  return parameter === undefined ? undefined : checker.getTypeAtLocation(parameter);
}

type Reads = ReturnType<typeof exampleReads>;

// Whether `call`'s result could be its argument `node` typed wider: a result not the example's that the example fits.
const handsBack = (node: ts.Expression, call: ts.CallLikeExpression, checker: ts.TypeChecker, reads: Reads) => {
  const result = checker.getTypeAtLocation(call);
  return !reads.fromExample(result) && checker.isTypeAssignableTo(checker.getTypeAtLocation(node), result);
};

// The places the example may go that its type does not name.
function listed(node: ts.Expression, checker: ts.TypeChecker, reads: Reads) {
  const call = callOf(node);
  if (call !== undefined) {
    const { file, name } = calleeOf(call, checker);
    // putAt is the one edit out of the example's shape.
    if (file === EXAMPLE_MODULE && name === 'putAt') return true;
    // gg's own code reads what a case gives it, unless its result could be the argument handed back wider (#358, m4).
    if (file.startsWith(`${root}lib/`)) return !handsBack(node, call, checker, reads);
    return STANDARD_LIBRARY.some((library) => file.includes(library)) && STANDARD_READS.has(name ?? '');
  }
  const { parent } = node;
  // A spread, or a destructuring with no type of its own, copies the example's values with their types. tsc gives such
  // a binding pattern a contextual type whose properties are `any`, so it is listed here.
  if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) return true;
  if (ts.isVariableDeclaration(parent)) return !ts.isIdentifier(parent.name) && parent.type === undefined;
  return ts.isPropertyAssignment(parent) && goldenExample(parent, checker);
}

// The golden run of the example builds its golden configuration, its own fixture type, from the example in this one
// function; golden cases edit that configuration through its type, and nothing edits the example run's today.
function goldenExample(assignment: ts.PropertyAssignment, checker: ts.TypeChecker) {
  const literal = assignment.parent;
  return (
    checker.getContextualType(literal)?.getSymbol()?.name === 'GoldenConfig' &&
    assignment.getSourceFile().fileName === `${root}test/support/example-run.ts` &&
    ts.findAncestor(literal, ts.isFunctionDeclaration)?.name?.text === 'exampleConfig'
  );
}

// What `node` does to the example that tsc does not check: a cast of it, an `any`, the example handed to a place not
// typed by it, or given with a type argument that is not.
function escapes(node: ts.Node, checker: ts.TypeChecker, reads: Reads) {
  const { isExamplePlace, reaches, isExample } = reads;
  const found: string[] = [];
  if (isCast(node) && reaches(node.expression)) found.push('a cast of the example');
  if (node.kind === ts.SyntaxKind.AnyKeyword && node.getSourceFile().fileName !== WRITES_ANY) found.push('an any');
  if (typedWider(node, checker, reads)) found.push('the example given with a type argument not its own');
  if (widerCallback(node, checker, reads)) found.push(HANDED);
  if (!ts.isExpression(node)) return found;
  // The place is asked first: most expressions have none, and it is cheaper than the type of each.
  const place = placeOf(node, checker);
  if (place !== undefined && !isExamplePlace(place) && isExample(node) && !listed(node, checker, reads))
    found.push(HANDED);
  return found;
}

// A callback whose parameter is typed wider where its callee gives that parameter the example: tsc then checks the
// example against the callback's parameter, not against a place. Inline or passed by name, or typed by a variable, an
// object, a list, a return or an assignment, the callback is judged by its own signature against the one that place
// declares (#358, m1; round 5's m2; round 6's m1).
function widerCallback(node: ts.Node, checker: ts.TypeChecker, reads: Reads) {
  if (!ts.isExpression(node)) return false;
  if (callOf(node) === undefined && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const contextual = checker.getContextualType(node);
  const declared = contextual && checker.getSignaturesOfType(contextual, ts.SignatureKind.Call)[0];
  const own = checker.getSignaturesOfType(checker.getTypeAtLocation(node), ts.SignatureKind.Call)[0];
  if (declared === undefined || own === undefined) return false;
  return own.parameters.some((parameter, index) => {
    const given = declared.parameters[index];
    return (
      given !== undefined &&
      reads.fromExample(checker.getTypeOfSymbolAtLocation(given, node)) &&
      !reads.isExamplePlace(checker.getTypeOfSymbolAtLocation(parameter, node))
    );
  });
}

// A call given the example with a type argument that is not the example's, such as a listed read told to return
// Record<string, unknown>: the place it hands back is then typed by that argument.
const typedWider = (node: ts.Node, checker: ts.TypeChecker, reads: Reads) =>
  (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
  node.typeArguments?.some((argument) => !reads.fromExample(checker.getTypeFromTypeNode(argument))) === true &&
  node.arguments?.some(reads.isExample) === true;

const isCast = (node: ts.Node): node is ts.AsExpression | ts.TypeAssertion =>
  (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !ts.isConstTypeReference(node.type);

// The lines a comment tells tsc to ignore an error on: an edit of the example there is checked by nothing. A nocheck
// comment among the file's leading comments ignores every line (#358, m5).
const suppressedLines = (sourceFile: ts.SourceFile) => {
  const { text } = sourceFile;
  const nocheck = (ts.getLeadingCommentRanges(text, 0) ?? []).some((range) =>
    text.slice(range.pos, range.end).includes('@ts-nocheck'),
  );
  return new Set(
    text.split('\n').flatMap((line, index) => (nocheck || /@ts-(expect-error|ignore)/.test(line) ? [index + 1] : [])),
  );
};

// In `files` of `program`: every call of exampleSource.config(), and each place a test reaches the example around its
// type: a config() not typed by the example file, each escape `escapes` names, and the example on a suppressed line.
function census(program: ts.Program, files: (sourceFile: ts.SourceFile) => boolean) {
  const checker = program.getTypeChecker();
  const reads = exampleReads(checker);
  let configCalls = 0;
  // A line is reported once for each escape on it, however many of its nodes show it.
  const found = new Set<string>();
  for (const sourceFile of program.getSourceFiles().filter(files)) {
    const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    const where = (node: ts.Node) => `${sourceFile.fileName.slice(root.length)}:${lineOf(node) + 1}`;
    const suppressed = suppressedLines(sourceFile);
    const visit = (node: ts.Node): void => {
      if (reads.isConfigCall(node)) {
        configCalls += 1;
        if (!reads.fromExample(checker.getTypeAtLocation(node)))
          found.add(`${where(node)}: config() is not the example's type`);
      }
      for (const escape of escapes(node, checker, reads)) found.add(`${where(node)}: ${escape}`);
      if (suppressed.has(lineOf(node)) && ts.isExpression(node) && reads.reaches(node))
        found.add(`${where(node)}: a suppressed error on the example`);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { configCalls, found: [...found] };
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
const HEADER = [
  "import * as exampleSource from './example-source.ts';",
  "import * as golden from './golden.ts';",
  'const config = exampleSource.config();',
];

test("every exampleSource.config() under test/ is the example's type, edited around it nowhere", () => {
  const program = ts.createProgram(configured.fileNames, configured.options);
  const { configCalls, found } = census(
    program,
    (sourceFile) => sourceFile.fileName.startsWith(`${root}test/`) && !sourceFile.isDeclarationFile,
  );
  assert.ok(configCalls > 200, `the census finds the calls of config(): ${configCalls}`);
  assert.deepEqual(found, [], 'read the example as its type, and edit it out of its shape through putAt');
});

const CAST = 'a cast of the example';
const TYPE_ARGUMENT = 'the example given with a type argument not its own';
// Each planted line and what the census finds on it. The holes review round 3 and QA round 1 found in the census's
// first design, a list of escapes (#358, D3 A): M1 to M4 and QA's E1 to E6.
const SAMPLES: [string, ...string[]][] = [
  ['export const cast = config.flows as unknown;', CAST, HANDED],
  ['export const angled = <never>config.flows.default;', CAST, HANDED],
  ['export const field = config.labelPrefix as never;', CAST],
  ['export const parenthesized = (config.agents) as object;', CAST, HANDED],
  ['export const loose: any = config;', 'an any', HANDED],
  ['export const entries = Object.entries<any>(config.flows);', TYPE_ARGUMENT, 'an any'],
  ['Object.assign(config.agents.implementer, { mcp: [] });', HANDED],
  ['export const site: Record<string, unknown> = config.agents.implementer;', HANDED],
  ['((value: Record<string, unknown>) => value)(config.procedures.implement);', HANDED],
  ['export const nested: Record<string, Record<string, unknown>> = config.flows.default.ticket.vertices;', HANDED],
  ['export const objects: Record<string, object> = config.flows.default.ticket.vertices;', HANDED],
  ['export const named: { model?: unknown } = config.agents.implementer;', HANDED],
  ['export const each = Object.values<Record<string, unknown>>(config.agents);', TYPE_ARGUMENT],
  // M1: a destructuring typed wider than the example.
  ['export const { implementer }: { implementer: Record<string, unknown> } = config.agents;', HANDED],
  // M2: a standard function that keeps the value it is given.
  ['export const bag: Record<string, unknown>[] = []; bag.push(config.agents.implementer);', HANDED],
  ['export const promised: Promise<Record<string, unknown>> = Promise.resolve(config.agents.implementer);', HANDED],
  ['export const frozen: Readonly<Record<string, unknown>> = Object.freeze(config.agents.implementer);', HANDED],
  // M3: a Map or Set built over the example.
  [
    'export const mapped = new Map<string, Record<string, unknown>>(Object.entries(config.agents));',
    TYPE_ARGUMENT,
    HANDED,
  ],
  ['export const set = new Set<Record<string, unknown>>(Object.values(config.agents));', TYPE_ARGUMENT, HANDED],
  // M4: a golden configuration built from the example outside the golden run's exampleConfig().
  ['export const golden2: golden.GoldenConfig = { ...golden.goldenConfig(), procedures: config.procedures };', HANDED],
  // E1 to E3: reflection, and Object.assign under another name.
  ["Reflect.set(config, 'labelPrefix', null);", HANDED],
  ["Object.defineProperty(config, 'labelPrefix', { value: null });", HANDED],
  ['const qaAssign = Object.assign; qaAssign(config.agents.implementer, { mcp: [] });', HANDED],
  // E4: a closed place whose value type is wider; E5: `object`, then Object.assign.
  ['export const wider: { labelPrefix: string | number } = config;', HANDED],
  ['export const opaque: object = config; Object.assign(opaque, { labelPrefix: null });', HANDED],
  // E6: an edit out of the shape whose error a comment suppresses.
  ['// @ts-expect-error'],
  ['config.labelPrefix = null;', 'a suppressed error on the example'],
  // A list of the example widened, and an open record two levels down.
  ['export const listed: Record<string, unknown>[] = Object.values(config.agents);', HANDED],
  [
    'export const inner: { ticket: { vertices: Record<string, Record<string, unknown>> } } = config.flows.default;',
    HANDED,
  ],
  // Review round 4's m1 to m4: a callback parameter typed wider, an intersection with an open record, a spread copy in
  // a wider place, and a function under lib/ that hands its argument back wider.
  ['config.procedures.review.actions.forEach((action: Record<string, unknown>) => { action.extra = 1; });', HANDED],
  [
    'export const both: typeof config.agents.implementer & Record<string, unknown> = config.agents.implementer;',
    HANDED,
  ],
  ['export const vs: Record<string, Record<string, unknown>> = { ...config.flows.default.ticket.vertices };', HANDED],
  ["import * as declared from '../../lib/validate/declared.ts';"],
  ['export const viaLib = declared.declaredValue(config.agents);', HANDED],
  // Review round 5's m1 and m2: an intersection with an open record inside a list, and a callback passed by name.
  [
    'const one = [config.agents.implementer]; export const xs: (typeof one[0] & Record<string, unknown>)[] = one;',
    HANDED,
  ],
  [
    'function wide(action: Record<string, unknown>) { action.x = 1; } config.procedures.review.actions.forEach(wide);',
    HANDED,
  ],
  // Review round 6's m1: a callback typed wider where something other than a call's argument gives it its type, a
  // variable, an object, a list, a return or an assignment.
  ['type A = (typeof config.procedures.review.actions)[number];'],
  [
    'export const viaVariable: (action: A) => void = (action: Record<string, unknown>) => { action.extra = 1; };',
    HANDED,
  ],
  ['function each<T>(items: T[], visitor: { visit: (item: T) => void }) { items.forEach(visitor.visit); }'],
  [
    'each(config.procedures.review.actions, { visit: (action: Record<string, unknown>) => { action.extra = 1; } });',
    HANDED,
  ],
  [
    'export const viaList: ((action: A) => void)[] = [(action: Record<string, unknown>) => { action.extra = 1; }];',
    HANDED,
  ],
  [
    'export function make(): (action: A) => void { return (action: Record<string, unknown>) => { action.x = 1; }; }',
    HANDED,
  ],
  [
    'export const viaFunction: (action: A) => void = function (action: Record<string, unknown>) { action.extra = 1; };',
    HANDED,
  ],
  [
    'let assigned: (action: A) => void = () => {}; assigned = (action: Record<string, unknown>) => { action.x = 1; };',
    HANDED,
  ],
  ['export const read = config.flows.default.actionCap;'],
  ['export const values = Object.values(config.agents);'],
  ["exampleSource.putAt(config, ['labelPrefix'], null);"],
  ["export const constant = 'x' as const;"],
  ["export const parsed = JSON.parse('{}') as typeof config;"],
  ['export const { implement } = config.procedures;'],
  ['export const typed: exampleSource.Source["agents"] = config.agents;'],
  ['export const prefix: string = config.labelPrefix;'],
  ['export const checked = exampleSource.check(config);'],
  ['export const copy = { ...config.agents.implementer, model: "m" };'],
  ['export const cloned = structuredClone(config.flows.default);'],
];

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('the census finds a config() not typed by the example, each cast of it, each any, and each edit around its type', () => {
  const { program, plantedFile } = plantedProgram([...HEADER, ...SAMPLES.map(([sample]) => sample)]);
  const { configCalls, found } = census(program, (sourceFile) => sourceFile === plantedFile);
  assert.equal(configCalls, 1);
  assert.deepEqual(
    found,
    SAMPLES.flatMap(([, ...findings], index) =>
      findings.map((finding) => `test/support/planted-example.ts:${HEADER.length + index + 1}: ${finding}`),
    ),
  );
});

test('the census reads every line of a file under a leading nocheck comment as suppressed', () => {
  const { program, plantedFile } = plantedProgram(['// @ts-nocheck', ...HEADER, 'config.labelPrefix = null;']);
  const { found } = census(program, (sourceFile) => sourceFile === plantedFile);
  assert.deepEqual(found, [
    'test/support/planted-example.ts:4: a suppressed error on the example',
    'test/support/planted-example.ts:5: a suppressed error on the example',
  ]);
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
  assert.deepEqual(
    HEADER.flatMap((_, index) => codesOn(index + 1)),
    [],
    'the header compiles',
  );
});

test('putAt edits a list item by its index, and refuses to remove one', () => {
  const config = exampleSource.config();
  exampleSource.putAt(config.procedures.review, ['actions', '0', 'id'], 'edited');
  assert.equal(config.procedures.review.actions[0].id, 'edited');
  const length = config.procedures.review.actions.length;
  assert.throws(() => exampleSource.putAt(config.procedures.review, ['actions', '1']), /a list item/);
  assert.equal(config.procedures.review.actions.length, length);
  assert.ok(1 in config.procedures.review.actions, 'the list keeps its item');
});

test('putAt refuses a path through a key the fixture does not hold', () => {
  assert.throws(
    () => exampleSource.putAt(exampleSource.config(), ['noSuchKey', 'x'], 1),
    /no object or list at noSuchKey\.x/,
  );
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
