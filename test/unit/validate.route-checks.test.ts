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
// Depth less one, so the walk below stops.
type Less = [never, 0, 1, 2, 3, 4, 5, 6];
// Each path in a value, to six levels, that can hold a flag or a refusal: the value, a field, a Map's value, a list's
// item. A function is behaviour, not a value given.
type Flags<Value, At extends string, Depth extends number> = [Depth] extends [never]
  ? never
  : Admits<Value> extends true
    ? At
    : Value extends ReadonlyMap<unknown, infer Item>
      ? Flags<NonNullable<Item>, `${At}.*`, Less[Depth]>
      : Value extends readonly (infer Item)[]
        ? Flags<Item, `${At}[]`, Less[Depth]>
        : Value extends (...args: never[]) => unknown
          ? never
          : Value extends object
            ? { [Key in keyof Value & string]-?: Flags<Value[Key], `${At}.${Key}`, Less[Depth]> }[keyof Value & string]
            : never;
// The paths whose boolean is data, not a flag: a Vertex as declared (JSON), a Procedure's JSON Schema, a Claim token's
// declared `stop`, an Action's keys as declared, and the two route facts the graph computes for each edge.
type Data =
  | `[1].${'resolved' | 'warned'}.*.${string}`
  | `[1].whole.*.vertex.${string}`
  | `${string}.schema.${string}`
  | `${string}.claimTokens.${string}`
  | `${string}.actions[].${string}`
  | '[2][].write'
  | '[2][].landings[].exhausted';
// Each parameter's paths, by its position, that can hold a flag or a refusal.
type ParameterFlags<Parameters extends unknown[]> = Exclude<
  {
    [Index in keyof Parameters & `${number}`]: Flags<Parameters[Index], `[${Index}]`, 6>;
  }[keyof Parameters & `${number}`],
  Data
>;
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
      // Every member, a template path such as a Record key's among them; none when the type is never.
      const members = type.isUnion() ? type.types : [type];
      flagged[node.name.getText()] = members
        .filter((member) => !(member.flags & ts.TypeFlags.Never))
        .map((member) => checker.typeToString(member));
    }
    ts.forEachChild(node, visit);
  };
  visit(program.getSourceFile(testFile)!);
  assert.deepEqual(flagged, Object.fromEntries(Object.keys(ROUTE_CHECKS).map((check) => [check, []])));
});
