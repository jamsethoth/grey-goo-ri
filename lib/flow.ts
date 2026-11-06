// The Flow's rules that the interpreter and the validator share: where an Outcome leaves a Vertex (H7), and the
// Resolved Flow written to a Run's directory.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as labels from './labels.ts';
import * as outcome from './outcome.ts';
import * as referencePaths from './reference-paths.ts';

// A route to an end. needs-human is where an exhausted Bound goes, and the engine's own Outcomes unless routed (R12c,
// T7).
export interface EndTarget {
  end: labels.EndState;
}
export const NEEDS_HUMAN_ROUTE: EndTarget = { end: labels.NEEDS_HUMAN };

export const isEnd = (value: unknown): value is labels.EndState => (labels.ENDS as unknown[]).includes(value);

// Which declaration an Outcome's route came from, as gg doctor prints it.
export type RouteSource = 'Vertex route' | 'Flow routes' | 'Vertex "*"' | 'Flow "*"' | 'engine default';
// The target is as declared: admission checks it, gg doctor prints it either way.
export interface Route {
  target: unknown;
  by: RouteSource;
}

// Where an Outcome leaves a Vertex (H7): an explicit Outcome name, the Vertex's then the Flow's, before either
// catch-all; else an engine Outcome ends at needs-human (R12c) and any other is unrouted. Only own keys route, so an
// Outcome such as toString never reads an inherited property.
export function route(vertexRoutes: unknown, flowRoutes: unknown, outcomeName: string): Route | null {
  const order: [RouteSource, unknown, string][] = [
    ['Vertex route', vertexRoutes, outcomeName],
    ['Flow routes', flowRoutes, outcomeName],
    ['Vertex "*"', vertexRoutes, '*'],
    ['Flow "*"', flowRoutes, '*'],
  ];
  for (const [by, routes, key] of order) {
    if (referencePaths.isRecord(routes) && Object.hasOwn(routes, key)) return { target: routes[key], by };
  }
  return outcome.ENGINE_OUTCOMES.includes(outcomeName) ? { target: NEEDS_HUMAN_ROUTE, by: 'engine default' } : null;
}

// The Resolved Flow the validator gave admission, and its Config Hash, in the Run's directory.
export function writeResolved(runDir: string, resolved: unknown, hash: string) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'flow.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  writeFileSync(join(runDir, 'config-hash.txt'), `${hash}\n`);
}
