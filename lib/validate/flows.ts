// A Flow as declared, checked against the checked Procedures: its keys, routes and Vertices and each Vertex's Agent,
// each value it copies typed by the check that judges it (#391). A Vertex's inputs are inputs.ts's, its routes
// routes.ts's, the graph checks graph.ts's.

import * as labels from '../labels.ts';
import type * as model from '../model.ts';
import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import * as actionChecks from './actions.ts';
import * as agentChecks from './agents.ts';
import * as graph from './graph.ts';
import * as inputs from './inputs.ts';
import * as checked from './procedures.ts';
import * as references from './references.ts';
import * as report from './report.ts';
import * as declaredFlows from './declared.ts';
import * as routes from './routes.ts';
import * as templates from './templates.ts';

// The keys each object of a gg.json may declare; any other is an unknown key (the request tables them). A Vertex
// also takes any Agent key, overriding its Agent's.
export const VERTEX_KEYS = ['use', 'procedure', 'inputs', 'route', 'max', 'exhausted'];
export const FLOW_KEYS = ['actionCap', 'ticket'];
export const TICKET_KEYS = ['entry', 'routes', 'vertices'];
// `cleanup` is the Pending cleanup hold's Await Label (L11) and `done` the human-only end (L12).
const RESERVED_VERTICES: string[] = [...labels.END_STATES, 'cleanup', 'done'];

type Value = Record<string, unknown>;
type Reported = report.Reported;
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
  agents: Map<string, agentChecks.CheckedAgent>;
  harnesses: unknown;
  reader: templates.TemplateReader | null;
  // The errors outside every Flow, which hold every Flow's graph checks (H6).
  sharedErrors: number;
}
// A Vertex's values the Resolved Flow carries, each as its check typed it, or Reported where it reported.
export interface TypedVertex {
  use: string | null | Reported;
  agent: model.Agent | null | Reported;
  procedure: string | Reported;
  access: string | Reported;
  route: Record<string, model.RouteTarget> | Reported;
  max: number | null | Reported;
  exhausted: model.Target | null | Reported;
}
// The Flow's own values the Resolved Flow carries, typed the same way.
export interface TypedFlow {
  actionCap: number | Reported;
  entry: string | Reported;
  routes: Record<string, model.RouteTarget> | Reported;
}
// The Flow's Vertices as they are checked, and what the graph checks read of them.
interface FlowState {
  name: string;
  location: string;
  vertices: Value;
  sources: referencePaths.SchemaNode;
  resolved: Map<string, model.DeclaredVertexJson>;
  typed: Map<string, TypedVertex>;
  used: Map<string, checked.CheckedProcedure>;
  // Each Vertex's Persona, in Vertex order, for the files the Flow uses.
  personas: string[];
  procs: Map<string, checked.CheckedProcedure | undefined>;
  fallsOf: Map<string, FallThroughs>;
  held: boolean;
}

// The Flow's own keys, its ticket section and its routes; the ticket and its Vertices, whatever their shape.
function checkFlowKeys(problems: report.Report, location: string, declaration: Value) {
  report.unknownKeys(problems, declaration, FLOW_KEYS, location);
  const message = 'actionCap must be a positive integer';
  const actionCap = report.isCount(declaration.actionCap)
    ? declaration.actionCap
    : report.errorOf(
        problems,
        `${location}.actionCap`,
        report.absentOr(declaration.actionCap, 'actionCap', 'not-a-positive-integer', message),
      );
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
    const atVertices = `${atTicket}.vertices`;
    const finding = report.absentOr(ticket.vertices, 'vertices', code, 'vertices must be a non-empty object');
    report.errorOf(problems, atVertices, finding);
  }
  const entry = checkEntry(problems, `${atTicket}.entry`, ticket.entry, vertices);
  const notAnObject =
    ticket.routes !== undefined && !referencePaths.isRecord(ticket.routes)
      ? report.error(problems, `${atTicket}.routes`, 'not-an-object', 'routes must be an object from Outcome to target')
      : undefined;
  const flowRoutes = routes.checkRoutes(problems, `${atTicket}.routes`, ticket.routes, vertices);
  const typed: TypedFlow = { actionCap, entry, routes: notAnObject ?? flowRoutes };
  return { ticket, vertices, typed };
}

function checkEntry(problems: report.Report, location: string, entry: unknown, vertices: Value) {
  if (entry === undefined)
    return report.error(problems, location, 'required-key-missing', 'a ticket must name its entry Vertex', {
      key: 'entry',
    });
  if (typeof entry !== 'string' || !Object.hasOwn(vertices, entry))
    return routes.unknownVertex(problems, location, entry);
  return entry;
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

// The Procedure a Vertex names, by name.
function checkProcedureName(checking: FlowContext, location: string, procedure: unknown): string | Reported {
  if (procedure === undefined)
    return report.error(checking.report, location, 'required-key-missing', 'a Vertex must name a procedure', {
      key: 'procedure',
    });
  if (report.hasOwnKey(checking.config.procedures, procedure)) return procedure;
  return report.error(
    checking.report,
    location,
    'undeclared-procedure',
    `procedure ${JSON.stringify(procedure)} is not declared`,
    { procedure },
  );
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
  report.unknownKeys(problems, vertex, [...VERTEX_KEYS, ...agentChecks.AGENT_KEYS], location);
  const ownAccess = agentChecks.checkAccess(problems, `${location}.access`, vertex.access);
  const proc = checking.procedures.get(vertex.procedure as string);
  const procedure = checkProcedureName(checking, location, vertex.procedure);
  if (proc && !state.used.has(proc.name)) state.used.set(proc.name, proc);
  if (checking.failedAgents.has(vertex.use)) state.held = true;
  const use = agentChecks.checkUse(checking, location, vertex.use);
  const agent = agentChecks.vertexAgent(checking, { id, location }, vertex, { use, access: ownAccess, proc });
  state.personas.push(...procedures.filesAt('agent', agent.declared));
  const typed = inputs.checkInputs(problems, location, vertex.inputs, state.sources);
  const bound = routes.checkVertexRoutes(problems, location, vertex, state.vertices);
  const falls = proc ? vertexFalls(checking, { flow: state.name, id }, typed, proc) : {};
  const prefix = checking.labelPrefix === undefined ? undefined : report.shown(checking.labelPrefix);
  const approvalLabels = actionChecks.approvalLabelsOf(proc?.actions, id, prefix);
  const resolved = { agent: agent.declared, inputs: typed.inputs, falls, approvalLabels };
  state.resolved.set(id, declaredFlows.declaredVertex(vertex, resolved, proc));
  const access = proc?.access === 'read-only' ? 'read-only' : (agent.access ?? 'read-only');
  state.typed.set(id, { use, agent: agent.typed, procedure, access, ...bound });
  state.procs.set(id, proc);
  state.fallsOf.set(id, falls);
}

// Checks one declared Flow and gives it declared, resolved when it can be, and what it uses; or reports that it is
// not an object.
export function checkFlow(checking: FlowContext, name: string, declaration: unknown) {
  const location = `flows.${name}`;
  const problems = checking.report;
  const start = problems.errors.length;
  report.checkName(problems, location, name, { what: 'Flow', carried: false });
  if (!referencePaths.isRecord(declaration)) {
    report.error(problems, location, 'not-an-object', 'a Flow must be an object');
    return undefined;
  }
  const { ticket, vertices, typed } = checkFlowKeys(problems, location, declaration);
  const state: FlowState = {
    name,
    location,
    vertices,
    sources: inputs.sourceScope(checking.procedures, vertices),
    resolved: new Map(),
    typed: new Map(),
    used: new Map(),
    personas: [],
    procs: new Map(),
    fallsOf: new Map(),
    held: false,
  };
  for (const [id, vertex] of Object.entries(vertices)) checkVertex(checking, state, id, vertex);
  const clean = checking.sharedErrors === 0 && problems.errors.length === start && !state.held;
  const { resolved, procs, fallsOf } = state;
  graph.checkGraph(problems, { location, ticket, resolved, procs, fallsOf, clean });
  const { used, personas } = state;
  const declaredProcedures = checking.config.procedures;
  return declaredFlows.checkedFlow(name, declaration, {
    ticket,
    vertices: resolved,
    used: [...used.values()],
    personas,
    declaredProcedures,
    typed: { ...typed, vertices: state.typed },
  });
}
