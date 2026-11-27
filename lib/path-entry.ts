// A candidate on PATH, as a search for a command reads it: its own entry (a link is not followed), or undefined when
// it is missing or cannot be read (an unreachable share, a name too long), so the search goes on to the next.
import { lstatSync, type Stats } from 'node:fs';

export function pathEntry(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch {
    return undefined;
  }
}
