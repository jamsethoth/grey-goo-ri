// A Flow as declared, checked against the checked Procedures: its keys, routes and Vertices and each Vertex's Agent,
// giving the Resolved Flow. A Vertex's inputs are inputs.ts's, the graph checks graph.ts's.

import * as config from '../config.ts';
import * as flow from '../flow.ts';
import * as labels from '../labels.ts';
import * as procedures from '../procedures.ts';
import * as refs from '../refs.ts';
import * as graph from './graph.ts';
import * as inputs from './inputs.ts';
import * as checked from './procedures.ts';
import * as references from './references.ts';
import * as report from './report.ts';
import * as templates from './templates.ts';

// The keys each object of a Layer may declare; any other is an unknown key (the request tables them).
export const AGENT_KEYS = [
  'harness',
  'model',
  'effort',
  'persona',
  'skills',
  'mcp',
  'plugins',
  'mode',
  'access',
  'network',
  'resolutionPolicy',
  'contextBudget',
  'timeouts',
];
// A Vertex also takes any Agent key, overriding its Agent's.
export const VERTEX_KEYS = ['use', 'procedure', 'inputs', 'route', 'max', 'exhausted'];
export const FLOW_KEYS = ['plan', 'actionCap', 'ticket'];
export const TICKET_KEYS = ['entry', 'routes', 'vertices'];
// A route target is a Vertex id, { end }, or this edge form.
export const EDGE_KEYS = ['to', 'max', 'exhausted'];
// `cleanup` is the Pending cleanup hold's Await Label (L11) and `done` the human-only end (L12).
const RESERVED_VERTICES: string[] = [...labels.ENDS, 'cleanup', 'done'];
// What an Agent asks for (Permission Intents). Integrity treats any access but read-only as a write, so a typo such as
// read-write would run as workspace-write.
export const PERMISSION_INTENTS = ['read-only', 'workspace-write'];

type Value = Record<string, unknown>;
type Falls = checked.Falls;
// What checking a Flow reads beyond the Flow itself.
export interface Checking {
  report: report.Report;
  config: Value;
  procedures: Record<string, checked.CheckedProcedure | undefined>;
  procedureFalls: Record<string, Falls>;
  failedAgents: Set<unknown>;
  harnesses: unknown;
  reader: templates.TemplateReader | null;
  // The errors outside every Flow, which hold every Flow's graph checks (H6).
  sharedErrors: number;
}
// Where a Vertex is: its id, and its location in the configuration.
interface VertexPlace {
  id: string;
  location: string;
}
// The Flow's Vertices as they are checked, and what the graph checks read of them.
interface FlowState {
  location: string;
  vertices: Value;
  sources: refs.SchemaNode;
  resolved: Record<string, graph.ResolvedVertex>;
  used: Set<string>;
  procs: Record<string, checked.CheckedProcedure | undefined>;
  fallsOf: Record<string, Falls>;
  held: boolean;
}

export function checkAccess(problems: report.Report, location: string, access: unknown) {
  if (access !== undefined && !PERMISSION_INTENTS.includes(access as string)) {
    const intents = PERMISSION_INTENTS.join(' or ');
    report.error(problems, location, `access ${JSON.stringify(access)} is not a Permission Intent: ${intents}`);
  }
}

export function checkHarness(
  checking: Pick<Checking, 'report' | 'harnesses'>,
  label: string,
  harness: unknown,
  location: string,
) {
  const problems = checking.report;
  if (harness == null)
    report.error(problems, location, `${label} names no harness; set one in a user or repository Layer`);
  else if (!report.has(checking.harnesses, harness))
    report.error(problems, location, `${label} names harness ${JSON.stringify(harness)}, which is not registered`);
}

function checkTarget(problems: report.Report, location: string, target: unknown, vertices: Value) {
  if (typeof target === 'string') {
    if (!Object.hasOwn(vertices, target)) report.error(problems, location, `${JSON.stringify(target)} is not a Vertex`);
  } else if (refs.isRecord(target) && Object.hasOwn(target, 'end') && Object.keys(target).length === 1) {
    if (target.end === 'done')
      report.error(problems, location, 'end "done" is the human-only end, which no route may name');
    else if (!flow.isEnd(target.end))
      report.error(problems, location, `end ${JSON.stringify(target.end)} is not one of ${labels.ENDS.join(', ')}`);
  } else {
    report.error(problems, location, 'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }');
  }
}

// A route's target may also be an edge, which bounds its traversals.
function checkRouteTarget(problems: report.Report, location: string, target: unknown, vertices: Value) {
  if (!(refs.isRecord(target) && Object.hasOwn(target, 'to'))) return checkTarget(problems, location, target, vertices);
  report.unknownKeys(problems, target, EDGE_KEYS, location);
  checkTarget(problems, location, target.to, vertices);
  if (target.max !== undefined && !report.isCount(target.max))
    report.error(problems, location, 'max must be a positive integer');
  if (target.max !== undefined && target.exhausted === undefined)
    report.error(problems, location, 'an edge with max names its exhausted target');
  if (target.max === undefined && target.exhausted !== undefined)
    report.error(problems, location, 'an edge names exhausted only with max');
  if (target.exhausted !== undefined) checkTarget(problems, location, target.exhausted, vertices);
}

// The Flow's own keys, its ticket section and its routes; the ticket and its Vertices, whatever their shape.
function checkFlowKeys(problems: report.Report, location: string, declaration: Value) {
  report.unknownKeys(problems, declaration, FLOW_KEYS, location);
  // plan is never defaulted, and must be null until Epic planning is built (X2b, X2d).
  if (!Object.hasOwn(declaration, 'plan'))
    report.error(problems, location, 'plan is required: null when the Flow has no Epic-level planning');
  else if (declaration.plan !== null)
    report.error(problems, `${location}.plan`, 'plan must be null until Epic planning is built');
  if (!report.isCount(declaration.actionCap))
    report.error(problems, `${location}.actionCap`, 'actionCap must be a positive integer');
  const ticket = refs.isRecord(declaration.ticket) ? declaration.ticket : {};
  if (!refs.isRecord(declaration.ticket)) report.error(problems, `${location}.ticket`, 'ticket must be an object');
  report.unknownKeys(problems, ticket, TICKET_KEYS, `${location}.ticket`);
  const vertices = refs.isRecord(ticket.vertices) ? ticket.vertices : {};
  if (!Object.keys(vertices).length)
    report.error(problems, `${location}.ticket.vertices`, 'vertices must be a non-empty object');
  if (typeof ticket.entry !== 'string' || !Object.hasOwn(vertices, ticket.entry))
    report.error(problems, `${location}.ticket.entry`, `${JSON.stringify(ticket.entry)} is not a Vertex`);
  if (ticket.routes !== undefined && !refs.isRecord(ticket.routes))
    report.error(problems, `${location}.ticket.routes`, 'routes must be an object from Outcome to target');
  for (const [outcome, target] of report.entries(ticket.routes))
    checkRouteTarget(problems, `${location}.ticket.routes.${outcome}`, target, vertices);
  return { ticket, vertices };
}

// A Vertex names an Agent that is not declared, or gives one to a Procedure with no agent Action.
function refusesAgent(
  checking: Checking,
  given: { vertex: Value; overrides: Value; location: string },
  proc?: checked.CheckedProcedure,
) {
  const { vertex, overrides, location } = given;
  if (vertex.use !== undefined && !report.has(checking.config.agents, vertex.use)) {
    report.error(checking.report, location, `uses agent ${JSON.stringify(vertex.use)}, which is not declared`);
    return true;
  }
  if (proc && !proc.agent && (vertex.use !== undefined || Object.keys(overrides).length)) {
    const message = `procedure ${proc.name} has no agent Action, so the Vertex takes no Agent`;
    report.error(checking.report, location, message);
    return true;
  }
  return false;
}

// The Agent a Vertex runs, the declared Agent under the Vertex's own Agent keys, or null when it takes none.
function vertexAgent(
  checking: Checking,
  place: VertexPlace,
  vertex: Value,
  proc?: checked.CheckedProcedure,
): Value | null {
  const problems = checking.report;
  const { location } = place;
  const agents = checking.config.agents;
  const overrides = Object.fromEntries(Object.entries(vertex).filter(([key]) => AGENT_KEYS.includes(key)));
  if (refusesAgent(checking, { vertex, overrides, location }, proc)) return null;
  const declared = vertex.use === undefined ? {} : (agents as Value)[vertex.use as string];
  // A declared Agent that is not an object, or names an unregistered harness, is reported at agents.<name>.
  if (!proc?.agent || !refs.isRecord(declared)) return null;
  const merged: Value = { ...declared, ...overrides };
  if (vertex.use === undefined && !Object.keys(merged).length) {
    report.error(problems, location, `procedure ${proc.name} has an agent Action, so the Vertex needs an Agent`);
    return null;
  }
  // A harness the Vertex does not set itself is the Agent's, checked at agents.<name>.
  if (vertex.use === undefined || Object.hasOwn(overrides, 'harness')) {
    const label = vertex.use === undefined ? `the agent of Vertex ${place.id}` : `agent ${vertex.use}`;
    checkHarness(checking, label, merged.harness, location);
  }
  return { ...merged, harness: merged.harness ?? null, model: merged.model ?? null, effort: merged.effort ?? null };
}

function checkVertexRoutes(problems: report.Report, location: string, vertex: Value, vertices: Value) {
  for (const [outcome, target] of report.entries(vertex.route))
    checkRouteTarget(problems, `${location}.route.${outcome}`, target, vertices);
  if (vertex.route !== undefined && !refs.isRecord(vertex.route))
    report.error(problems, `${location}.route`, 'route must be an object from Outcome to target');
  if (vertex.max !== undefined && !report.isCount(vertex.max))
    report.error(problems, `${location}.max`, 'max must be a positive integer');
  if (vertex.max !== undefined && vertex.exhausted === undefined)
    report.error(problems, location, 'a Vertex with max names its exhausted target');
  if (vertex.max === undefined && vertex.exhausted !== undefined)
    report.error(problems, location, 'a Vertex names exhausted only with max');
  if (vertex.exhausted !== undefined) checkTarget(problems, `${location}.exhausted`, vertex.exhausted, vertices);
}

// The Procedure's references and templates typed in the Vertex's scope; the tokens some input falls through each
// table for, alone or here.
function vertexFalls(checking: Checking, location: string, typed: inputs.TypedInputs, proc: checked.CheckedProcedure) {
  const locate = (where: string) => `${location} (procedure ${proc.name}).${where}`;
  const falls = {
    ...(checking.procedureFalls[proc.name] ?? {}),
    ...references.runRefs(checking.report, proc, {
      inputs: procedures.object(typed.nodes),
      optional: (input) => typed.inputs[input]?.optional === true,
      atVertex: true,
      locate,
    }),
  };
  for (const found of templates.templateRefs(proc, procedures.object(typed.nodes), checking.reader))
    report.error(checking.report, locate(found.where), found.message);
  return falls;
}

// A Vertex as the Resolved Flow carries it. A Procedure's read-only caps its Agent's access.
function resolveVertex(
  vertex: Value,
  resolved: { agent: Value | null; inputs: Record<string, inputs.ResolvedInput>; falls: Falls },
  proc?: checked.CheckedProcedure,
): graph.ResolvedVertex {
  const { agent, falls } = resolved;
  return {
    use: vertex.use ?? null,
    agent,
    procedure: vertex.procedure,
    access: proc?.access === 'read-only' ? 'read-only' : (agent?.access ?? 'read-only'),
    tests: proc?.tests ?? null,
    outcomes: proc ? checked.outcomesOf(proc, falls) : [],
    routing: {},
    inputs: resolved.inputs,
    route: vertex.route ?? {},
    max: vertex.max ?? null,
    exhausted: vertex.exhausted ?? null,
  };
}

function checkVertex(checking: Checking, state: FlowState, id: string, vertex: unknown) {
  const problems = checking.report;
  const location = `${state.location}.ticket.vertices.${id}`;
  report.checkName(problems, location, id, { what: 'Vertex id', carried: true });
  if (RESERVED_VERTICES.includes(id))
    report.error(problems, location, `Vertex id ${JSON.stringify(id)} is reserved: an end name, cleanup or done`);
  if (!refs.isRecord(vertex)) return report.error(problems, location, 'a Vertex must be an object');
  report.unknownKeys(problems, vertex, [...VERTEX_KEYS, ...AGENT_KEYS], location);
  checkAccess(problems, `${location}.access`, vertex.access);
  const proc = report.has(checking.procedures, vertex.procedure) ? checking.procedures[vertex.procedure] : undefined;
  if (!report.has(checking.config.procedures, vertex.procedure))
    report.error(problems, location, `procedure ${JSON.stringify(vertex.procedure)} is not declared`);
  if (proc) state.used.add(proc.name);
  if (checking.failedAgents.has(vertex.use)) state.held = true;
  const agent = vertexAgent(checking, { id, location }, vertex, proc);
  const typed = inputs.checkInputs(problems, location, vertex.inputs, state.sources);
  checkVertexRoutes(problems, location, vertex, state.vertices);
  const falls = proc ? vertexFalls(checking, location, typed, proc) : {};
  state.resolved[id] = resolveVertex(vertex, { agent, inputs: typed.inputs, falls }, proc);
  state.procs[id] = proc;
  state.fallsOf[id] = falls;
}

// Each Procedure a Vertex uses, as declared and hashed, so a resumed Visit can tell it has changed (S6).
function usedProcedures(checking: Checking, used: Set<string>) {
  return Object.fromEntries(
    [...used].map((name) => {
      const proc = checking.procedures[name] as checked.CheckedProcedure;
      const { actions, claimTokens, tests, access, recover, tables, otherwise, checkIds } = proc;
      const hash = config.hashOf((checking.config.procedures as Value)[name]);
      const resolved = { actions, claimTokens, tests, access, recover, ...tables, otherwise: otherwise ?? null };
      return [name, { ...resolved, checks: checkIds, hash }];
    }),
  );
}

// Checks one declared Flow and gives its Resolved Flow, or reports that it is not an object.
export function checkFlow(checking: Checking, name: string, declaration: unknown) {
  const location = `flows.${name}`;
  const problems = checking.report;
  const start = problems.errors.length;
  report.checkName(problems, location, name, { what: 'Flow', carried: false });
  if (!refs.isRecord(declaration)) {
    report.error(problems, location, 'a Flow must be an object');
    return undefined;
  }
  const { ticket, vertices } = checkFlowKeys(problems, location, declaration);
  const state: FlowState = {
    location,
    vertices,
    sources: inputs.sourceScope(checking.procedures, vertices),
    resolved: {},
    used: new Set(),
    procs: {},
    fallsOf: {},
    held: false,
  };
  for (const [id, vertex] of Object.entries(vertices)) checkVertex(checking, state, id, vertex);
  const clean = checking.sharedErrors === 0 && problems.errors.length === start && !state.held;
  const { resolved, procs, fallsOf } = state;
  graph.checkGraph(problems, { location, ticket, resolved, procs, fallsOf, clean });
  return {
    name,
    plan: declaration.plan ?? null,
    actionCap: declaration.actionCap ?? null,
    procedures: usedProcedures(checking, state.used),
    ticket: { entry: ticket.entry ?? null, routes: ticket.routes ?? {}, vertices: resolved },
  };
}
