// An Execution Record in a Visit of one Vertex, with the counts a Bound reads, and a Flow of the Vertices it names,
// built without the validator, so a case can hold a loop of spent Vertices admission rejects (H12).
import type * as model from '../../lib/model.ts';
import type * as record from '../../lib/record.ts';
import type * as visit from '../../lib/visit.ts';
import { unvisitedExecution } from './unvisited-execution.ts';

type Bounds = Partial<Pick<model.ResolvedVertexJson, 'max' | 'exhausted'>>;

export function countedExecution({
  vertex = 'reviewer',
  route = {},
  vertices = {},
  visits = {},
  traversals = {},
  attempts = 0,
  actionCap = 4,
}: {
  vertex?: string;
  route?: Record<string, model.RouteTarget>;
  vertices?: Record<string, Bounds>;
  visits?: Record<string, number>;
  traversals?: Record<string, number>;
  attempts?: number;
  actionCap?: number;
}): { record: record.ExecutionRecord; flow: model.ResolvedFlow } {
  const executionRecord = unvisitedExecution({ commonDir: 'common', worktree: 'worktree' });
  executionRecord.configurationSnapshot = {
    vertex,
    outcomes: Object.keys(route),
    route,
    routes: {},
  } as unknown as visit.ConfigurationSnapshot;
  executionRecord.visits = new Map(Object.entries(visits));
  executionRecord.traversals = new Map(Object.entries(traversals));
  executionRecord.attempts = attempts;
  const bounded = Object.entries(vertices).map(
    ([id, bounds]) => [id, { max: null, exhausted: null, ...bounds }] as const,
  );
  const flow = {
    name: 'counted',
    actionCap,
    procedures: new Map(),
    ticket: { entry: vertex, routes: {}, vertices: new Map(bounded) },
  } as unknown as model.ResolvedFlow;
  return { record: executionRecord, flow };
}
