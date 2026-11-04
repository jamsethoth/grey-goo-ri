// The worktree admission runs a Ticket in: the branch checks that hold it, and the other ticket worktrees whose
// Integrity Assertions guard them against this Ticket's agent.
import { existsSync } from 'node:fs';
import * as paths from './paths.ts';
import type * as record from './record.ts';
import type * as runContext from './run-context.ts';

// The worktree a Ticket runs in, as admission asks for it.
export interface WorktreeRequest {
  ticket: number;
  mainRoot: string;
  path: string;
  branch: string;
  base: string;
}

// A hold, with what to do about it, or the worktree and a reader of every other ticket worktree.
export interface AdmittedWorktree {
  hold?: string;
  next?: string;
  worktree?: { path: string; branch: string };
  others?: () => Promise<string[]>;
}

// A worktree on another Ticket's branch would carry this Ticket's commits, pushes and PR there, and a resumed one must
// be on exactly the recorded branch.
export async function admitWorktree(
  executionRecord: record.ExecutionRecord | null,
  git: runContext.RunGit,
  { ticket, mainRoot, path, branch, base }: WorktreeRequest,
): Promise<AdmittedWorktree> {
  const prefix = `ticket/${ticket}-`;
  const wrong = (what: string, given: string) =>
    `${what} ${given}, but Ticket #${ticket} requires \`${prefix}*\`, ` +
    'so the Ticket is held; no agent ran and nothing was committed, pushed or discarded.';
  if (executionRecord && !executionRecord.branch.startsWith(prefix))
    return { hold: wrong('The Execution Record names branch', `\`${executionRecord.branch}\``) };
  if (existsSync(path)) {
    // A detached HEAD can equal the recorded commit during a rebase without owning its branch.
    const actual = await git.currentBranch(path);
    if (executionRecord && actual !== executionRecord.branch) {
      return {
        hold:
          `The worktree is on ${actual ?? 'detached HEAD'}, not the Execution Record's branch ` +
          `${executionRecord.branch}, so the Ticket is held; nothing was committed, pushed or discarded.`,
        next: `Switch the worktree back to \`${executionRecord.branch}\` or remove it`,
      };
    }
    if (!actual?.startsWith(prefix)) {
      return {
        hold: wrong('The worktree is on', actual === null ? 'detached HEAD' : `\`${actual}\``),
        next: `Switch the worktree back to a \`${prefix}*\` branch or remove it`,
      };
    }
  }
  const worktree = await git.ensureWorktree({ mainRoot, path, branch, base });
  // Read now so a list that cannot be read stops admission, and again for each Attempt: a parallel Ticket's worktree
  // may be created after this one is admitted.
  await otherWorktrees(git, mainRoot, worktree.path);
  return { worktree, others: () => otherWorktrees(git, mainRoot, worktree.path) };
}

const otherWorktrees = async (git: runContext.RunGit, mainRoot: string, own: string) =>
  (await git.listWorktrees(mainRoot))
    .filter((worktree) => /^ticket\/\d+-/.test(worktree.branch) && paths.pathKey(worktree.path) !== paths.pathKey(own))
    .map((worktree) => worktree.path);
