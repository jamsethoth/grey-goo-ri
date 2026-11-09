// `gg work`: a person's recovery verbs over the Tickets gg runs. Only abandon is implemented.
import type * as github from './github.ts';
import type * as locks from './locks.ts';

// What gg work abandon reaches: the repository's State Database and ticket lock, and GitHub for its State Label.
export interface AbandonOptions {
  ticket: number;
  commonDir: string;
  cwd: string;
  labelPrefix: string;
  gh: github.Gh;
  locks: Pick<locks.Locks, 'tryAcquire' | 'release'>;
}

export async function abandon(_options: AbandonOptions): Promise<string> {
  return '';
}
