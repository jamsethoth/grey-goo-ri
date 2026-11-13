// A Flow's routes checked: each route target, the Edge form that bounds one, and a Vertex's own bound. Each check gives
// the target it judged, or Reported where it reported one (#391). lib/validate/flows.ts checks a Flow's routes with it.

import * as flow from '../flow.ts';
import * as labels from '../labels.ts';
import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import * as report from './report.ts';

type Value = Record<string, unknown>;
type Reported = report.Reported;

// A route target is a Vertex id, { end }, or this edge form.
export const EDGE_KEYS = ['to', 'max', 'exhausted'];

export const unknownVertex = (problems: report.Report, location: string, vertex: unknown) =>
  report.error(problems, location, 'unknown-vertex', `${JSON.stringify(vertex)} is not a Vertex`, { vertex });

export function checkTarget(
  problems: report.Report,
  location: string,
  target: unknown,
  vertices: Value,
): model.Target | Reported {
  if (typeof target === 'string')
    return Object.hasOwn(vertices, target) ? target : unknownVertex(problems, location, target);
  if (referencePaths.isRecord(target) && Object.hasOwn(target, 'end') && Object.keys(target).length === 1) {
    const { end } = target;
    if (end === 'done')
      return report.error(
        problems,
        location,
        'human-only-end',
        'end "done" is the human-only end, which no route may name',
      );
    if (flow.isEnd(end)) return { end };
    return report.error(
      problems,
      location,
      'unknown-end',
      `end ${JSON.stringify(end)} is not one of ${labels.END_STATES.join(', ')}`,
      {
        end,
      },
    );
  }
  return report.error(
    problems,
    location,
    'malformed-route-target',
    'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }',
  );
}

// A bound's max and exhausted target, each given with the other; `what` names the Vertex or the edge in the sentence.
function checkBound(problems: report.Report, location: { max: string; pair: string }, bound: Value, what: string) {
  const { max, exhausted } = bound;
  let reported: Reported | undefined;
  if (max !== undefined && !report.isCount(max))
    reported = report.error(problems, location.max, 'not-a-positive-integer', 'max must be a positive integer');
  if (max !== undefined && exhausted === undefined)
    reported = report.error(
      problems,
      location.pair,
      'max-without-exhausted',
      `${what} with max names its exhausted target`,
    );
  if (max === undefined && exhausted !== undefined)
    reported = report.error(problems, location.pair, 'exhausted-without-max', `${what} names exhausted only with max`);
  return reported ?? (report.isCount(max) ? max : undefined);
}

// A route's target may also be an edge, which bounds its traversals.
export function checkRouteTarget(
  problems: report.Report,
  location: string,
  target: unknown,
  vertices: Value,
): model.RouteTarget | Reported {
  if (!(referencePaths.isRecord(target) && Object.hasOwn(target, 'to')))
    return checkTarget(problems, location, target, vertices);
  const before = problems.errors.length;
  report.unknownKeys(problems, target, EDGE_KEYS, location);
  const to = checkTarget(problems, location, target.to, vertices);
  const max = checkBound(problems, { max: location, pair: location }, target, 'an edge');
  const exhausted =
    target.exhausted === undefined ? undefined : checkTarget(problems, location, target.exhausted, vertices);
  if (report.isReported(to)) return to;
  if (report.isReported(max)) return max;
  if (report.isReported(exhausted)) return exhausted;
  const reported = report.reportedSince(problems, before);
  if (reported) return reported;
  return { to, ...(max !== undefined && { max }), ...(exhausted !== undefined && { exhausted }) };
}

// Routes by Outcome, each target checked, or Reported when one is; routes that are not an object are the caller's.
export function checkRoutes(
  problems: report.Report,
  location: string,
  routes: unknown,
  vertices: Value,
): Record<string, model.RouteTarget> | Reported {
  const typed: [string, model.RouteTarget][] = [];
  let refused: Reported | undefined;
  for (const [outcome, target] of report.entries(routes)) {
    const checked = checkRouteTarget(problems, `${location}.${outcome}`, target, vertices);
    if (report.isReported(checked)) refused = checked;
    else typed.push([outcome, checked]);
  }
  // Built from entries, so an Outcome such as __proto__ is an own key.
  return refused ?? Object.fromEntries(typed);
}

// A Vertex's routes and its own bound.
export function checkVertexRoutes(problems: report.Report, location: string, vertex: Value, vertices: Value) {
  const route = checkRoutes(problems, `${location}.route`, vertex.route, vertices);
  const notAnObject =
    vertex.route !== undefined && !referencePaths.isRecord(vertex.route)
      ? report.error(problems, `${location}.route`, 'not-an-object', 'route must be an object from Outcome to target')
      : undefined;
  const max = checkBound(problems, { max: `${location}.max`, pair: location }, vertex, 'a Vertex');
  const exhausted =
    vertex.exhausted === undefined ? null : checkTarget(problems, `${location}.exhausted`, vertex.exhausted, vertices);
  return { route: notAnObject ?? route, max: max ?? null, exhausted };
}
