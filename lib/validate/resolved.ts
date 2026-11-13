// A declared Flow narrowed to its Resolved Flow (#364): each field the validator copies as declared is held to its type
// by a guard, so a Flow whose fields all hold their types resolves, with no cast, and any other is only declared. The
// errors are flows.ts's to report; a guard only types what the checks have already judged.

import * as flow from '../flow.ts';
import type * as model from '../model.ts';
import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as rules from '../rules.ts';

const { isRecord } = referencePaths;

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const nullOr =
  <Narrowed>(guard: (value: unknown) => value is Narrowed) =>
  (value: unknown): value is Narrowed | null =>
    value === null || guard(value);
const listOf =
  <Narrowed>(guard: (value: unknown) => value is Narrowed) =>
  (value: unknown): value is Narrowed[] =>
    Array.isArray(value) && value.every(guard);
const recordOf =
  <Narrowed>(guard: (value: unknown) => value is Narrowed) =>
  (value: unknown): value is Record<string, Narrowed> =>
    isRecord(value) && Object.values(value).every(guard);

// Only these keys, each held by its guard; a key the shape leaves optional may be left out.
const shaped = (value: unknown, keys: Record<string, (field: unknown) => boolean>, optional: string[] = []) =>
  isRecord(value) &&
  Object.keys(value).every((key) => Object.hasOwn(keys, key)) &&
  Object.entries(keys).every(([key, guard]) =>
    Object.hasOwn(value, key) ? guard(value[key]) : optional.includes(key),
  );

const isTarget = (value: unknown): value is model.Target => isString(value) || shaped(value, { end: flow.isEnd });
const isEdge = (value: unknown): value is model.Edge =>
  shaped(value, { to: isTarget, max: isNumber, exhausted: isTarget }, ['max', 'exhausted']);
const isRouteTarget = (value: unknown): value is model.RouteTarget => isTarget(value) || isEdge(value);
const isRoutes = recordOf(isRouteTarget);
const isRouting = (value: unknown): value is model.Routing =>
  isRecord(value) && isRouteTarget(value.target) && isString(value.by) && nullOr(isString)(value.work);

const isTests = (value: unknown): value is model.ResolvedVertexJson['tests'] & {} =>
  value === 'frozen' || value === 'write' || shaped(value, { named: isString });
const isAgent = (value: unknown): value is model.Agent => isRecord(value) && isString(value.harness);

function resolvedVertex(vertex: model.DeclaredVertexJson): model.ResolvedVertexJson | undefined {
  const { use, agent, procedure, access, tests, route, max, exhausted, routing } = vertex;
  if (!nullOr(isString)(use) || !nullOr(isAgent)(agent) || !isString(procedure) || !isString(access)) return undefined;
  if (!nullOr(isTests)(tests) || !isRoutes(route) || !nullOr(isNumber)(max) || !nullOr(isTarget)(exhausted))
    return undefined;
  if (!recordOf(isRouting)(routing)) return undefined;
  return { ...vertex, use, agent, procedure, access, tests, route, max, exhausted, routing };
}

const isAction = (value: unknown): value is procedures.Action =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.do) &&
  Object.hasOwn(procedures.ACTION_KEYS, value.do) &&
  (value.kind === undefined || (isString(value.kind) && Object.hasOwn(procedures.CHECK_KEYS, value.kind)));
const isClaimToken = (value: unknown): value is procedures.ClaimToken =>
  shaped(value, { requires: listOf(isString) }) ||
  shaped(value, { stop: (stop) => stop === true, comment: isString }, ['comment']);
const isCondition = (value: unknown): value is rules.Condition =>
  value === null ||
  ['string', 'number', 'boolean'].includes(typeof value) ||
  (isRecord(value) &&
    Object.entries(value).every(
      ([key, operand]) => procedures.OPERATORS.some((operator) => operator === key) && isNumber(operand),
    ));
const isRow = (value: unknown): value is rules.RuleRow =>
  shaped(value, { when: recordOf(isCondition), outcome: isString });
const isRecover = (value: unknown): value is NonNullable<procedures.Procedure['recover']> =>
  shaped(value, { max: isNumber, brief: isString });

function resolvedProcedure(procedure: model.DeclaredProcedureJson): procedures.Procedure | undefined {
  const { actions, claimTokens, tests, access, recover, passed, failed, stopped, otherwise } = procedure;
  if (!listOf(isAction)(actions) || !recordOf(isClaimToken)(claimTokens) || !isTests(tests)) return undefined;
  if (!nullOr((value): value is 'read-only' => value === 'read-only')(access)) return undefined;
  if (!nullOr(isRecover)(recover) || !nullOr(isString)(otherwise)) return undefined;
  if (!listOf(isRow)(passed) || !listOf(isRow)(failed) || !listOf(isRow)(stopped)) return undefined;
  return { ...procedure, actions, claimTokens, tests, access, recover, passed, failed, stopped, otherwise };
}

// Each entry narrowed by `narrow`, or undefined when any one does not narrow. Built from entries, so a name such as
// __proto__ stays an own key (#174).
function narrowedEntries<Declared, Narrowed>(
  entries: Record<string, Declared>,
  narrow: (declared: Declared) => Narrowed | undefined,
): Record<string, Narrowed> | undefined {
  const narrowed: [string, Narrowed][] = [];
  for (const [name, declared] of Object.entries(entries)) {
    const resolved = narrow(declared);
    if (resolved === undefined) return undefined;
    narrowed.push([name, resolved]);
  }
  return Object.fromEntries(narrowed);
}

// The declared Flow as its Resolved Flow, or undefined when a field it copies does not hold its type.
export function resolvedFlow(declared: model.DeclaredFlowJson): model.ResolvedFlowJson | undefined {
  const { actionCap, ticket } = declared;
  const { entry, routes } = ticket;
  if (!isNumber(actionCap) || !isString(entry) || !isRoutes(routes)) return undefined;
  const vertices = narrowedEntries(ticket.vertices, resolvedVertex);
  const resolvedProcedures = narrowedEntries(declared.procedures, resolvedProcedure);
  if (!vertices || !resolvedProcedures) return undefined;
  return { ...declared, actionCap, procedures: resolvedProcedures, ticket: { ...ticket, entry, routes, vertices } };
}
