import type * as marker from '../../lib/marker.ts';

// The parts of an Action Marker a case formats and parses back.
export const parts = {
  execution: 'e1',
  vertex: 'implement',
  visit: 2,
  action: 'test',
  recovery: 1,
  run: 'r1',
  attempt: 1,
} satisfies Record<marker.MarkerPart, string | number>;

// Parsed parts come back as strings; compare on that form. A null parse throws, as Object.entries(null) does.
export const asText = (given: object | null): Record<string, string> =>
  Object.fromEntries(Object.entries(given as object).map(([key, value]) => [key, String(value)]));
