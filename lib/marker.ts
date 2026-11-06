// Action Marker: gg:<execution>:<vertex>:<visit>:<action>:<recovery>:<run>:<attempt>, carried as a commit trailer or a
// PR body comment.
const PARTS = ['execution', 'vertex', 'visit', 'action', 'recovery', 'run', 'attempt'] as const;
export type MarkerPart = (typeof PARTS)[number];

// The Action identity the interpreter passes each Action. `procedure` is null for a Terminal's reporting Actions, which
// run outside any Procedure; `attempt` is given only where an Attempt after the first is entered.
export interface ActionIdentity {
  vertex: string;
  visit: number;
  procedure?: string | null;
  action: string;
  recovery: number;
  attempt?: number;
}

export function formatMarker(parts: Record<MarkerPart, string | number>): string {
  for (const key of ['vertex', 'action'] as const) {
    if (String(parts[key]).includes(':')) throw new Error(`Action Marker ${key} may not contain ':': ${parts[key]}`);
  }
  return ['gg', ...PARTS.map((part) => parts[part])].join(':');
}

// The parts of a bare marker, as strings.
export const partsOf = (actionMarker: string): Record<MarkerPart, string> =>
  Object.fromEntries(PARTS.map((part, i) => [part, actionMarker.split(':')[i + 1]])) as Record<MarkerPart, string>;

// The key of an Action across its Attempts: its retries are saved under it. A marker's parts name it too, as strings.
export const actionKeyOf = (actionIdentity: {
  vertex: string;
  visit: number | string;
  action: string;
  recovery: number | string;
}): string => `${actionIdentity.vertex}/${actionIdentity.visit}/${actionIdentity.action}/${actionIdentity.recovery}`;

export const markerTrailer = (actionMarker: string): string => `Gg-Action: ${actionMarker}`;
export const markerComment = (actionMarker: string): string => `<!-- gg-action ${actionMarker} -->`;

const LINE = /^[ \t]*(?:Gg-Action: (gg(?::[^:\s]+){7})|<!-- gg-action (gg(?::[^:\s]+){7}) -->)[ \t]*$/gm;

// The last marker line wins: rendered text puts the canonical marker after any agent text that mimics one.
export function parseMarker(text: string | null | undefined): Record<MarkerPart, string> | null {
  const match = [...String(text ?? '').matchAll(LINE)].at(-1);
  return match ? partsOf((match[1] ?? match[2]) as string) : null;
}
