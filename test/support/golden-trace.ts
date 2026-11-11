// A golden trace: an Execution's Action Events and visit_end Events, in the order appended, reduced to what a golden
// case asserts.
import type * as events from '../../lib/events.ts';

// An Action Event as a golden trace asserts it.
export interface TracedAction {
  vertex: string;
  action: string;
  recovery: number;
  attempt: number;
  outcome: string;
}
// A visit_end as a golden trace asserts it.
export type TracedVisitEnd = { type: 'visit_end' } & Pick<
  events.VisitEndEvent,
  'vertex' | 'visit' | 'outcome' | 'rule' | 'next' | 'edge' | 'count' | 'spent'
>;
// Reduces Action Events and visit_end Events, in the order appended, to what a golden trace asserts.
export const trace = (traced: events.Event[]): (TracedAction | TracedVisitEnd)[] =>
  traced.flatMap((event): (TracedAction | TracedVisitEnd)[] => {
    if (event.type === 'action') {
      const { vertex, action, recovery, attempt, outcome } = event;
      return [{ vertex, action, recovery, attempt, outcome }];
    }
    if (event.type !== 'visit_end') return [];
    const { vertex, visit, outcome, rule, next, edge, count, spent } = event;
    return [{ type: 'visit_end', vertex, visit, outcome, rule, next, edge, count, spent }];
  });
// A visit_end as a golden trace holds it, for a Visit that took an unbounded route; its rule is by default the Claim
// token's, which no `passed` row or `otherwise` decided.
export const visitEnded = (
  vertex: string,
  next: string,
  {
    visit = 1,
    outcome = 'ok',
    rule = { table: 'passed', row: null },
  }: Partial<Pick<TracedVisitEnd, 'visit' | 'outcome' | 'rule'>> = {},
): TracedVisitEnd => ({ type: 'visit_end', vertex, visit, outcome, rule, next, edge: null, count: null, spent: [] });
export const isTracedAction = (entry: TracedAction | TracedVisitEnd): entry is TracedAction =>
  !('type' in entry && entry.type === 'visit_end');
// A trace entry as one line: an Action as `format` writes it, a visit_end as `<vertex> <outcome> -> <next>`.
export const line =
  (format: (action: TracedAction) => string) =>
  (entry: TracedAction | TracedVisitEnd): string =>
    isTracedAction(entry) ? format(entry) : `${entry.vertex} ${entry.outcome} -> ${entry.next}`;
