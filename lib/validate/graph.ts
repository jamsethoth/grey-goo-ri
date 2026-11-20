// The graph checks: routing (R12b, R12c, H7), bounds (I3, V3), commits (S2, T1c); what a route guarantees is
// route-facts.ts's (R11e, Q7, H1-H5).
// The graph checks receive only values whose checks held: lib/validate/flows.ts leaves out each refused route, bound
// and entry, so each check iterates what it is given and skips nothing itself (#459). A check of one Vertex reads that
// Vertex, the route map its mapped Vertices, what a route guarantees also the entry. `routing` is filled in for every
// Vertex with a Procedure, for gg doctor (H6; #436, D3 C; #449; #454).

import * as flow from '../flow.ts';
import type * as labels from '../labels.ts';
import type * as model from '../model.ts';
import type * as procedures from '../procedures.ts';
import * as declaredFlows from './declared.ts';
import * as checked from './procedures.ts';
import * as report from './report.ts';
import * as routeFacts from './route-facts.ts';

type FallThroughs = checked.FallThroughs;
type OutcomeCase = checked.OutcomeCase;
// A Vertex's bound as typed.
export type Bounds = Map<string, { max: number | null; exhausted: model.Target | null }>;
// A whole Vertex, whose Outcome list nothing refused, with its Procedure and the Outcomes checked for a route: none
// while the Flow's routes are not an object (#436, D3 C; #449, Q1 A).
export interface WholeVertex {
  vertex: model.DeclaredVertexJson;
  procedure: checked.HeldProcedure;
  actions: procedures.Action[];
  outcomes: string[];
}
// The Flow the graph checks read; a value its check refused is absent.
export interface Graph {
  location: string;
  ticket: Record<string, unknown>;
  resolved: Map<string, model.DeclaredVertexJson>;
  vertexProcedures: Map<string, checked.HeldProcedure | undefined>;
  fallsOf: Map<string, FallThroughs>;
  // Each Vertex's routes and bound, and the Flow's routes, where their checks typed them.
  vertexRoutes: Map<string, Record<string, model.RouteTarget>>;
  bounds: Bounds;
  flowRoutes?: Record<string, model.RouteTarget>;
  // An unrouted Outcome or a commit of a whole Vertex is reported while other errors stand (#436, D3 C; #449, Q1 A).
  whole: Map<string, WholeVertex>;
  // The bound of each Vertex the route map reads, each whole with its route targets typed; the Vertices the warnings
  // read, the map's only when it reads every Vertex (#449, Q2 A); the entry, where typed.
  mapped: Bounds;
  warned: Map<string, model.DeclaredVertexJson>;
  entry?: string;
}
// Where a route lands: a Vertex or an end, and whether only an exhausted Bound leads there.
interface Landing {
  vertex?: string;
  end?: labels.EndState;
  exhausted: boolean;
}
export interface Edge {
  from: string;
  outcome: string;
  target: model.RouteTarget | null;
  landings: Landing[];
  bounded: model.Target | null;
  cases: OutcomeCase[];
  write: boolean;
}

// The strongly connected components of `next` that hold a cycle, each in declaration order (Tarjan).
function cycles(next: Map<string, string[]>) {
  const ids = [...next.keys()];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (vertex: string) => {
    index.set(vertex, index.size);
    low.set(vertex, index.get(vertex) as number);
    stack.push(vertex);
    for (const successor of next.get(vertex) as string[]) {
      if (!index.has(successor)) {
        visit(successor);
        low.set(vertex, Math.min(low.get(vertex) as number, low.get(successor) as number));
      } else if (stack.includes(successor))
        low.set(vertex, Math.min(low.get(vertex) as number, index.get(successor) as number));
    }
    if (low.get(vertex) !== index.get(vertex)) return;
    const component = stack.splice(stack.indexOf(vertex));
    if (component.length > 1 || next.get(vertex)?.includes(vertex))
      found.push(ids.filter((id) => component.includes(id)));
  };
  for (const vertex of ids) if (!index.has(vertex)) visit(vertex);
  return found;
}

// A route lands on its Vertex, and on every exhausted target its edge's max or a Vertex's max can reach (H2, U5).
// `exhausted` marks a landing that no edge max bounds. A Vertex `bounds` lacks, or a target the routes lack, gives
// `absent`: the route map drops it and keeps the edge's other landings (#449), the work walk gives null, unknown work.
interface Walk<Absent> {
  exhausted: boolean;
  seen: string[];
  absent: Absent;
}
function landingsOf<Absent extends [] | null>(
  bounds: Bounds,
  target: model.RouteTarget | null,
  walk: Walk<Absent>,
): Landing[] | Absent {
  const { exhausted, seen } = walk;
  if (target === null) return walk.absent;
  if (typeof target !== 'string' && 'to' in target) {
    const to = landingsOf(bounds, target.to, walk);
    const past =
      target.max === undefined
        ? []
        : landingsOf(bounds, target.exhausted ?? flow.NEEDS_HUMAN_ROUTE, { ...walk, exhausted: true });
    return to === null || past === null ? walk.absent : [...to, ...past];
  }
  if (typeof target !== 'string') return [{ end: target.end, exhausted }];
  if (seen.includes(target)) return [];
  const vertex = bounds.get(target);
  if (!vertex) return walk.absent;
  const next = vertex.exhausted ?? flow.NEEDS_HUMAN_ROUTE;
  const past =
    vertex.max === null ? [] : landingsOf(bounds, next, { ...walk, exhausted: true, seen: [...seen, target] });
  return past === null ? walk.absent : [{ vertex: target, exhausted }, ...past];
}

// The typed target an Outcome of Vertex `id` routes to, or null while the routes it is read from are refused.
function typedTarget(graph: Graph, id: string, name: string) {
  const vertexRoutes = graph.vertexRoutes.get(id);
  if (vertexRoutes === undefined || graph.flowRoutes === undefined) return null;
  return flow.typedRoute(vertexRoutes, graph.flowRoutes, name)?.target ?? null;
}

// Where a failure's work goes when a writing Vertex's Outcome routes on: unknown while the routes it is read from, or a
// bound it passes, are refused.
function workOf(write: boolean, cases: OutcomeCase[], landings: Landing[] | null) {
  if (landings === null || !write || cases.every((ending) => ending.table === 'passed')) return null;
  const rescued = landings.some((landing) => landing.vertex);
  const left = landings.some((landing) => landing.end);
  if (rescued && left) return 'rescued, or left in place once exhausted';
  return rescued ? 'rescued' : 'left in place';
}

// A writing Vertex commits on every passing path, under a Claim token that requires a Check.
function checkWrites(fail: (where: string, finding: report.Finding) => void, id: string, whole: WholeVertex) {
  const { procedure, actions } = whole;
  if (!procedure.tokens.passed.length) return;
  if (!actions.some((action) => action.do === 'commit')) {
    fail(id, {
      code: 'write-without-commit',
      message:
        `Vertex ${id} writes, so it must commit on every passing path, ` +
        `but procedure ${procedure.name} has no commit Action`,
      params: { vertex: id, procedure: procedure.name },
    });
  }
  for (const token of procedure.tokens.passed) {
    if (!procedure.claimTokens[token].requires?.length)
      fail(id, {
        code: 'commit-without-check',
        message: `Vertex ${id} writes, so its committing Claim token ${token} must require a Check`,
        params: { vertex: id, token },
      });
  }
}

// Each whole Vertex's commits and unrouted Outcomes.
function checkWhole(problems: report.Report, graph: Graph) {
  const fail = (id: string, finding: report.Finding) =>
    report.errorOf(problems, `${graph.location}.ticket.vertices.${id}`, finding);
  for (const [id, whole] of graph.whole) {
    const { vertex, outcomes } = whole;
    if (vertex.access !== 'read-only') checkWrites(fail, id, whole);
    for (const name of outcomes)
      if (!flow.route(vertex.route, graph.ticket.routes, name))
        fail(id, {
          code: 'unrouted-outcome',
          message: `Outcome ${name} is not routed by the Vertex or the Flow's routes`,
          params: { outcome: name },
        });
  }
}

// Each Vertex's Outcomes routed, the routing filled in for doctor, and the edges they take.
function routeEdges(graph: Graph) {
  const { resolved, ticket } = graph;
  const edges: Omit<Edge, 'landings'>[] = [];
  for (const [id, vertex] of resolved) {
    const procedure = graph.vertexProcedures.get(id);
    if (!procedure) continue;
    const write = vertex.access !== 'read-only';
    const cases = checked.casesOf(procedure, graph.fallsOf.get(id) as FallThroughs);
    for (const name of vertex.outcomes) {
      const route = flow.route(vertex.route, ticket.routes, name);
      if (!route) continue;
      const target = typedTarget(graph, id, name);
      const landings = landingsOf(graph.bounds, target, { exhausted: false, seen: [], absent: null });
      const mine = cases.filter((ending) => ending.outcome === name);
      // An own key, so an Outcome such as __proto__ or toString is data.
      Object.defineProperty(vertex.routing, name, {
        value: {
          target: declaredFlows.declaredValue(route.target) ?? null,
          by: route.by,
          work: workOf(write, mine, landings),
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const bounded = target !== null && typeof target !== 'string' && 'to' in target && target.max !== undefined;
      edges.push({ from: id, outcome: name, target, bounded: bounded ? target.to : null, cases: mine, write });
    }
  }
  return edges;
}

// A cycle needs an edge or Vertex with max; the Action Cap does not bound one.
function checkCycles(problems: report.Report, location: string, bounds: Bounds, edges: Edge[]) {
  const bounded = (id: string) => typeof bounds.get(id)?.max === 'number';
  const next = new Map<string, string[]>([...bounds.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    for (const landing of edge.landings) {
      const { vertex } = landing;
      if (!vertex || !bounds.has(vertex) || bounded(edge.from) || bounded(vertex)) continue;
      if (vertex !== edge.bounded || landing.exhausted) next.get(edge.from)?.push(vertex);
    }
  }
  for (const cycle of cycles(next)) {
    report.error(
      problems,
      `${location}.ticket`,
      'unbounded-cycle',
      `the cycle through ${cycle.join(', ')} has no edge or Vertex with max; the Action Cap does not bound a cycle`,
      { cycle },
    );
  }
}

// Once every Vertex of such a loop is spent, an entry passes from exhausted target to exhausted target forever (H12).
function checkExhaustedLoops(problems: report.Report, location: string, bounds: Bounds) {
  const ids = [...bounds.keys()];
  const loops = new Map<string, string[]>();
  for (const id of ids) {
    const chain: model.Target[] = [];
    let current: model.Target | null = id;
    for (
      let vertex = bounds.get(id);
      vertex && vertex.max !== null && current !== null && !chain.includes(current);
      vertex = typeof current === 'string' ? bounds.get(current) : undefined
    ) {
      chain.push(current);
      current = vertex.exhausted;
    }
    if (current === null || !chain.includes(current)) continue;
    const loop = chain.slice(chain.indexOf(current));
    const members = ids.filter((member) => loop.includes(member));
    loops.set(JSON.stringify(members), members);
  }
  for (const members of loops.values()) {
    report.error(
      problems,
      `${location}.ticket`,
      'exhausted-loop',
      `the exhausted targets of ${members.join(', ')} form a loop: ` +
        'once their Visits reach max, no Vertex is ever entered',
      { loop: members },
    );
  }
}

// A Vertex the map does not read leaves it with its edges: they can only add a cycle or a route, so an error found on
// the rest is real, but the warnings, which a missing route makes falsely, wait (#449, Q2 A).
export function checkGraph(problems: report.Report, graph: Graph) {
  checkWhole(problems, graph);
  const mapEdges = routeEdges(graph)
    .filter((edge) => graph.mapped.has(edge.from))
    .map((edge) => ({
      ...edge,
      landings: landingsOf(graph.mapped, edge.target, { exhausted: false, seen: [], absent: [] }),
    }));
  checkCycles(problems, graph.location, graph.mapped, mapEdges);
  checkExhaustedLoops(problems, graph.location, graph.mapped);
  if (graph.entry === undefined) return;
  const resolved = new Map([...graph.resolved].filter(([id]) => graph.mapped.has(id)));
  routeFacts.checkFacts(problems, { ...graph, entry: graph.entry, resolved }, mapEdges);
}
