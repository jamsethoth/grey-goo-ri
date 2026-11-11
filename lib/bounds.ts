// Where an Outcome takes the Execution once its Bounds count: the route lib/flow.ts gives, an exhausted Bound's
// `exhausted` target in its place, and the Action Cap no Flow Attempt passes (request 3.3, U5, V1).
import type * as events from './events.ts';
import * as flow from './flow.ts';
import * as labels from './labels.ts';
import * as outcome from './outcome.ts';
import type { RunContext } from './run-context.ts';
import type * as visit from './visit.ts';

// A route's target: a Vertex, an end, or a bounded Edge to a Vertex.
type Target = string | flow.EndTarget;
interface BoundedEdge {
  to: string;
  max: number;
  exhausted: Target;
}

// Where the Edge goes, the Bounds it passed (`spent`, for the Terminal Reason, and `spentBounds`, for visit_end), and,
// for an Edge declared `{ to }` that reached `to`, its traversal key and new count. `withinBound` says the Edge has a
// `max` it has not spent, so visit_end names it: the record counts an Edge with no `max`, or one whose spent Bound's
// `exhausted` is its own `to`, too.
export interface Traversal {
  next: string;
  spent: string[];
  spentBounds: events.SpentBound[];
  key?: string;
  count?: number;
  withinBound: boolean;
}

// An Edge declared with a `max` it has not yet spent: `{ to }` alone has none.
const withinBound = (bounded: BoundedEdge, count: number) => bounded.max !== undefined && count < bounded.max;
const nameOf = (target: Target): string => (typeof target === 'string' ? target : target.end);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// Where an Outcome leaves the pinned Vertex: its declared route (lib/flow.ts), else end: needs-human (R12c). Only the
// Procedure's Outcomes and harness exhaustion are routable; any other (an Integrity Violation, a run stop, the Action
// Cap) ends at needs-human whatever the routes say. An end's name is the next cursor's Vertex, which no Vertex may take
// (lib/validate/).
function targetOf(runContext: RunContext, outcomeName: string): Target | BoundedEdge {
  const { outcomes, route, routes } = runContext.record.configurationSnapshot!;
  const routable = (outcomes as string[]).includes(outcomeName) || outcome.ENGINE_OUTCOMES.includes(outcomeName);
  return ((routable && flow.route(route, routes, outcomeName)?.target) || flow.NEEDS_HUMAN_ROUTE) as
    Target | BoundedEdge;
}

// The effective target (U5, request 3.3): a bounded Edge counts traversals per Execution in record.traversals and, once
// `max` is reached, routes to its `exhausted` target; a Vertex whose Visits reached its own `max` passes on to its own
// `exhausted` target, which wins when the Edge into it is spent too.
export function edge(runContext: RunContext, outcomeName: string): Traversal {
  const { record: executionRecord, flow: runFlow } = runContext;
  const target = targetOf(runContext, outcomeName);
  const bound = (id: string) => runFlow.ticket.vertices.get(id)?.max;
  const full = (id: string) => !!bound(id) && (executionRecord.visits.get(id) ?? 0) >= bound(id)!;
  const spent: string[] = [];
  const spentBounds: events.SpentBound[] = [];
  const bounded = typeof target === 'object' && 'to' in target ? target : null;
  let next = bounded ? bounded.to : nameOf(target as Target);
  const key = bounded ? `${executionRecord.configurationSnapshot!.vertex}->${bounded.to}:${outcomeName}` : undefined;
  const count = key ? (executionRecord.traversals.get(key) ?? 0) : 0;
  if (bounded && count >= bounded.max) {
    spent.push(`its Edge to ${bounded.to} had used its Bound of ${plural(bounded.max, 'traversal')}`);
    spentBounds.push({ edge: key! });
    if (!full(bounded.to)) next = nameOf(bounded.exhausted);
  }
  // Admission rejects a loop of spent Vertices (H12); a run that meets one anyway ends at needs-human.
  for (const seen = new Set(); full(next);) {
    if (seen.has(next)) return { next: labels.NEEDS_HUMAN, spent, spentBounds, withinBound: false };
    seen.add(next);
    spent.push(`${next} had used its Bound of ${plural(bound(next)!, 'Visit')}`);
    spentBounds.push({ vertex: next });
    next = nameOf(runFlow.ticket.vertices.get(next)?.exhausted as Target);
  }
  if (!bounded || next !== bounded.to) return { next, spent, spentBounds, withinBound: false };
  return { next, key, count: count + 1, spent, spentBounds, withinBound: withinBound(bounded, count) };
}

// Whether an Outcome's effective target is another Vertex, once its Bounds count (U5): its work must then leave the
// worktree (R5a). An end leaves it in place for the human (R5b).
export const routesToVertex = (runContext: RunContext, outcomeName: string): boolean =>
  !flow.isEnd(edge(runContext, outcomeName).next);

// A spent Bound's clause in a Terminal Reason, naming where the route went instead.
export const spentText = (traversal: Traversal): string =>
  traversal.spent.length ? `, and ${traversal.spent.join(' and ')}, so the route ended at ${traversal.next}` : '';

// Takes the Edge; the count is saved with the next Vertex's entry, before it runs, so a restart routes the same way.
export function traverse(runContext: RunContext, outcomeName: string): Traversal {
  const traversal = edge(runContext, outcomeName);
  if (traversal.key) runContext.record.traversals.set(traversal.key, traversal.count!);
  return traversal;
}

// The Action Cap (request 3.3, V1): a Flow Attempt past it never runs, and the Execution ends at needs-human, whatever
// any Bound says. record.attempts counts the Flow's Attempts entered, the refused one included, so a restart refuses it
// again; engine reporting is not counted and still runs.
export const capped = (runContext: RunContext): visit.ActionCapResolution | null =>
  runContext.record.attempts > runContext.flow.actionCap
    ? {
        outcome: labels.NEEDS_HUMAN,
        direction: 'stop',
        row: 'action-cap',
        rule: { table: 'fixed', row: 'action-cap' },
        actionCap: runContext.flow.actionCap,
      }
    : null;
