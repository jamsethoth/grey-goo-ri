// The end states, the one definition: where an Execution can end, each the State Label it sets (R11a, R11b).
// The end a hold, a fault, an unrouted engine Outcome or a human's stop takes.
export const NEEDS_HUMAN = 'needs-human';
export type EndState = 'ready-for-qa' | typeof NEEDS_HUMAN | 'needs-replan';
// The name a State Label carries after its prefix: in-progress while the Execution runs, then its end state.
export type StateName = 'in-progress' | EndState;
export const END_STATES: EndState[] = ['ready-for-qa', NEEDS_HUMAN, 'needs-replan'];
export const STATE_NAMES: StateName[] = ['in-progress', ...END_STATES];
// Admission treats in-progress specially (stuck detection); every State Label still means the ticket is not idle.
export const BUSY_STATES: StateName[] = [...STATE_NAMES];

// GitHub matches label names case-insensitively, so every comparison of label names does too.
const key = (name: string): string => name.toLowerCase();
export const hasLabel = (names: Iterable<string>, wanted: string): boolean =>
  [...names].some((name) => key(name) === key(wanted));

// The label prefix when the configuration names none.
export const DEFAULT_PREFIX = 'gg';

// A label gg reads back: a State Label's name (an unknown one as written), or the Vertex of an Await Label, or the
// Vertex and Outcome of a Decide Label.
export type ParsedLabel =
  | { family: 'state'; name: string }
  | { family: 'await'; vertex: string }
  | { family: 'decide'; vertex: string; outcome: string };

export interface GgLabels {
  state: (name: string) => string;
  await: (vertex: string) => string;
  decide: (vertex: string, outcome: string) => string;
  parse: (label: string) => ParsedLabel | null;
}

export function labelsFor(prefix: string = DEFAULT_PREFIX): GgLabels {
  return {
    state: (name) => `${prefix}:state:${name}`,
    await: (vertex) => `${prefix}:await:${vertex}`,
    decide: (vertex, outcome) => `${prefix}:decide:${vertex}:${outcome}`,
    parse(label) {
      const [labelPrefix, familyName, subject, detail, ...rest] = label.split(':');
      if (!hasLabel([prefix], labelPrefix as string) || !familyName || !subject || rest.length) return null;
      const family = key(familyName);
      if (family === 'state' && detail === undefined)
        return { family, name: STATE_NAMES.find((state) => hasLabel([state], subject)) ?? subject };
      if (family === 'await' && detail === undefined) return { family, vertex: subject };
      if (family === 'decide' && detail) return { family, vertex: subject, outcome: detail };
      return null;
    },
  };
}
