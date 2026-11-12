// The pr-ready Effect: a PR marked ready for review, only at the commit its intent targets (R11d, T1a, M1).
import type * as github from '../github.ts';
import type * as integrity from '../integrity.ts';
import type * as locks from '../locks.ts';
import type * as record from '../record.ts';
import type * as effects from './index.ts';

export type Payload = { number: number; sha: string | null; tree: string | null };

// What a PR is checked against before it is marked ready: the worktree, the commit's tree and the PR's head.
export interface Context {
  record: Pick<record.ExecutionRecord, 'worktree' | 'branch'>;
  git: integrity.IntegrityGit & { treeOf(worktree: string, commit?: string): Promise<string> };
  gh: Pick<github.Gh, 'viewPr' | 'markReady'>;
  cwd?: string;
  locks: locks.Locks | undefined;
}

export const effect: effects.Effect<Payload, Context> = {
  name: '',
  remote: null,
  perform: async () => ({}),
};
