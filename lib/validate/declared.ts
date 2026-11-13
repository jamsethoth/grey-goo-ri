// A checked Flow as the validator gives it: declared with each value it copies as written, which gg doctor prints
// whether or not it resolved; its Resolved Flow, when resolved.ts can narrow it; and the files and commands it uses,
// recorded as each Procedure and Vertex was checked (#364).

import * as config from '../config.ts';
import type * as jsonValue from '../json-value.ts';
import type * as model from '../model.ts';
import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import * as checked from './procedures.ts';
import * as report from './report.ts';
import * as resolvedFlows from './resolved.ts';

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

// The Flow declared from its checked parts, its Resolved Flow when every value it copies holds its type, and its uses.
export function checkedFlow(
  name: string,
  declaration: Value,
  parts: {
    ticket: Value;
    vertices: Map<string, model.DeclaredVertexJson>;
    used: checked.CheckedProcedure[];
    personas: string[];
    declaredProcedures: unknown;
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
  return { declared, resolved: resolvedFlows.resolvedFlow(declared), uses: usesOf(parts.personas, used) };
}
