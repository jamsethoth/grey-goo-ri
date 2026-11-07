// The graph checks: routing (R12b, R12c, H7), bounds (I3, V3), commits (S2, T1c), and pr-ready before ready-for-qa
// and inputs over the route map (R11e, Q7, H1-H5); unreachable Vertices are warned.
// The graph reads Procedures, routes and inputs as declared, so its checks wait until the Flow is clean: no error
// outside every Flow, and none in this one. Flows share no graph, so another Flow's errors do not hold them. `routing`
// is filled in either way, for gg doctor (H6).

import * as flow from '../flow.ts';
import * as labels from '../labels.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as inputs from './inputs.ts';
import * as checked from './procedures.ts';
import * as report from './report.ts';

const PR_READY = 'pr-ready';

type FallThroughs = checked.FallThroughs;
type OutcomeCase = checked.OutcomeCase;
// Which route an Outcome takes, and where a failure's work goes (R12d, U5).
export interface Routing {
  target: unknown;
  by: flow.RouteSource;
  work: string | null;
}
// A Vertex as the Resolved Flow carries it.
export interface ResolvedVertex {
  use: unknown;
  agent: Record<string, unknown> | null;
  procedure: unknown;
  access: unknown;
  tests: unknown;
  outcomes: string[];
  routing: Record<string, Routing>;
  inputs: Record<string, inputs.ResolvedInput>;
  route: unknown;
  max: unknown;
  exhausted: unknown;
}
// The Flow the graph checks read.
export interface Graph {
  location: string;
  ticket: Record<string, unknown>;
  resolved: Record<string, ResolvedVertex>;
  procs: Record<string, checked.CheckedProcedure | undefined>;
  fallsOf: Record<string, FallThroughs>;
  clean: boolean;
}
// Where a route lands: a Vertex or an end, and whether only an exhausted Bound leads there.
interface Landing {
  vertex?: string;
  end?: labels.EndState;
  exhausted: boolean;
}
interface Edge {
  from: string;
  outcome: string;
  landings: Landing[];
  bounded: unknown;
  cases: OutcomeCase[];
  write: boolean;
}

// The outputs a Visit of Vertex `id` leaves when it ends in `ending` (H3): the agent's response on any Claim (N10);
// effects, and the evidence of each Check the token requires (N9), only from the passed table (S4); and, when `rescued`
// asks, the rescue when failing work moves on to a Vertex (R5a, W3).
function leaves(id: string, proc: checked.CheckedProcedure, ending: OutcomeCase, rescued: boolean) {
  const passed = ending.table === 'passed';
  const keys = [];
  for (const action of ending.table === null ? [] : proc.actions) {
    if (!referencePaths.isRecord(action) || typeof action.id !== 'string') continue;
    if (action.do === 'agent') keys.push(`${id}.${action.id}.response`);
    else if (
      passed &&
      action.do === 'check' &&
      checked.requiredCheckIds(proc, ending.token as string).includes(action.id)
    )
      keys.push(`${id}.${action.id}.evidence`);
    else if (passed && action.do === 'commit') keys.push(`${id}.${action.id}.files`);
    else if (passed && action.do === 'pr-ready') keys.push(PR_READY);
  }
  return !passed && rescued ? [...keys, `${id}.rescue`] : keys;
}

// The strongly connected components of `next` that hold a cycle, each in declaration order (Tarjan).
function cycles(next: Record<string, string[]>) {
  const ids = Object.keys(next);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (vertex: string) => {
    index.set(vertex, index.size);
    low.set(vertex, index.get(vertex) as number);
    stack.push(vertex);
    for (const successor of next[vertex]) {
      if (!index.has(successor)) {
        visit(successor);
        low.set(vertex, Math.min(low.get(vertex) as number, low.get(successor) as number));
      } else if (stack.includes(successor))
        low.set(vertex, Math.min(low.get(vertex) as number, index.get(successor) as number));
    }
    if (low.get(vertex) !== index.get(vertex)) return;
    const component = stack.splice(stack.indexOf(vertex));
    if (component.length > 1 || next[vertex].includes(vertex)) found.push(ids.filter((id) => component.includes(id)));
  };
  for (const vertex of ids) if (!index.has(vertex)) visit(vertex);
  return found;
}

// A route lands on its Vertex, and on every exhausted target its edge's max or a Vertex's max can reach (H2, U5).
// `exhausted` marks a landing that no edge max bounds. A missing exhausted target is H8's error, so its needs-human
// here only fills in routing for doctor.
function landingsOf(
  resolved: Record<string, ResolvedVertex>,
  target: unknown,
  exhausted = false,
  seen: string[] = [],
): Landing[] {
  if (referencePaths.isRecord(target) && Object.hasOwn(target, 'to')) {
    const bounded = report.isCount(target.max);
    return [
      ...landingsOf(resolved, target.to, exhausted, seen),
      ...(bounded ? landingsOf(resolved, target.exhausted ?? flow.NEEDS_HUMAN_ROUTE, true, seen) : []),
    ];
  }
  if (referencePaths.isRecord(target)) return flow.isEnd(target.end) ? [{ end: target.end, exhausted }] : [];
  if (typeof target !== 'string' || !Object.hasOwn(resolved, target) || seen.includes(target)) return [];
  const vertex = resolved[target];
  const next = vertex.exhausted ?? flow.NEEDS_HUMAN_ROUTE;
  return [
    { vertex: target, exhausted },
    ...(report.isCount(vertex.max) ? landingsOf(resolved, next, true, [...seen, target]) : []),
  ];
}

// Where a failure's work goes when a writing Vertex's Outcome routes on.
function workOf(write: boolean, cases: OutcomeCase[], landings: Landing[]) {
  if (!write || cases.every((ending) => ending.table === 'passed')) return null;
  const rescued = landings.some((landing) => landing.vertex);
  const left = landings.some((landing) => landing.end);
  if (rescued && left) return 'rescued, or left in place once exhausted';
  return rescued ? 'rescued' : 'left in place';
}

// A writing Vertex commits on every passing path, under a Claim token that requires a Check.
function checkWrites(fail: (where: string, message: string) => void, id: string, proc: checked.CheckedProcedure) {
  if (!proc.tokens.passed.length) return;
  if (!proc.actions.some((action) => referencePaths.isRecord(action) && action.do === 'commit')) {
    fail(
      id,
      `Vertex ${id} writes, so it must commit on every passing path, but procedure ${proc.name} has no commit Action`,
    );
  }
  for (const token of proc.tokens.passed) {
    if (!proc.claimTokens[token].requires?.length)
      fail(id, `Vertex ${id} writes, so its committing Claim token ${token} must require a Check`);
  }
}

// Each Vertex's Outcomes routed, the routing filled in for doctor, and the edges they take.
function routeEdges(problems: report.Report, graph: Graph) {
  const { resolved, ticket } = graph;
  const fail = (id: string, message: string) => {
    if (graph.clean) report.error(problems, `${graph.location}.ticket.vertices.${id}`, message);
  };
  const edges: Edge[] = [];
  for (const [id, vertex] of Object.entries(resolved)) {
    const proc = graph.procs[id];
    if (!proc) continue;
    const write = vertex.access !== 'read-only';
    if (write) checkWrites(fail, id, proc);
    const cases = checked.casesOf(proc, graph.fallsOf[id]);
    for (const name of vertex.outcomes) {
      const route = flow.route(vertex.route, ticket.routes, name);
      if (!route) {
        fail(id, `Outcome ${name} is not routed by the Vertex or the Flow's routes`);
        continue;
      }
      const landings = landingsOf(resolved, route.target);
      const mine = cases.filter((ending) => ending.outcome === name);
      // An own key, so an Outcome such as __proto__ or toString is data.
      Object.defineProperty(vertex.routing, name, {
        value: { target: route.target, by: route.by, work: workOf(write, mine, landings) },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const target = route.target;
      const bounded = referencePaths.isRecord(target) && report.isCount(target.max) ? target.to : null;
      edges.push({ from: id, outcome: name, landings, bounded, cases: mine, write });
    }
  }
  return edges;
}

// A cycle needs an edge or Vertex with max; the Action Cap does not bound one.
function checkCycles(problems: report.Report, graph: Graph, edges: Edge[]) {
  const { resolved } = graph;
  const bounded = (id: string) => report.isCount(resolved[id].max);
  const next: Record<string, string[]> = Object.fromEntries(Object.keys(resolved).map((id) => [id, []]));
  for (const edge of edges) {
    for (const landing of edge.landings) {
      const { vertex } = landing;
      if (!vertex || bounded(edge.from) || bounded(vertex) || (vertex === edge.bounded && !landing.exhausted)) continue;
      next[edge.from].push(vertex);
    }
  }
  for (const cycle of cycles(next)) {
    report.error(
      problems,
      `${graph.location}.ticket`,
      `the cycle through ${cycle.join(', ')} has no edge or Vertex with max; the Action Cap does not bound a cycle`,
    );
  }
}

// Once every Vertex of such a loop is spent, an entry passes from exhausted target to exhausted target forever (H12).
function checkExhaustedLoops(problems: report.Report, graph: Graph) {
  const { resolved } = graph;
  const ids = Object.keys(resolved);
  const loops = new Map<string, string[]>();
  for (const id of ids) {
    const chain: unknown[] = [];
    let current: unknown = id;
    while (
      typeof current === 'string' &&
      Object.hasOwn(resolved, current) &&
      report.isCount(resolved[current].max) &&
      !chain.includes(current)
    ) {
      chain.push(current);
      current = resolved[current].exhausted;
    }
    if (!chain.includes(current)) continue;
    const loop = chain.slice(chain.indexOf(current));
    const members = ids.filter((member) => loop.includes(member));
    loops.set(JSON.stringify(members), members);
  }
  for (const members of loops.values()) {
    report.error(
      problems,
      `${graph.location}.ticket`,
      `the exhausted targets of ${members.join(', ')} form a loop: ` +
        'once their Visits reach max, no Vertex is ever entered',
    );
  }
}

// The facts the graph checks reason over: each input's sources, as the outputs that produce them, and pr-ready.
const producer = (source: unknown) => {
  const [vertex, action, output] = referencePaths.parse(source).steps as string[];
  return action === 'rescue' ? `${vertex}.rescue` : `${vertex}.${action}.${output}`;
};
function groupsOf(resolved: Record<string, ResolvedVertex>) {
  const groups = new Map<string, string[]>();
  for (const vertex of Object.values(resolved))
    for (const input of Object.values(vertex.inputs)) groups.set(JSON.stringify(input.from), input.from.map(producer));
  return groups;
}

// The facts an Outcome guarantees, the inputs it produces a source of and whether pr-ready ran, are those every way
// of reaching it does; each way is judged on its own first, so a list input (T6) may be met differently by each (H3). A
// rescue may arrive, so it counts for an input on some route (`every` false), but a worktree with nothing to rescue
// leaves none (N4), so it never guarantees one.
function gained(graph: Graph, groups: Map<string, string[]>, edge: Edge, every: boolean) {
  const ways = edge.cases.map((ending) => {
    const keys = leaves(edge.from, graph.procs[edge.from] as checked.CheckedProcedure, ending, edge.write && !every);
    const facts = [...groups]
      .filter(([, sources]) => sources.some((key) => keys.includes(key)))
      .map(([group]) => group);
    return keys.includes(PR_READY) ? [...facts, PR_READY] : facts;
  });
  return ways.reduce((common, way) => common.filter((fact) => way.includes(fact)), ways[0] ?? []);
}

function merge(old: string[] | undefined, reached: string[], every: boolean) {
  if (!old) return reached;
  return every ? old.filter((fact) => reached.includes(fact)) : report.unique([...old, ...reached]);
}

// The facts holding at each reachable Vertex's entry, on every route to it (`every`) or on some route.
function factsAt(graph: Graph, edges: Edge[], groups: Map<string, string[]>, every: boolean) {
  const facts = new Map<unknown, string[]>([[graph.ticket.entry, []]]);
  const queue = [graph.ticket.entry];
  while (queue.length) {
    const from = queue.shift();
    for (const edge of edges.filter((each) => each.from === from)) {
      for (const { vertex } of edge.landings.filter((landing) => landing.vertex)) {
        const reached = report.unique([...(facts.get(from) as string[]), ...gained(graph, groups, edge, every)]);
        const old = facts.get(vertex);
        const merged = merge(old, reached, every);
        if (!old || merged.length !== old.length) {
          facts.set(vertex, merged);
          queue.push(vertex);
        }
      }
    }
  }
  return facts;
}

// The two errors that may be guesses on the map say so, and name the workaround (H4); an optional input no route is
// sure to produce is a warning (H5, T9).
function checkFacts(problems: report.Report, graph: Graph, edges: Edge[]) {
  const vertexAt = (id: string) => `${graph.location}.ticket.vertices.${id}`;
  const groups = groupsOf(graph.resolved);
  const every = factsAt(graph, edges, groups, true);
  const some = factsAt(graph, edges, groups, false);
  for (const id of Object.keys(graph.resolved))
    if (!every.has(id)) report.warn(problems, vertexAt(id), `Vertex ${id} is not reachable from the entry`);
  for (const edge of edges) {
    if (!every.has(edge.from) || !edge.landings.some((landing) => landing.end === 'ready-for-qa')) continue;
    if (![...(every.get(edge.from) as string[]), ...gained(graph, groups, edge, false)].includes(PR_READY)) {
      report.error(
        problems,
        vertexAt(edge.from),
        `Outcome ${edge.outcome} reaches end ready-for-qa on a route that may skip pr-ready; ` +
          'admission checks routes, not runs, so route it through the Vertex that runs pr-ready',
      );
    }
  }
  for (const [id, vertex] of Object.entries(graph.resolved)) {
    if (every.has(id)) checkInputFacts(problems, { id, location: vertexAt(id), vertex }, every, some);
  }
}

function checkInputFacts(
  problems: report.Report,
  place: { id: string; location: string; vertex: ResolvedVertex },
  every: Map<unknown, string[]>,
  some: Map<unknown, string[]>,
) {
  const { id } = place;
  for (const [name, input] of Object.entries(place.vertex.inputs)) {
    const group = JSON.stringify(input.from);
    const where = `${place.location}.inputs.${name}`;
    if (!input.optional && !(every.get(id) as string[]).includes(group)) {
      report.error(
        problems,
        where,
        `input ${name} is required, but some route to ${id} may not produce any of its sources; ` +
          'admission checks routes, not runs, so if every run does produce one, mark the input optional',
      );
    }
    if (input.optional && !(some.get(id) as string[]).includes(group)) {
      report.warn(
        problems,
        where,
        `input ${name} is optional, but no route to ${id} is sure to produce any of its sources; ` +
          'admission checks routes, not runs, so it may still arrive on some runs',
      );
    }
  }
}

export function checkGraph(problems: report.Report, graph: Graph) {
  const edges = routeEdges(problems, graph);
  if (!graph.clean) return;
  checkCycles(problems, graph, edges);
  checkExhaustedLoops(problems, graph);
  checkFacts(problems, graph, edges);
}
