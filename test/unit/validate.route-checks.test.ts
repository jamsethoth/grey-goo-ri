import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as graph from '../../lib/validate/graph.ts';
import type * as report from '../../lib/validate/report.ts';
import * as routeFacts from '../../lib/validate/route-facts.ts';
import * as routes from '../../lib/validate/routes.ts';
import * as typeShape from '../support/type-shape.ts';

// The route checks receive only values that held: a refused value is absent from what they are given, so no check
// tests a flag or a refusal (#459, Q2 A). tsc holds each parameter of each check to that.

// A flag, a set of ids, or a refusal.
type Banned = boolean | Set<unknown> | report.Reported;
type Admits<Value> = [Extract<Value, Banned>] extends [never] ? false : true;
// The fields of each value of a Map that can hold a refusal, at `at.*`.
type MapFlags<Value, At extends string> = {
  [Key in keyof Value & string]-?: [Extract<Value[Key], report.Reported>] extends [never] ? never : `${At}.*.${Key}`;
}[keyof Value & string];
// The fields of a parameter that can hold a flag or a refusal, or a field of each value of a Map field that can.
type FieldFlags<Value, At extends string> = {
  [Key in keyof Value & string]-?: Admits<Value[Key]> extends true
    ? `${At}.${Key}`
    : Value[Key] extends Map<unknown, infer Item>
      ? MapFlags<NonNullable<Item>, `${At}.${Key}`>
      : never;
}[keyof Value & string];
// Each parameter, by its position, that is or holds a flag or a refusal.
type ParameterFlags<Parameters extends unknown[]> = {
  [Index in keyof Parameters & `${number}`]: Admits<Parameters[Index]> extends true
    ? `[${Index}]`
    : FieldFlags<Parameters[Index], `[${Index}]`>;
}[keyof Parameters & `${number}`];
// tsc fails at the line of each check below that receives a flag or a refusal.
const held = <Flagged extends string>(flagged: [Flagged] extends [never] ? 'held' : Flagged) => flagged;

// Each route check: graph.ts's and route-facts.ts's, and routes.ts's check of each route key (#459, Q1 A).
const ROUTE_CHECKS = {
  checkGraph: held<ParameterFlags<Parameters<typeof graph.checkGraph>>>('held'),
  checkFacts: held<ParameterFlags<Parameters<typeof routeFacts.checkFacts>>>('held'),
  checkRouteKeys: held<ParameterFlags<Parameters<typeof routes.checkRouteKeys>>>('held'),
};

// The route checks' source: graph.ts, route-facts.ts and routes.ts's checkRouteKeys, to the end of its body.
const validateSource = (file: string) => readFileSync(new URL(`../../lib/validate/${file}`, import.meta.url), 'utf8');
const routeKeysSource = () => {
  const source = validateSource('routes.ts');
  const start = source.indexOf('export function checkRouteKeys(');
  assert.ok(start >= 0, 'routes.ts declares checkRouteKeys');
  return source.slice(start, source.indexOf('\n}\n', start));
};

// A refusal the route checks read is a skip at its own line, which needs its own test (#454's six findings); the
// census in validate.holds.test.ts lists the reads that stay, in the checks that refuse a value (#459, Q1 A).
test('no route check reads a refusal', () => {
  const sources = {
    'graph.ts': validateSource('graph.ts'),
    'route-facts.ts': validateSource('route-facts.ts'),
    'routes.ts checkRouteKeys': routeKeysSource(),
  };
  const reads = Object.entries(sources).flatMap(([file, source]) =>
    source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), where: `${file}:${index + 1}` }))
      .filter(({ line }) => !line.startsWith('//') && /isReported|reportedSince|refused|Refused/.test(line))
      .map(({ where, line }) => `${where}: ${line}`),
  );
  assert.deepEqual(reads, []);
});

test('every route check graph.ts and route-facts.ts export is held to the values it receives', () => {
  const exported = [graph, routeFacts].flatMap((module) =>
    Object.entries(module)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name),
  );
  assert.deepEqual(Object.keys(ROUTE_CHECKS).sort(), [...exported, 'checkRouteKeys'].sort());
});

// The check stage's tsc fails at the line of each check above that is flagged; this case names the flagged parameters
// and fields in a run of the unit tests.
test('no route check receives a value that can hold a flag or a refusal', () => {
  const testFile = fileURLToPath(import.meta.url).replaceAll('\\', '/');
  const program = ts.createProgram([testFile], typeShape.configured.options);
  const checker = program.getTypeChecker();
  const flagged: Record<string, string[]> = {};
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && node.initializer.typeArguments) {
      const type = checker.getTypeFromTypeNode(node.initializer.typeArguments[0]!);
      const members = type.isUnion() ? type.types : [type];
      flagged[node.name.getText()] = members.filter((member) => member.isStringLiteral()).map(({ value }) => value);
    }
    ts.forEachChild(node, visit);
  };
  visit(program.getSourceFile(testFile)!);
  assert.deepEqual(flagged, Object.fromEntries(Object.keys(ROUTE_CHECKS).map((check) => [check, []])));
});
