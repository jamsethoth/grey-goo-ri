// Action Marker: gg:<execution>:<vertex>:<visit>:<phase>:<ordinal>:<run>:<attempt>, carried as a commit trailer or a PR body comment.
const PARTS = ['execution', 'vertex', 'visit', 'phase', 'ordinal', 'run', 'attempt'];

export function formatMarker(parts) {
  for (const key of ['vertex', 'phase']) {
    if (String(parts[key]).includes(':')) throw new Error(`Action Marker ${key} may not contain ':': ${parts[key]}`);
  }
  return ['gg', ...PARTS.map((k) => parts[k])].join(':');
}

export const markerTrailer = (marker) => `Gg-Action: ${marker}`;
export const markerComment = (marker) => `<!-- gg-action ${marker} -->`;

const LINE = /^[ \t]*(?:Gg-Action: (gg(?::[^:\s]+){7})|<!-- gg-action (gg(?::[^:\s]+){7}) -->)[ \t]*$/gm;

// The last marker line wins: rendered text puts the canonical marker after any agent text that mimics one.
export function parseMarker(text) {
  const m = [...String(text ?? '').matchAll(LINE)].at(-1);
  if (!m) return null;
  const values = (m[1] ?? m[2]).split(':').slice(1);
  return Object.fromEntries(PARTS.map((k, i) => [k, values[i]]));
}
