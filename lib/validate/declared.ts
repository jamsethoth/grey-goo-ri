// A checked Flow as the validator gives it: declared with each value it copies as written, which gg doctor prints
// whether or not it resolved (#364); its Resolved Flow, built from the values its checks typed when none refused one
// (#391); and the files and commands it uses, recorded as each Procedure and Vertex was checked.

import * as config from '../config.ts';
import * as flow from '../flow.ts';
import type * as jsonValue from '../json-value.ts';
import type * as model from '../model.ts';
import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as flows from './flows.ts';
import * as checked from './procedures.ts';
import * as report from './report.ts';

type JsonValue = jsonValue.JsonValue;
type Value = Record<string, unknown>;
const { isRecord } = referencePaths;

// What a Flow uses beyond its Resolved Flow: the files its Agents and Procedures name, which its Pinned Configuration
// takes, and the commands its Checks run, each once, in the order the Flow first uses them.
export interface Uses {
  files: string[];
  commands: string[];
}

// What the declared view holds where the configuration was parsed JSON: the value, typed so, or undefined when left
// out. A value that is not JSON never comes from a gg.json, so it is left out the same way.
export const declaredValue = (value: unknown): JsonValue | undefined => (isJson(value) ? value : undefined);
function isJson(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}

// A Vertex as the validator declares it, each value it copies as written. A Procedure's read-only caps its Agent's
// access.
export function declaredVertex(
  vertex: Value,
  resolved: Pick<model.DeclaredVertexJson, 'inputs' | 'approvalLabels'> & {
    agent: Value | null;
    falls: checked.FallThroughs;
  },
  proc?: checked.CheckedProcedure,
): model.DeclaredVertexJson {
  const { agent, falls } = resolved;
  return {
    use: declaredValue(vertex.use) ?? null,
    agent: declaredValue(agent) ?? null,
    procedure: declaredValue(vertex.procedure) ?? null,
    access: proc?.access === 'read-only' ? 'read-only' : (declaredValue(agent?.access) ?? 'read-only'),
    tests: declaredValue(proc?.tests) ?? null,
    outcomes: proc ? checked.outcomesOf(proc, falls) : [],
    approvalLabels: resolved.approvalLabels,
    routing: {},
    inputs: resolved.inputs,
    route: declaredValue(vertex.route) ?? {},
    max: declaredValue(vertex.max) ?? null,
    exhausted: declaredValue(vertex.exhausted) ?? null,
  };
}

// Each Procedure a Vertex uses, as declared and hashed, so a resumed Visit can tell it has changed (S6).
function usedProcedures(
  declaredProcedures: unknown,
  used: checked.CheckedProcedure[],
): Record<string, model.DeclaredProcedureJson> {
  const declared = new Map(report.entries(declaredProcedures));
  return Object.fromEntries(
    used.map((proc) => {
      const { actions, claimTokens, tests, access, recover, tables, otherwise, checkIds } = proc;
      const hash = config.hashOf(declared.get(proc.name));
      const resolved = {
        actions: declaredValue(actions) ?? [],
        claimTokens: declaredValue(claimTokens) ?? {},
        tests: declaredValue(tests) ?? null,
        access: declaredValue(access) ?? null,
        recover: declaredValue(recover) ?? null,
        passed: declaredValue(tables.passed) ?? [],
        failed: declaredValue(tables.failed) ?? [],
        stopped: declaredValue(tables.stopped) ?? [],
        otherwise: declaredValue(otherwise) ?? null,
      };
      return [proc.name, { ...resolved, checks: checkIds, hash }];
    }),
  );
}

// The files a checked Procedure names, at each key procedures.FILE_KEYS declares: on each Action whatever its kind, in
// its `recover`, then on each Claim token, as it declares them.
const filesOf = ({ actions, recover, claimTokens }: checked.CheckedProcedure) => [
  ...actions.flatMap((action) => procedures.filesAt('action', action)),
  ...procedures.filesAt('recover', recover),
  ...Object.values(claimTokens).flatMap((token) => procedures.filesAt('claimToken', token)),
];
// The commands named on a checked Procedure's Actions, whatever their kind: a user Flow naming one the repository lacks
// does not fit it (Q21).
const commandsOf = ({ actions }: checked.CheckedProcedure) =>
  actions.flatMap((action) => (isRecord(action) && typeof action.command === 'string' ? [action.command] : []));

// What a Flow uses: its Personas, then each used Procedure's files, and those Procedures' commands, each name once.
function usesOf(personas: string[], used: checked.CheckedProcedure[]): Uses {
  return {
    files: [...new Set([...personas, ...used.flatMap(filesOf)])],
    commands: [...new Set(used.flatMap(commandsOf))],
  };
}

type Judged<Parts> = { [Key in keyof Parts]: Exclude<Parts[Key], report.Reported | undefined> };
// Every part as its check typed it: none Reported, and none a check of references.ts refuses.
const allTyped = <Parts extends object>(parts: Parts): parts is Parts & Judged<Parts> =>
  Object.values(parts).every((part) => part !== undefined && !report.isReported(part));

// Each entry narrowed by `narrow`, or undefined when any one does not narrow. Built from entries, so a name such as
// __proto__ stays an own key (#174).
function narrowedEntries<Declared, Narrowed>(
  entries: Iterable<[string, Declared]>,
  narrow: (name: string, declared: Declared) => Narrowed | undefined,
): Record<string, Narrowed> | undefined {
  const narrowed: [string, Narrowed][] = [];
  for (const [name, declared] of entries) {
    const resolved = narrow(name, declared);
    if (resolved === undefined) return undefined;
    narrowed.push([name, resolved]);
  }
  return Object.fromEntries(narrowed);
}

// What the Flow's checks typed: its own values, each Vertex's, and each used Procedure's.
type TypedParts = flows.TypedFlow & { vertices: Map<string, flows.TypedVertex> };

// A Vertex as the Resolved Flow carries it, its routing's targets as its typed routes give them.
function resolvedVertex(
  declared: model.DeclaredVertexJson,
  typed: flows.TypedVertex | undefined,
  resolved: { procedures: Map<string, procedures.Procedure>; routes: Record<string, model.RouteTarget> },
): model.ResolvedVertexJson | undefined {
  if (!typed || !allTyped(typed)) return undefined;
  const proc = resolved.procedures.get(typed.procedure);
  if (!proc) return undefined;
  const routing: [string, model.Routing][] = [];
  for (const [outcome, entry] of Object.entries(declared.routing)) {
    const routed = flow.typedRoute(typed.route, resolved.routes, outcome);
    if (!routed) return undefined;
    routing.push([outcome, { ...entry, target: routed.target }]);
  }
  return { ...declared, ...typed, tests: proc.tests, routing: Object.fromEntries(routing) };
}

// The Resolved Flow from the values its checks typed, or undefined when a check refused one.
function resolvedFlow(declared: model.DeclaredFlowJson, used: checked.CheckedProcedure[], typed: TypedParts) {
  const { vertices, ...own } = typed;
  if (!allTyped(own)) return undefined;
  const byName = new Map(used.map((proc) => [proc.name, proc]));
  const resolvedProcedures = narrowedEntries(Object.entries(declared.procedures), (name, procedure) => {
    const parts = byName.get(name)?.typed;
    return parts && allTyped(parts) ? { ...procedure, ...parts } : undefined;
  });
  if (!resolvedProcedures) return undefined;
  const context = { procedures: new Map(Object.entries(resolvedProcedures)), routes: own.routes };
  const resolvedVertices = narrowedEntries(Object.entries(declared.ticket.vertices), (id, vertex) =>
    resolvedVertex(vertex, vertices.get(id), context),
  );
  if (!resolvedVertices) return undefined;
  const ticket = { ...declared.ticket, entry: own.entry, routes: own.routes, vertices: resolvedVertices };
  return { ...declared, actionCap: own.actionCap, procedures: resolvedProcedures, ticket };
}

// The Flow declared from its checked parts, its Resolved Flow when no check refused a value it copies, and its uses.
export function checkedFlow(
  name: string,
  declaration: Value,
  parts: {
    ticket: Value;
    vertices: Map<string, model.DeclaredVertexJson>;
    used: checked.CheckedProcedure[];
    personas: string[];
    declaredProcedures: unknown;
    typed: TypedParts;
  },
) {
  const { ticket, vertices, used } = parts;
  const declared: model.DeclaredFlowJson = {
    name,
    actionCap: declaredValue(declaration.actionCap) ?? null,
    procedures: usedProcedures(parts.declaredProcedures, used),
    ticket: {
      entry: declaredValue(ticket.entry) ?? null,
      routes: declaredValue(ticket.routes) ?? {},
      vertices: Object.fromEntries(vertices),
    },
  };
  // In the order the Flow's Procedures are declared in its JSON, which puts integer-like names first, as pinning did.
  const byName = new Map(used.map((proc) => [proc.name, proc]));
  const ordered = Object.keys(declared.procedures).flatMap((procedureName) => byName.get(procedureName) ?? []);
  const resolved: model.ResolvedFlowJson | undefined = resolvedFlow(declared, used, parts.typed);
  return { declared, resolved, uses: usesOf(parts.personas, ordered) };
}
