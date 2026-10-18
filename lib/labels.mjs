import { publicText } from './render.mjs';

export const STATE_LABELS = ['in-progress', 'needs-human', 'ready-for-qa', 'needs-replan'];
// Admission treats in-progress specially (stuck detection); every State Label still means the ticket is not idle.
export const BUSY_STATES = [...STATE_LABELS];

export function labels(prefix = 'gg') {
  prefix = publicText(prefix);
  return {
    state: (name) => `${prefix}:state:${name}`,
    await: (vertex) => `${prefix}:await:${vertex}`,
    decide: (vertex, outcome) => `${prefix}:decide:${vertex}:${outcome}`,
    parse(label) {
      const [p, family, a, b, ...rest] = label.split(':');
      if (p !== prefix || !a || rest.length) return null;
      if (family === 'state' && b === undefined) return { family, name: a };
      if (family === 'await' && b === undefined) return { family, vertex: a };
      if (family === 'decide' && b) return { family, vertex: a, outcome: b };
      return null;
    },
  };
}
