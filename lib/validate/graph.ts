// The graph checks: routing (R12b, R12c, H7), bounds (I3, V3), commits (S2, T1c); what a route guarantees is
// route-facts.ts's (R11e, Q7, H1-H5).
// The graph reads each route, bound and entry as its check typed it, so each check waits only on the values it reads:
// a check of one Vertex on that Vertex, the route map on its routes and each Vertex it reads, what a route guarantees
// also on the entry. `routing` is filled in either way, for gg doctor (H6; #436, D3 C; #449; #454).

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
type Reported = report.Reported;
// A Vertex's routes and bound as lib/validate/routes.ts typed them, or Reported where it refused one.
export interface TypedRoutes {
  route: Record<string, model.RouteTarget> | Reported;
  max: number | null | Reported;
  exhausted: model.Target | null | Reported;
}
// The Flow the graph checks read.
export interface Graph {
  location: string;
  ticket: Record<string, unknown>;
  resolved: Map<string, model.DeclaredVertexJson>;
  vertexProcedures: Map<string, checked.CheckedProcedure | undefined>;
  fallsOf: Map<string, FallThroughs>;
  // Each Vertex's routes and bound, and the Flow's routes, as typed.
  typed: Map<string, TypedRoutes>;
  routes: Record<string, model.RouteTarget> | Reported;
  // The Vertices whose Outcome lists are whole, and whether the Flow's routes are sound: an unrouted Outcome or a
  // commit of such a Vertex is reported while other errors stand (#436, D3 C; #449, Q1 A).
  whole: Set<string>;
  routesSound: boolean;
  // The Vertices the route map reads, each whole with its route targets typed, and whether they are all the Flow's;
  // the entry as typed (#449).
  mapped: Set<string>;
  complete: boolean;
  entry: string | Reported;
}
// A Vertex's bound as typed: a Vertex whose bound was refused is in no map of these, so nothing lands on it.
type Bounds = Map<string, { max: number | null; exhausted: model.Target | null }>;
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

// The bound of each Vertex in `ids` whose max and exhausted target were typed.
function boundsOf(typed: Map<string, TypedRoutes>, ids: Iterable<string>): Bounds {
  const bounds: Bounds = new Map();
  for (const id of ids) {
    const { max, exhausted } = typed.get(id) ?? {};
    if (max !== undefined && exhausted !== undefined && !report.isReported(max) && !report.isReported(exhausted))
      bounds.set(id, { max, exhausted });
  }
  return bounds;
}

// A route lands on its Vertex, and on every exhausted target its edge's max or a Vertex's max can reach (H2, U5).
// `exhausted` marks a landing that no edge max bounds.
function landingsOf(
  bounds: Bounds,
  target: model.RouteTarget | null,
  exhausted = false,
  seen: string[] = [],
): Landing[] {
  if (target === null) return [];
  if (typeof target !== 'string' && 'to' in target)
    return [
      ...landingsOf(bounds, target.to, exhausted, seen),
      ...(target.max === undefined ? [] : landingsOf(bounds, target.exhausted ?? flow.NEEDS_HUMAN_ROUTE, true, seen)),
    ];
  if (typeof target !== 'string') return [{ end: target.end, exhausted }];
  const vertex = seen.includes(target) ? undefined : bounds.get(target);
  if (!vertex) return [];
  const next = vertex.exhausted ?? flow.NEEDS_HUMAN_ROUTE;
  return [
    { vertex: target, exhausted },
    ...(vertex.max === null ? [] : landingsOf(bounds, next, true, [...seen, target])),
  ];
}

// The typed target an Outcome of Vertex `id` routes to, or null when the routes it is read from were refused.
function typedTarget(graph: Graph, id: string, name: string) {
  const vertexRoutes = graph.typed.get(id)?.route;
  if (vertexRoutes === undefined || report.isReported(vertexRoutes) || report.isReported(graph.routes)) return null;
  return flow.typedRoute(vertexRoutes, graph.routes, name)?.target ?? null;
}

// Where a failure's work goes when a writing Vertex's Outcome routes on.
function workOf(write: boolean, cases: OutcomeCase[], landings: Landing[]) {
  if (!write || cases.every((ending) => ending.table === 'passed')) return null;
  const rescued = landings.some((landing) => landing.vertex);
  const left = landings.some((landing) => landing.end);
  if (rescued && left) return 'rescued, or left in place once exhausted';
  return rescued ? 'rescued' : 'left in place';
}

// A writing Vertex commits on every passing path, under a Claim token that requires a Check. Only a whole Vertex is
// checked, whose Procedure nothing refused, so its Actions are typed.
function checkWrites(
  fail: (where: string, finding: report.Finding) => void,
  id: string,
  procedure: checked.CheckedProcedure,
) {
  if (!procedure.tokens.passed.length) return;
  if (!(procedure.typed.actions as procedures.Action[]).some((action) => action.do === 'commit')) {
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

// Each Vertex's Outcomes routed, the routing filled in for doctor, and the edges they take.
function routeEdges(problems: report.Report, graph: Graph) {
  const { resolved, ticket } = graph;
  const fail = (id: string, finding: report.Finding) => {
    if (graph.whole.has(id)) report.errorOf(problems, `${graph.location}.ticket.vertices.${id}`, finding);
  };
  const bounds = boundsOf(graph.typed, graph.typed.keys());
  const edges: Edge[] = [];
  for (const [id, vertex] of resolved) {
    const procedure = graph.vertexProcedures.get(id);
    if (!procedure) continue;
    const write = vertex.access !== 'read-only';
    if (write && graph.whole.has(id)) checkWrites(fail, id, procedure);
    const cases = checked.casesOf(procedure, graph.fallsOf.get(id) as FallThroughs);
    for (const name of vertex.outcomes) {
      const route = flow.route(vertex.route, ticket.routes, name);
      if (!route) {
        if (graph.routesSound && graph.whole.has(id))
          report.errorOf(problems, `${graph.location}.ticket.vertices.${id}`, {
            code: 'unrouted-outcome',
            message: `Outcome ${name} is not routed by the Vertex or the Flow's routes`,
            params: { outcome: name },
          });
        continue;
      }
      const target = typedTarget(graph, id, name);
      const landings = landingsOf(bounds, target);
      const mine = cases.filter((ending) => ending.outcome === name);
      // An own key, so an Outcome such as __proto__ or toString is data.
      Object.defineProperty(vertex.routing, name, {
        value: {
          target: declaredFlows.declaredValue(route.target) ?? null,
          by: route.by,
          // Where work goes is unknown while the routes it is read from are refused.
          work: target === null ? null : workOf(write, mine, landings),
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const bounded = target !== null && typeof target !== 'string' && 'to' in target && target.max !== undefined;
      edges.push({
        from: id,
        outcome: name,
        target,
        landings,
        bounded: bounded ? target.to : null,
        cases: mine,
        write,
      });
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
  const edges = routeEdges(problems, graph);
  const bounds = boundsOf(graph.typed, graph.mapped);
  // An edge lands only on the Vertices the map reads, so a refused exhausted target adds nothing (#449).
  const mapEdges = edges
    .filter((edge) => graph.mapped.has(edge.from))
    .map((edge) => ({ ...edge, landings: landingsOf(bounds, edge.target) }));
  checkCycles(problems, graph.location, bounds, mapEdges);
  checkExhaustedLoops(problems, graph.location, bounds);
  if (report.isReported(graph.entry)) return;
  const resolved = new Map([...graph.resolved].filter(([id]) => graph.mapped.has(id)));
  routeFacts.checkFacts(problems, { ...graph, entry: graph.entry, resolved }, mapEdges, graph.complete);
}
