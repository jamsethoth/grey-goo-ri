// A Flow as declared, checked against the checked Procedures: its keys, routes and Vertices and each Vertex's Agent,
// giving the Resolved Flow. A Vertex's inputs are inputs.ts's, the graph checks graph.ts's.

import * as config from '../config.ts';
import * as flow from '../flow.ts';
import * as labels from '../labels.ts';
import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import * as actionChecks from './actions.ts';
import * as graph from './graph.ts';
import * as inputs from './inputs.ts';
import * as checked from './procedures.ts';
import * as references from './references.ts';
import * as report from './report.ts';
import * as templates from './templates.ts';

// The keys each object of a gg.json may declare; any other is an unknown key (the request tables them).
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
export const FLOW_KEYS = ['actionCap', 'ticket'];
export const TICKET_KEYS = ['entry', 'routes', 'vertices'];
// A route target is a Vertex id, { end }, or this edge form.
export const EDGE_KEYS = ['to', 'max', 'exhausted'];
// `cleanup` is the Pending cleanup hold's Await Label (L11) and `done` the human-only end (L12).
const RESERVED_VERTICES: string[] = [...labels.END_STATES, 'cleanup', 'done'];
// What an Agent asks for (Permission Intents). Integrity treats any access but read-only as a write, so a typo such as
// read-write would run as workspace-write.
const PERMISSION_INTENTS = ['read-only', 'workspace-write'];

type Value = Record<string, unknown>;
type FallThroughs = checked.FallThroughs;
// What checking a Flow reads beyond the Flow itself.
export interface FlowContext {
  report: report.Report;
  config: Value;
  // The repository's label prefix, which an approval Vertex's Await and Decide Labels carry.
  labelPrefix: unknown;
  procedures: Map<string, checked.CheckedProcedure | undefined>;
  procedureFalls: Map<string, FallThroughs>;
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
  name: string;
  location: string;
  vertices: Value;
  sources: referencePaths.SchemaNode;
  resolved: Map<string, graph.ResolvedVertex>;
  used: Set<string>;
  procs: Map<string, checked.CheckedProcedure | undefined>;
  fallsOf: Map<string, FallThroughs>;
  held: boolean;
}

export function checkAccess(problems: report.Report, location: string, access: unknown) {
  if (access !== undefined && !PERMISSION_INTENTS.includes(access as string)) {
    const intents = PERMISSION_INTENTS.join(' or ');
    report.error(
      problems,
      location,
      'unknown-permission-intent',
      `access ${JSON.stringify(access)} is not a Permission Intent: ${intents}`,
      { access },
    );
  }
}

// `owner` is a declared Agent, by name, or the Vertex whose own Agent keys set the harness.
export function checkHarness(
  checking: Pick<FlowContext, 'report' | 'harnesses'>,
  owner: { agent: string } | { vertex: string },
  harness: unknown,
  location: string,
) {
  const problems = checking.report;
  const label = 'agent' in owner ? `agent ${owner.agent}` : `the agent of Vertex ${owner.vertex}`;
  // Only a missing harness is unset; a null one is a null-value where it sits, and no name to look up.
  if (harness === undefined)
    report.error(
      problems,
      location,
      'harness-unset',
      `${label} names no harness; set one in the gg.json that declares it`,
      owner,
    );
  else if (!report.checkName(problems, location, harness, { what: `${label}'s harness`, carried: false })) return;
  else if (!report.hasOwnKey(checking.harnesses, harness))
    report.error(
      problems,
      location,
      'harness-unregistered',
      `${label} names harness ${JSON.stringify(harness)}, which is not registered`,
      { ...owner, harness },
    );
}

const unknownVertex = (problems: report.Report, location: string, vertex: unknown) =>
  report.error(problems, location, 'unknown-vertex', `${JSON.stringify(vertex)} is not a Vertex`, { vertex });

function checkTarget(problems: report.Report, location: string, target: unknown, vertices: Value) {
  if (typeof target === 'string') {
    if (!Object.hasOwn(vertices, target)) unknownVertex(problems, location, target);
  } else if (referencePaths.isRecord(target) && Object.hasOwn(target, 'end') && Object.keys(target).length === 1) {
    if (target.end === 'done')
      report.error(problems, location, 'human-only-end', 'end "done" is the human-only end, which no route may name');
    else if (!flow.isEnd(target.end))
      report.error(
        problems,
        location,
        'unknown-end',
        `end ${JSON.stringify(target.end)} is not one of ${labels.END_STATES.join(', ')}`,
        { end: target.end },
      );
  } else {
    report.error(
      problems,
      location,
      'malformed-route-target',
      'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }',
    );
  }
}

// A route's target may also be an edge, which bounds its traversals.
function checkRouteTarget(problems: report.Report, location: string, target: unknown, vertices: Value) {
  if (!(referencePaths.isRecord(target) && Object.hasOwn(target, 'to')))
    return checkTarget(problems, location, target, vertices);
  report.unknownKeys(problems, target, EDGE_KEYS, location);
  checkTarget(problems, location, target.to, vertices);
  if (target.max !== undefined && !report.isCount(target.max))
    report.error(problems, location, 'not-a-positive-integer', 'max must be a positive integer');
  if (target.max !== undefined && target.exhausted === undefined)
    report.error(problems, location, 'max-without-exhausted', 'an edge with max names its exhausted target');
  if (target.max === undefined && target.exhausted !== undefined)
    report.error(problems, location, 'exhausted-without-max', 'an edge names exhausted only with max');
  if (target.exhausted !== undefined) checkTarget(problems, location, target.exhausted, vertices);
}

// The Flow's own keys, its ticket section and its routes; the ticket and its Vertices, whatever their shape.
function checkFlowKeys(problems: report.Report, location: string, declaration: Value) {
  report.unknownKeys(problems, declaration, FLOW_KEYS, location);
  if (!report.isCount(declaration.actionCap)) {
    const message = 'actionCap must be a positive integer';
    const finding = report.absentOr(declaration.actionCap, 'actionCap', 'not-a-positive-integer', message);
    report.errorOf(problems, `${location}.actionCap`, finding);
  }
  const atTicket = `${location}.ticket`;
  const ticket = referencePaths.isRecord(declaration.ticket) ? declaration.ticket : {};
  if (!referencePaths.isRecord(declaration.ticket)) {
    const finding = report.absentOr(declaration.ticket, 'ticket', 'not-an-object', 'ticket must be an object');
    report.errorOf(problems, atTicket, finding);
  }
  report.unknownKeys(problems, ticket, TICKET_KEYS, atTicket);
  const vertices = referencePaths.isRecord(ticket.vertices) ? ticket.vertices : {};
  if (!Object.keys(vertices).length) {
    const code = referencePaths.isRecord(ticket.vertices) ? 'no-vertex-declared' : 'not-an-object';
    const message = 'vertices must be a non-empty object';
    report.errorOf(problems, `${atTicket}.vertices`, report.absentOr(ticket.vertices, 'vertices', code, message));
  }
  const atEntry = `${atTicket}.entry`;
  if (ticket.entry === undefined)
    report.error(problems, atEntry, 'required-key-missing', 'a ticket must name its entry Vertex', { key: 'entry' });
  else if (typeof ticket.entry !== 'string' || !Object.hasOwn(vertices, ticket.entry))
    unknownVertex(problems, atEntry, ticket.entry);
  if (ticket.routes !== undefined && !referencePaths.isRecord(ticket.routes))
    report.error(problems, `${atTicket}.routes`, 'not-an-object', 'routes must be an object from Outcome to target');
  for (const [outcome, target] of report.entries(ticket.routes))
    checkRouteTarget(problems, `${atTicket}.routes.${outcome}`, target, vertices);
  return { ticket, vertices };
}

// A Vertex names an Agent that is not declared, or gives one to a Procedure with no agent Action.
function refusesAgent(
  checking: FlowContext,
  given: { vertex: Value; overrides: Value; location: string },
  proc?: checked.CheckedProcedure,
) {
  const { vertex, overrides, location } = given;
  if (vertex.use !== undefined && !report.hasOwnKey(checking.config.agents, vertex.use)) {
    report.error(
      checking.report,
      location,
      'undeclared-agent',
      `uses agent ${JSON.stringify(vertex.use)}, which is not declared`,
      { agent: vertex.use },
    );
    return true;
  }
  if (proc && !proc.agent && (vertex.use !== undefined || Object.keys(overrides).length)) {
    const message = `procedure ${proc.name} has no agent Action, so the Vertex takes no Agent`;
    report.error(checking.report, location, 'vertex-takes-no-agent', message, { procedure: proc.name });
    return true;
  }
  return false;
}

// The Agent a Vertex runs, the declared Agent under the Vertex's own Agent keys, or null when it takes none.
function vertexAgent(
  checking: FlowContext,
  place: VertexPlace,
  vertex: Value,
  proc?: checked.CheckedProcedure,
): Value | null {
  const problems = checking.report;
  const { location } = place;
  const agents = checking.config.agents;
  const overrides = Object.fromEntries(Object.entries(vertex).filter(([key]) => AGENT_KEYS.includes(key)));
  if (refusesAgent(checking, { vertex, overrides, location }, proc)) return null;
  const declared = vertex.use === undefined ? {} : new Map(report.entries(agents)).get(vertex.use as string);
  // A declared Agent that is not an object, or names an unregistered harness, is reported at agents.<name>.
  if (!proc?.agent || !referencePaths.isRecord(declared)) return null;
  const merged: Value = { ...declared, ...overrides };
  if (vertex.use === undefined && !Object.keys(merged).length) {
    const message = `procedure ${proc.name} has an agent Action, so the Vertex needs an Agent`;
    report.error(problems, location, 'vertex-needs-agent', message, { procedure: proc.name });
    return null;
  }
  // A harness the Vertex does not set itself is the Agent's, checked at agents.<name>.
  if (vertex.use === undefined || Object.hasOwn(overrides, 'harness')) {
    const owner = vertex.use === undefined ? { vertex: place.id } : { agent: vertex.use as string };
    checkHarness(checking, owner, merged.harness, location);
  }
  return { ...merged, harness: merged.harness ?? null, model: merged.model ?? null, effort: merged.effort ?? null };
}

function checkVertexRoutes(problems: report.Report, location: string, vertex: Value, vertices: Value) {
  for (const [outcome, target] of report.entries(vertex.route))
    checkRouteTarget(problems, `${location}.route.${outcome}`, target, vertices);
  if (vertex.route !== undefined && !referencePaths.isRecord(vertex.route))
    report.error(problems, `${location}.route`, 'not-an-object', 'route must be an object from Outcome to target');
  if (vertex.max !== undefined && !report.isCount(vertex.max))
    report.error(problems, `${location}.max`, 'not-a-positive-integer', 'max must be a positive integer');
  if (vertex.max !== undefined && vertex.exhausted === undefined)
    report.error(problems, location, 'max-without-exhausted', 'a Vertex with max names its exhausted target');
  if (vertex.max === undefined && vertex.exhausted !== undefined)
    report.error(problems, location, 'exhausted-without-max', 'a Vertex names exhausted only with max');
  if (vertex.exhausted !== undefined) checkTarget(problems, `${location}.exhausted`, vertex.exhausted, vertices);
}

// The Procedure's references and templates typed in the Vertex's scope, each problem at the Procedure's own path and
// naming the Vertex; the tokens some input falls through each table for, alone or here.
function vertexFalls(
  checking: FlowContext,
  vertex: references.VertexPlace,
  typed: inputs.TypedInputs,
  proc: checked.CheckedProcedure,
) {
  const declaredInputs = new Map(Object.entries(typed.inputs));
  const falls = {
    ...(checking.procedureFalls.get(proc.name) ?? {}),
    ...references.checkReferences(checking.report, proc, {
      inputs: procedures.object(typed.nodes),
      optional: (input) => declaredInputs.get(input)?.optional === true,
      vertex,
    }),
  };
  for (const { where, ...found } of templates.templateReferences(proc, procedures.object(typed.nodes), checking.reader))
    report.errorOf(checking.report, `${proc.location}.${where}`, references.atVertex(found as report.Finding, vertex));
  return falls;
}

// A Vertex as the Resolved Flow carries it. A Procedure's read-only caps its Agent's access.
function resolveVertex(
  vertex: Value,
  resolved: Pick<graph.ResolvedVertex, 'agent' | 'inputs' | 'approvalLabels'> & { falls: FallThroughs },
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
    approvalLabels: resolved.approvalLabels,
    routing: {},
    inputs: resolved.inputs,
    route: vertex.route ?? {},
    max: vertex.max ?? null,
    exhausted: vertex.exhausted ?? null,
  };
}

function checkVertex(checking: FlowContext, state: FlowState, id: string, vertex: unknown) {
  const problems = checking.report;
  const location = `${state.location}.ticket.vertices.${id}`;
  report.checkName(problems, location, id, { what: 'Vertex id', carried: true });
  if (RESERVED_VERTICES.includes(id))
    report.error(
      problems,
      location,
      'reserved-name',
      `Vertex id ${JSON.stringify(id)} is reserved: an end name, cleanup or done`,
      { name: id },
    );
  if (!referencePaths.isRecord(vertex))
    return report.error(problems, location, 'not-an-object', 'a Vertex must be an object');
  report.unknownKeys(problems, vertex, [...VERTEX_KEYS, ...AGENT_KEYS], location);
  checkAccess(problems, `${location}.access`, vertex.access);
  const proc = checking.procedures.get(vertex.procedure as string);
  if (vertex.procedure === undefined)
    report.error(problems, location, 'required-key-missing', 'a Vertex must name a procedure', { key: 'procedure' });
  else if (!report.hasOwnKey(checking.config.procedures, vertex.procedure))
    report.error(
      problems,
      location,
      'undeclared-procedure',
      `procedure ${JSON.stringify(vertex.procedure)} is not declared`,
      { procedure: vertex.procedure },
    );
  if (proc) state.used.add(proc.name);
  if (checking.failedAgents.has(vertex.use)) state.held = true;
  const agent = vertexAgent(checking, { id, location }, vertex, proc);
  const typed = inputs.checkInputs(problems, location, vertex.inputs, state.sources);
  checkVertexRoutes(problems, location, vertex, state.vertices);
  const falls = proc ? vertexFalls(checking, { flow: state.name, id }, typed, proc) : {};
  const approvalLabels = actionChecks.approvalLabelsOf(proc?.actions, id, checking.labelPrefix as string | undefined);
  state.resolved.set(id, resolveVertex(vertex, { agent, inputs: typed.inputs, falls, approvalLabels }, proc));
  state.procs.set(id, proc);
  state.fallsOf.set(id, falls);
}

// Each Procedure a Vertex uses, as declared and hashed, so a resumed Visit can tell it has changed (S6).
function usedProcedures(checking: FlowContext, used: Set<string>) {
  const declared = new Map(report.entries(checking.config.procedures));
  return Object.fromEntries(
    [...used].map((name) => {
      const proc = checking.procedures.get(name) as checked.CheckedProcedure;
      const { actions, claimTokens, tests, access, recover, tables, otherwise, checkIds } = proc;
      const hash = config.hashOf(declared.get(name));
      const resolved = { actions, claimTokens, tests, access, recover, ...tables, otherwise: otherwise ?? null };
      return [name, { ...resolved, checks: checkIds, hash }];
    }),
  );
}

// Checks one declared Flow and gives its Resolved Flow, or reports that it is not an object.
export function checkFlow(checking: FlowContext, name: string, declaration: unknown) {
  const location = `flows.${name}`;
  const problems = checking.report;
  const start = problems.errors.length;
  report.checkName(problems, location, name, { what: 'Flow', carried: false });
  if (!referencePaths.isRecord(declaration)) {
    report.error(problems, location, 'not-an-object', 'a Flow must be an object');
    return undefined;
  }
  const { ticket, vertices } = checkFlowKeys(problems, location, declaration);
  const state: FlowState = {
    name,
    location,
    vertices,
    sources: inputs.sourceScope(checking.procedures, vertices),
    resolved: new Map(),
    used: new Set(),
    procs: new Map(),
    fallsOf: new Map(),
    held: false,
  };
  for (const [id, vertex] of Object.entries(vertices)) checkVertex(checking, state, id, vertex);
  const clean = checking.sharedErrors === 0 && problems.errors.length === start && !state.held;
  const { resolved, procs, fallsOf } = state;
  graph.checkGraph(problems, { location, ticket, resolved, procs, fallsOf, clean });
  return {
    name,
    actionCap: declaration.actionCap ?? null,
    procedures: usedProcedures(checking, state.used),
    ticket: { entry: ticket.entry ?? null, routes: ticket.routes ?? {}, vertices: Object.fromEntries(resolved) },
  };
}
