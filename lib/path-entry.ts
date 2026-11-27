// A candidate on PATH, as a search for a command reads it: its own entry (a link is not followed), or undefined when
// it is missing or cannot be read (an unreachable share, a name too long), so the search goes on to the next.
import type { Stats } from 'node:fs';

// Stub (#548): Green reads the entry.
export function pathEntry(file: string): Stats | undefined {
  return undefined;
}
