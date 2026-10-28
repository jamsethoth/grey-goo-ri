// Action Marker: gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:<attempt>, carried as a commit trailer or a PR body comment.
const PARTS = ['execution', 'vertex', 'visit', 'action', 'recovery', 'run', 'attempt'];

export function formatMarker(parts) {
  for (const key of ['vertex', 'action']) {
    if (String(parts[key]).includes(':')) throw new Error(`Action Marker ${key} may not contain ':': ${parts[key]}`);
  }
  return ['gg', ...PARTS.map((k) => parts[k])].join(':');
}

// The parts of a bare marker, as strings.
export const partsOf = (m) => Object.fromEntries(PARTS.map((k, i) => [k, m.split(':')[i + 1]]));

// The key of an Action across its Attempts: its retries are saved under it.
export const actionKeyOf = (at) => `${at.vertex}/${at.visit}/${at.action}/${at.recovery}`;

export const markerTrailer = (marker) => `Gg-Action: ${marker}`;
export const markerComment = (marker) => `<!-- gg-action ${marker} -->`;

const LINE = /^[ \t]*(?:Gg-Action: (gg(?::[^:\s]+){7})|<!-- gg-action (gg(?::[^:\s]+){7}) -->)[ \t]*$/gm;

// The last marker line wins: rendered text puts the canonical marker after any agent text that mimics one.
export function parseMarker(text) {
  const m = [...String(text ?? '').matchAll(LINE)].at(-1);
  return m ? partsOf(m[1] ?? m[2]) : null;
}
