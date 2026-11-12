// The Effects by the name each intent persists: a kind of write outside the Execution Record that an Action makes, with
// its payload, how it is made and how it is found again at resume (GLOSSARY.md). Callers that make one hold its module;
// what reads an intent back from the record looks it up here, so an unknown name is held, never read as absent (N3).
import type * as integrityModule from '../integrity.ts';
import type * as record from '../record.ts';
import type * as writeAhead from '../write-ahead.ts';
import type * as comment from './comment.ts';
import type * as commit from './commit.ts';
import type * as label from './label.ts';
import type * as prReady from './pr-ready.ts';
import type * as prUpsert from './pr-upsert.ts';
import type * as push from './push.ts';
import type * as rescue from './rescue.ts';
import type * as reset from './reset.ts';

// Where a remote Effect lands, origin or GitHub, whose launch is retried on a backoff (lib/remote-effects.ts); null for
// one that is not remote.
export type Remote = 'origin' | 'GitHub' | null;

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
  refTarget(worktree: string, ref: string): Promise<string | null>;
}

// The gh verbs the finders call (lib/github.ts).
export interface EvidenceGh {
  findPr(branch: string, cwd?: string): Promise<{ number: number } | undefined>;
  viewPr(pr: number, cwd?: string): Promise<{ number: number; url: string; body: string }>;
  comments(issue: number, cwd?: string): Promise<{ id: number; body: string }[]>;
}

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
  | { status: 'found'; evidence: writeAhead.Evidence }
  | { status: 'conflicting'; reason: string }
  | { status: 'absent' }
  | { status: 'unknown'; error: unknown };
export type FindEffect = (entry: writeAhead.WriteAheadEntry, context: EvidenceContext) => Promise<FindResult>;

// What a worktree proof reads: the git verbs a reset's states take, and the Integrity Assertions' snapshots.
export interface ProofContext {
  git: reset.ResetGit;
  integrity: integrityModule.Integrity;
}

export interface Effect<Payload, Context> {
  // The name its intent persists, which existing State Databases hold (decision 4).
  name: string;
  remote: Remote;
  // Makes the effect from its payload; `redo` when an open intent is made again.
  perform: (context: Context, payload: Payload, launch: { redo: boolean }) => Promise<writeAhead.Evidence>;
  // How an open intent is settled at resume: found by its Action Marker, or safe to repeat. A reset has neither: it is
  // finished from the worktree before anything else (lib/effects/reset.ts).
  find?: FindEffect;
  repeatable?: true;
  // Whether the worktree as found is the state its open intent proves the agent's (ADR-0005).
  proves?: (entry: writeAhead.WriteAheadEntry, worktree: string, context: ProofContext) => Promise<boolean>;
}
// An Effect as the record names it: what Reconciliation and a remote retry read, without its perform.
export type Resumable = Omit<Effect<never, never>, 'perform'>;

// What an intent saves ahead of its effect, by its Effect: enough to redo the effect, or to find it done.
export type Payload =
  | commit.Payload
  | push.Payload
  | comment.Payload
  | prUpsert.Payload
  | prReady.Payload
  | label.Payload
  | rescue.Payload
  | reset.Payload;

// The last marker line wins (marker.parseMarker), so agent text that mimics a marker cannot complete an Action.
export const carries = (_text: string | null | undefined, _actionMarker: string): boolean => false;

export const found = (_evidence: writeAhead.Evidence): FindResult => ({ status: 'absent' });
export const conflicting = (_reason: string): FindResult => ({ status: 'absent' });
export const ABSENT: FindResult = { status: 'unknown', error: new Error('stub') };

// The eight Effects.
export const all = (): Resumable[] => [];

// The Effect an intent names, or undefined for an unknown name, a call's or none.
export const lookup = (_name: string | null): Resumable | undefined => undefined;

// Whether Reconciliation can settle an open intent of this effect: found by its finder, or safe to run again. Any other
// is held, never read as absent (N3, S6). A reset and a call are settled earlier and do not reach this.
export const recognised = (_name: string | null): boolean => false;

// An effect with no finder (a reset, a call or pr-ready) is absent.
export async function findEffect(_entry: writeAhead.WriteAheadEntry, _context: EvidenceContext): Promise<FindResult> {
  return { status: 'unknown', error: new Error('stub') };
}

// True when the worktree is in the state an open intent proves the agent's, for Reconciliation to finish the intent.
export async function proves(
  _entry: writeAhead.WriteAheadEntry,
  _worktree: string,
  _context: ProofContext,
): Promise<boolean> {
  return false;
}
