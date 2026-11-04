// Effect Evidence: an open intent's side effect looked for by its Action Marker, in git or on GitHub, so Reconciliation
// and a remote retry can tell an effect that landed from one to redo (request 3.5). Each kind with a finder is listed
// in FINDERS.
import * as config from './config.ts';
import type * as effectActions from './effect-actions.ts';
import * as labels from './labels.ts';
import * as marker from './marker.ts';
import type * as record from './record.ts';
import type * as writeAhead from './write-ahead.ts';

// The git verbs the finders call (lib/git.ts).
export interface EvidenceGit {
  headSha(worktree: string): Promise<string>;
  branchHead(worktree: string, branch: string): Promise<string>;
  remoteSha(worktree: string, branch: string): Promise<string | null>;
  hasTree(worktree: string, tree: string): Promise<boolean>;
  commitLog(
    worktree: string,
    branch: string,
  ): Promise<{ sha: string; parents: string[]; tree: string; message: string }[]>;
}

// The gh verbs the finders call (lib/github.ts).
export interface EvidenceGh {
  findPr(branch: string, cwd?: string): Promise<{ number: number } | undefined>;
  viewPr(pr: number, cwd?: string): Promise<{ number: number; url: string; body: string }>;
  comments(issue: number, cwd?: string): Promise<{ id: number; body: string }[]>;
}

// The intent payloads the finders read, as the Actions (lib/effect-actions.ts) and the Terminals write them.
// shortcut: a Terminal's label payload is declared by its reader; move it to lib/terminal-report.ts when that changes.
export type CommitPayload = Pick<effectActions.CommitPayload, 'parent' | 'tree'>;
type PushPayload = effectActions.PushPayload;
type PrUpsertPayload = Pick<effectActions.PrUpsertPayload, 'branch' | 'bodyHash'>;
type CommentPayload = Pick<effectActions.CommentPayload, 'target'>;
export type LabelPayload = { add: string[]; remove: string[] };

// What a finder reads. terminalEffects looks only for comment and label intents, so it passes no git.
export interface EvidenceContext {
  executionRecord: record.ExecutionRecord;
  git?: EvidenceGit;
  gh?: EvidenceGh;
  cwd?: string;
  issueLabels: string[];
}
// An open intent's effect: found (its evidence completes it), conflicting (a hold), absent (to be redone), or unknown
// when the lookup threw, which never counts as absent.
export type FindResult =
  | { status: 'found'; evidence: Record<string, unknown> }
  | { status: 'conflicting'; reason: string }
  | { status: 'absent' }
  | { status: 'unknown'; error: unknown };
export type FindEffect = (entry: writeAhead.WriteAheadEntry, context: EvidenceContext) => Promise<FindResult>;

// The last marker line wins (marker.parseMarker), so agent text that mimics a marker cannot complete an Action.
export const carries = (text: string | null | undefined, actionMarker: string): boolean => {
  const parts = marker.parseMarker(text);
  return !!parts && marker.formatMarker(parts) === actionMarker;
};

const found = (evidence: Record<string, unknown>): FindResult => ({ status: 'found', evidence });
const conflicting = (reason: string): FindResult => ({ status: 'conflicting', reason });
const ABSENT: FindResult = { status: 'absent' };
const FINDERS: Record<string, FindEffect | undefined> = {
  async commit({ actionMarker, payload }, { executionRecord, git }) {
    const { parent, tree: intendedTree } = payload as CommitPayload;
    for (const { sha, parents, tree, message } of await git!.commitLog(
      executionRecord.worktree,
      executionRecord.branch,
    )) {
      if (!carries(message, actionMarker)) continue;
      if (parents.length === 1 && parents[0] === parent && tree === intendedTree) return found({ sha });
      return conflicting(
        `Commit ${sha} carries the Action Marker ${actionMarker} but not the intended parent and tree, ` +
          'so it was changed by hand; nothing was committed or discarded.',
      );
    }
    // The commit is redone from the recorded tree on the recorded parent, so both must still be there.
    const head = await git!.headSha(executionRecord.worktree);
    if (head !== parent || !(await git!.hasTree(executionRecord.worktree, intendedTree))) {
      return conflicting(
        `The commit of Action Marker ${actionMarker} was not made and the branch is no longer at its intended parent ` +
          'and tree; nothing was committed or discarded.',
      );
    }
    return ABSENT;
  },
  async push({ actionMarker, payload }, { executionRecord, git }) {
    const { branch, sha } = payload as PushPayload;
    if ((await git!.remoteSha(executionRecord.worktree, branch)) === sha) return found({ remoteSha: sha });
    const head = await git!.branchHead(executionRecord.worktree, branch);
    if (head !== sha)
      return conflicting(
        `The push of Action Marker ${actionMarker} was not made and ${branch} has moved from ${sha} to ${head}; ` +
          'nothing was pushed.',
      );
    return ABSENT;
  },
  async 'pr-upsert'({ actionMarker, payload }, { executionRecord, gh, cwd }) {
    const { branch, bodyHash } = payload as PrUpsertPayload;
    const listed = await gh!.findPr(branch, cwd);
    if (!listed) return ABSENT;
    const pr = await gh!.viewPr(listed.number, cwd);
    if (!carries(pr.body, actionMarker) || config.sha256(pr.body) !== bodyHash) return ABSENT;
    executionRecord.pr = pr.number;
    return found({ number: pr.number, url: pr.url });
  },
  async comment({ actionMarker, payload }, { gh, cwd }) {
    const { target } = payload as CommentPayload;
    const posted = (await gh!.comments(target.number, cwd)).find((comment) => carries(comment.body, actionMarker));
    return posted ? found({ id: posted.id }) : ABSENT;
  },
  async label({ payload }, { issueLabels }) {
    const { add, remove } = payload as LabelPayload;
    const shown =
      add.every((label) => labels.has(issueLabels, label)) && remove.every((label) => !labels.has(issueLabels, label));
    return shown ? found({ ok: true }) : ABSENT;
  },
};

// An effect with no finder (a reset, a call or pr-ready) is absent.
export async function findEffect(entry: writeAhead.WriteAheadEntry, context: EvidenceContext): Promise<FindResult> {
  try {
    return (await FINDERS[String(entry.effect)]?.(entry, context)) ?? ABSENT;
  } catch (error) {
    return { status: 'unknown', error };
  }
}
