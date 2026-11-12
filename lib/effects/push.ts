// The push Effect: the commit the record proves checked, pushed to its branch on origin.
import type * as record from '../record.ts';
import type * as effects from './index.ts';

export type Payload = { branch: string; sha: string };

// The git verbs a push is made with (lib/git.ts).
export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree'>;
  git: {
    push(worktree: string, branch: string, sha: string): Promise<unknown>;
    remoteSha(worktree: string, branch: string): Promise<string | null>;
  };
}

export const effect: effects.Effect<Payload, Context> = {
  name: '',
  remote: null,
  perform: async () => ({}),
};
