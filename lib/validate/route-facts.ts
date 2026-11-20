// What a route guarantees on the route map graph.ts builds: pr-ready before ready-for-qa and each input's sources at
// its Vertex (R11e, Q7, H1-H5); unreachable Vertices are warned. Only lib/validate/graph.ts imports it.

import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as graph from './graph.ts';
import * as checked from './procedures.ts';
import * as report from './report.ts';

const PR_READY = 'pr-ready';

type OutcomeCase = checked.OutcomeCase;
// The map the facts are read over: the Vertices it reads, each with its Procedure, and the entry.
export interface Facts {
  location: string;
  entry: string;
  resolved: Map<string, model.DeclaredVertexJson>;
  vertexProcedures: Map<string, checked.CheckedProcedure | undefined>;
}

// The output an Action kind leaves only on a passed ending: a commit's files, and a Decision, which takes the passed
// table's place (X1c).
const PASSED_OUTPUTS = new Map<unknown, string>([
  ['commit', 'files'],
  ['await-approval', 'decision'],
]);

// The outputs a Visit of Vertex `id` leaves when it ends in `ending` (H3): the agent's response on any Claim (N10);
// effects, and the evidence of each Check the token requires (N9), only from the passed table (S4); and, when `rescued`
// asks, the rescue when failing work moves on to a Vertex (R5a, W3).
function leaves(id: string, procedure: checked.CheckedProcedure, ending: OutcomeCase, rescued: boolean) {
  const passed = ending.table === 'passed';
  const keys = [];
  for (const action of ending.table === null ? [] : procedure.actions) {
    if (!referencePaths.isRecord(action) || typeof action.id !== 'string') continue;
    if (action.do === 'agent') keys.push(`${id}.${action.id}.response`);
    else if (
      passed &&
      action.do === 'check' &&
      checked.requiredCheckIds(procedure, ending.token as string).includes(action.id)
    )
      keys.push(`${id}.${action.id}.evidence`);
    else if (passed && PASSED_OUTPUTS.has(action.do)) keys.push(`${id}.${action.id}.${PASSED_OUTPUTS.get(action.do)}`);
    else if (passed && action.do === 'pr-ready') keys.push(PR_READY);
  }
  return !passed && rescued ? [...keys, `${id}.rescue`] : keys;
}

// The facts the graph checks reason over: each input's sources, as the outputs that produce them, and pr-ready.
const producer = (source: unknown) => {
  const [vertex, action, output] = referencePaths.parse(source).steps as string[];
  return action === 'rescue' ? `${vertex}.rescue` : `${vertex}.${action}.${output}`;
};
function groupsOf(resolved: Map<string, model.DeclaredVertexJson>) {
  const groups = new Map<string, string[]>();
  for (const vertex of resolved.values())
    for (const input of Object.values(vertex.inputs)) groups.set(JSON.stringify(input.from), input.from.map(producer));
  return groups;
}

// The facts an Outcome guarantees, the inputs it produces a source of and whether pr-ready ran, are those every way
// of reaching it does; each way is judged on its own first, so a list input (T6) may be met differently by each (H3). A
// rescue may arrive, so it counts for an input on some route (`every` false), but a worktree with nothing to rescue
// leaves none (N4), so it never guarantees one.
function gained(facts: Facts, groups: Map<string, string[]>, edge: graph.Edge, every: boolean) {
  const ways = edge.cases.map((ending) => {
    const procedure = facts.vertexProcedures.get(edge.from) as checked.CheckedProcedure;
    const keys = leaves(edge.from, procedure, ending, edge.write && !every);
    const found = [...groups]
      .filter(([, sources]) => sources.some((key) => keys.includes(key)))
      .map(([group]) => group);
    return keys.includes(PR_READY) ? [...found, PR_READY] : found;
  });
  return ways.reduce((common, way) => common.filter((fact) => way.includes(fact)), ways[0] ?? []);
}

function merge(old: string[] | undefined, reached: string[], every: boolean) {
  if (!old) return reached;
  return every ? old.filter((fact) => reached.includes(fact)) : report.unique([...old, ...reached]);
}

// The facts holding at each reachable Vertex's entry, on every route to it (`every`) or on some route.
function factsAt(facts: Facts, edges: graph.Edge[], groups: Map<string, string[]>, every: boolean) {
  const holding = new Map<string, string[]>([[facts.entry, []]]);
  const queue = [facts.entry];
  while (queue.length) {
    const from = queue.shift() as string;
    for (const edge of edges.filter((each) => each.from === from)) {
      for (const { vertex } of edge.landings) {
        if (!vertex) continue;
        const reached = report.unique([...(holding.get(from) as string[]), ...gained(facts, groups, edge, every)]);
        const old = holding.get(vertex);
        const merged = merge(old, reached, every);
        if (!old || merged.length !== old.length) {
          holding.set(vertex, merged);
          queue.push(vertex);
        }
      }
    }
  }
  return holding;
}

// The two errors that may be guesses on the map say so, and name the workaround (H4); an optional input no route is
// sure to produce is a warning (H5, T9).
export function checkFacts(problems: report.Report, facts: Facts, edges: graph.Edge[], warn: boolean) {
  const vertexAt = (id: string) => `${facts.location}.ticket.vertices.${id}`;
  const groups = groupsOf(facts.resolved);
  const every = factsAt(facts, edges, groups, true);
  const some = factsAt(facts, edges, groups, false);
  for (const id of facts.resolved.keys())
    if (warn && !every.has(id))
      report.warn(problems, vertexAt(id), 'unreachable-vertex', `Vertex ${id} is not reachable from the entry`, {
        vertex: id,
      });
  for (const edge of edges) {
    if (!every.has(edge.from) || !edge.landings.some((landing) => landing.end === 'ready-for-qa')) continue;
    if (![...(every.get(edge.from) as string[]), ...gained(facts, groups, edge, false)].includes(PR_READY)) {
      report.error(
        problems,
        vertexAt(edge.from),
        'pr-ready-skippable',
        `Outcome ${edge.outcome} reaches end ready-for-qa on a route that may skip pr-ready; ` +
          'admission checks routes, not runs, so route it through the Vertex that runs pr-ready',
        { outcome: edge.outcome },
      );
    }
  }
  for (const [id, vertex] of facts.resolved) {
    if (every.has(id)) checkInputFacts(problems, { id, location: vertexAt(id), vertex, warn }, every, some);
  }
}

function checkInputFacts(
  problems: report.Report,
  place: { id: string; location: string; vertex: model.DeclaredVertexJson; warn: boolean },
  every: Map<string, string[]>,
  some: Map<string, string[]>,
) {
  const { id } = place;
  for (const [name, input] of Object.entries(place.vertex.inputs)) {
    const group = JSON.stringify(input.from);
    const where = `${place.location}.inputs.${name}`;
    if (!input.optional && !(every.get(id) as string[]).includes(group)) {
      report.error(
        problems,
        where,
        'required-input-unsure',
        `input ${name} is required, but some route to ${id} may not produce any of its sources; ` +
          'admission checks routes, not runs, so if every run does produce one, mark the input optional',
        { input: name, vertex: id },
      );
    }
    if (place.warn && input.optional && !(some.get(id) as string[]).includes(group)) {
      report.warn(
        problems,
        where,
        'optional-input-unsure',
        `input ${name} is optional, but no route to ${id} is sure to produce any of its sources; ` +
          'admission checks routes, not runs, so it may still arrive on some runs',
        { input: name, vertex: id },
      );
    }
  }
}
