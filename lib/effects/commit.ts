// The commit Effect: a commit of the tree the Action staged, on the parent it recorded, carrying its Action Marker.
import type * as record from '../record.ts';
import type * as effects from './index.ts';

export type Payload = { message: string; tree: string; parent: string };

// The git verbs a commit is made with (lib/git.ts).
export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree'>;
  git: {
    commitTree(worktree: string, payload: Payload): Promise<string | null>;
    commitStaged(worktree: string, message: string): Promise<string | null>;
  };
}

export const effect: effects.Effect<Payload, Context> = {
  name: '',
  remote: null,
  perform: async () => ({}),
};

// The last commit gg made, by its marker and sha, or undefined before its first: the branch must still be at its sha.
export const lastCommit = (
  _executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>,
): { actionMarker: string; sha: string } | undefined => undefined;
