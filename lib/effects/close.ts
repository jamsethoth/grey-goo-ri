// The close Effect: the Ticket's issue closed, so the Tickets it blocks become ready (gg work done, L12). It has no
// finder: closing a closed issue succeeds, so an open one is simply made again (N3).
import type * as github from '../github.ts';
import type * as effects from './index.ts';

export type Payload = { issue: number };
// Closing an issue leaves nothing of its own to find it by.
export type Evidence = Record<string, never>;

export interface Context {
  gh: Pick<github.Gh, 'closeIssue'>;
  cwd?: string;
}

export const effect: effects.Effect<Payload, Context> = {
  name: 'close',
  remote: 'GitHub',
  perform: async ({ gh, cwd }, { issue }) => {
    await gh.closeIssue(issue, cwd);
    return {};
  },
  repeatable: true,
};
