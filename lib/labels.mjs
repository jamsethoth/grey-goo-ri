// The end states, the one definition: where an Execution can end, each the State Label it sets (R11a, R11b).
// The end a hold, a fault, an unrouted engine Outcome or a human's stop takes.
export const NEEDS_HUMAN = 'needs-human';
// A route to it: where an exhausted Bound goes, and the engine's own Outcomes unless routed (R12c, T7).
export const NEEDS_HUMAN_ROUTE = { end: NEEDS_HUMAN };
export const ENDS = ['ready-for-qa', NEEDS_HUMAN, 'needs-replan'];
export const STATE_LABELS = ['in-progress', ...ENDS];
// Admission treats in-progress specially (stuck detection); every State Label still means the ticket is not idle.
export const BUSY_STATES = [...STATE_LABELS];

// GitHub matches label names case-insensitively, so every comparison of label names does too.
const key = (name) => name.toLowerCase();
export const has = (names, wanted) => [...names].some((name) => key(name) === key(wanted));

// The label prefix when the configuration names none.
export const DEFAULT_PREFIX = 'gg';

export function labels(prefix = DEFAULT_PREFIX) {
  return {
    state: (name) => `${prefix}:state:${name}`,
    await: (vertex) => `${prefix}:await:${vertex}`,
    decide: (vertex, outcome) => `${prefix}:decide:${vertex}:${outcome}`,
    parse(label) {
      const [p, f, a, b, ...rest] = label.split(':');
      if (!has([prefix], p) || !f || !a || rest.length) return null;
      const family = key(f);
      if (family === 'state' && b === undefined) return { family, name: STATE_LABELS.find((s) => has([s], a)) ?? a };
      if (family === 'await' && b === undefined) return { family, vertex: a };
      if (family === 'decide' && b) return { family, vertex: a, outcome: b };
      return null;
    },
  };
}
