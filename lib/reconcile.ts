import * as record from './record.ts';
import type * as rescue from './rescue.ts';
import * as writeAhead from './write-ahead.ts';
import * as integrityModule from './integrity.ts';
import * as effectEvidence from './effect-evidence.ts';
import * as labels from './labels.ts';
import type * as visit from './visit.ts';

// The git verbs Reconciliation calls, beside those its default Integrity Assertions and the
// effect finders take.
export interface ReconcileGit extends integrityModule.IntegrityGit, effectEvidence.EvidenceGit {
  treeDiff(worktree: string, from: string, to: string): Promise<{ path: string; change: string }[]>;
  resetTo(worktree: string, sha: string): Promise<unknown>;
  conflictedPaths(worktree: string): Promise<string[]>;
  diffSummary(worktree: string): Promise<string>;
}

type Issue = { labels: { name: string }[] };
// The gh verbs Reconciliation calls, beside the effect finders' (lib/github.ts).
export interface ReconcileGh extends effectEvidence.EvidenceGh {
  labelNames(issue: Issue): string[];
  viewIssue(ticket: number, cwd?: string): Promise<Issue>;
}

// The parts of the Resolved Flow a record is checked against.
export interface ReconciledFlow {
  ticket: { vertices: Record<string, unknown> };
  procedures: Record<string, { hash: string } | undefined>;
}

type ResetPayload = visit.ResetPayload;

// What Reconciliation decides: continue at the cursor, hold the Ticket, or abandon it for a human's label.
export type HumanOverride = {
  next: 'abandon';
  cursor: record.Cursor;
  reason: string;
  inProgress: boolean;
};
type Hold = { next: 'hold'; cursor: record.Cursor | null; reason: string; name?: string; advice?: string };
export type ReconcileResult = { next: 'continue'; cursor: record.Cursor; reason: null } | Hold | HumanOverride;

type Database = Pick<record.StateDatabase, 'evidence' | 'complete'>;

// The Visit's result is a call held for cleanup (L11): what its worktree holds is for the suspended call's validation
// to judge (L15), once a later Run has confirmed its processes gone.
const heldForCleanup = (executionRecord: record.ExecutionRecord): boolean =>
  executionRecord.visitState?.settled?.resolution.row === 'cleanup-unconfirmed';

const ignoredOf = async (
  worktree: string,
  untracked: integrityModule.RollbackSet | undefined,
  integrity: integrityModule.Integrity,
) => (untracked ? integrity.ignoredFiles(worktree, integrityModule.withinOf(untracked)) : {});

// Where an open reset can be found: 'left' while the worktree is exactly as the agent left it, ignored Protected Files
// and tests included; 'cleaning' between git.resetTo's hard reset and its clean, the tracked files back and every
// untracked one as the agent left it; 'restoring' once the git reset landed, however far its restore of untracked files
// got, each rollback file being absent, as the agent left it or restored; null for anything else, which is a human's
// (ADR-0005).
async function resetState(
  worktree: string,
  { baseline, untracked, left }: ResetPayload,
  git: ReconcileGit,
  integrity: integrityModule.Integrity,
): Promise<'left' | 'cleaning' | 'restoring' | null> {
  const now = await integrity.snapshot(worktree);
  const tree = await git.treeOf(worktree, baseline);
  const hardReset = now.head === baseline && now.index === tree;
  if (hardReset && (await onlyRestored(worktree, { from: tree, to: now.tree, untracked, left }, git, integrity)))
    return 'restoring';
  // An intent saved before the index was fingerprinted proves nothing.
  if (!left?.index) return null;
  if (!integrityModule.sameFiles(left.files ?? {}, await ignoredOf(worktree, untracked, integrity))) return null;
  if (now.head === left.head && now.index === left.index && now.tree === left.tree) return 'left';
  return hardReset && (await onlyLeftBehind(worktree, { from: tree, to: now.tree, left: left.tree }, git))
    ? 'cleaning'
    : null;
}

// The flag-aware tree differs from the baseline only by added files, each as the tree the agent left has it.
async function onlyLeftBehind(
  worktree: string,
  { from, to, left }: { from: string; to: string; left: string },
  git: ReconcileGit,
): Promise<boolean> {
  const differs = new Set((await git.treeDiff(worktree, to, left)).map(({ path }) => path));
  return (await git.treeDiff(worktree, from, to)).every(({ path, change }) => change === 'added' && !differs.has(path));
}

// Each rollback file is absent, as the agent left it or restored, and the flag-aware tree differs from the baseline
// only by untracked files the restore has put back with their saved bytes.
async function onlyRestored(
  worktree: string,
  { from, to, untracked, left }: { from: string; to: string } & Pick<ResetPayload, 'untracked' | 'left'>,
  git: ReconcileGit,
  integrity: integrityModule.Integrity,
): Promise<boolean> {
  const saved = untracked?.files ?? {};
  const files = untracked ? await integrity.untrackedFiles(worktree, integrityModule.withinOf(untracked)) : {};
  const eachKnown = Object.entries(files).every(
    ([path, file]) =>
      integrityModule.sameFile(file, left?.files?.[path]) || integrityModule.sameFile(file, saved[path]),
  );
  if (!eachKnown) return false;
  if (from === to) return true;
  return (await git.treeDiff(worktree, from, to)).every(
    ({ path, change }) => change === 'added' && integrityModule.sameFile(files[path], saved[path]),
  );
}

// True when the worktree is in a state an open intent proves the agent's (ADR-0005), for Reconciliation to finish the
// intent: a reset's, a rescue's worktree as it found it, or a commit's recorded parent and the tree it staged. push,
// pr-upsert, pr-ready, comment and label leave the worktree alone and record none, so they prove no uncommitted change.
async function asRecorded(
  worktree: string,
  { effect, payload }: writeAhead.WriteAheadEntry,
  git: ReconcileGit,
  integrity: integrityModule.Integrity,
): Promise<boolean> {
  if (effect === 'reset') return (await resetState(worktree, payload as ResetPayload, git, integrity)) !== null;
  if (effect === 'rescue') {
    const { left } = payload as rescue.RescuePayload;
    const now = await integrity.snapshot(worktree);
    return now.head === left.head && now.index === left.index && now.tree === left.tree;
  }
  if (effect !== 'commit') return false;
  const { parent, tree } = payload as effectEvidence.CommitPayload;
  const now = await integrity.snapshot(worktree);
  return now.head === parent && now.index === tree && now.tree === tree;
}

// An open reset is made now while the worktree is as the agent left it or partway through it, where the reset changes
// no tracked file again, and its restore is replayed once the reset landed; restoreUntracked skips files already back.
// Anything else is a human's and Held, nothing discarded, and the History item waits in the intent.
export async function resets(
  executionRecord: record.ExecutionRecord,
  {
    git,
    integrity = integrityModule.createIntegrity(git),
    database = record,
  }: { git: ReconcileGit; integrity?: integrityModule.Integrity; database?: Database },
): Promise<'held' | 'continue'> {
  for (const entry of writeAhead.openIntents(executionRecord).filter((intent) => intent.effect === 'reset')) {
    if (!writeAhead.evidenceOf(executionRecord, entry.actionMarker)) {
      const payload = entry.payload as ResetPayload;
      let state = await resetState(executionRecord.worktree, payload, git, integrity);
      if (state === 'left' || state === 'cleaning') {
        await git.resetTo(executionRecord.worktree, payload.baseline);
        state = await resetState(executionRecord.worktree, payload, git, integrity);
      }
      if (state !== 'restoring') return 'held';
      if (payload.untracked) await integrity.restoreUntracked(executionRecord.worktree, payload.untracked);
      const head = await git.headSha(executionRecord.worktree);
      executionRecord.history.push(payload.history);
      await database.evidence(executionRecord, entry.actionMarker, { head });
    }
    await database.complete(executionRecord, entry.actionMarker);
  }
  return 'continue';
}

// Uncommitted changes at Ticket start that no open intent proves the agent's are unknown dirty state, returned with
// their diff stat for the hold and left untouched (ADR-0005). Null when the worktree is clean, or exactly as an open
// intent recorded it, which Reconciliation then finishes.
export async function dirtyState(
  executionRecord: record.ExecutionRecord | null,
  {
    git,
    worktree,
    locks,
    integrity = integrityModule.createIntegrity(git, undefined, locks),
  }: {
    git: ReconcileGit;
    worktree: string;
    locks?: Parameters<typeof integrityModule.createIntegrity>[2];
    integrity?: integrityModule.Integrity;
  },
): Promise<{ conflicts: string[]; stat: string; rescueRef: string | null } | null> {
  // git write-tree refuses unmerged entries, so a merge conflict cannot be fingerprinted: it is never the agent's.
  const conflicts = await git.conflictedPaths(worktree);
  const unmerged = conflicts.length > 0;
  if (!unmerged && executionRecord && heldForCleanup(executionRecord)) return null;
  if (!unmerged && (await integrity.isCleanAt(worktree))) return null;
  for (const entry of !unmerged && executionRecord ? writeAhead.openIntents(executionRecord) : [])
    if (await asRecorded(worktree, entry, git, integrity)) return null;
  const untracked = await git.untrackedPaths(worktree);
  const intended = executionRecord && writeAhead.openRescue(executionRecord);
  return {
    conflicts,
    rescueRef: intended && (await git.refTarget(worktree, intended.ref)) === intended.commit ? intended.ref : null,
    stat: (await git.diffSummary(worktree)) + untracked.map((path) => ` ${path} (untracked)\n`).join(''),
  };
}

// A needs-human label a human set overrides the Execution Record, which the abandonment Terminal keeps but marks
// abandoned.
export async function humanOverride(
  executionRecord: record.ExecutionRecord,
  issueLabels: string[],
  labelPrefix: string = labels.DEFAULT_PREFIX,
): Promise<HumanOverride | null> {
  const state = labels.labelsFor(labelPrefix).state;
  const needsHuman = state(labels.NEEDS_HUMAN);
  // A needs-human Terminal that crashed after its label Action shows gg's own label, not a human's.
  const own = executionRecord.writeAheadLog.some(
    (entry) =>
      entry.step === 'intent' &&
      entry.effect === 'label' &&
      labels.hasLabel((entry.payload as effectEvidence.LabelPayload).add, needsHuman),
  );
  if (own || !labels.hasLabel(issueLabels, needsHuman)) return null;
  return {
    next: 'abandon',
    cursor: executionRecord.cursor,
    reason: `#${executionRecord.ticket} carries ${needsHuman} on GitHub, which overrides the record.`,
    inProgress: labels.hasLabel(issueLabels, state('in-progress')),
  };
}

// Saves the evidence of each open intent whose effect its marker shows; the interpreter completes the Action with its
// Event. Returns the first conflict's reason, if any; an unknown lookup throws its error. `find` defaults to
// findEffect; the interpreter passes one that retries a failed remote lookup on the Action's budget.
async function findEffects(
  entries: writeAhead.WriteAheadEntry[],
  context: effectEvidence.EvidenceContext & { database: Database },
  find: effectEvidence.FindEffect = effectEvidence.findEffect,
): Promise<string | null> {
  for (const entry of entries) {
    if (writeAhead.evidenceOf(context.executionRecord, entry.actionMarker)) continue;
    if (!effectEvidence.recognised(entry.effect))
      return (
        `The intent of Action Marker ${entry.actionMarker} names the effect ${entry.effect}, which this gg does not ` +
        'recognise, so whether it happened cannot be told; nothing was run or discarded.'
      );
    const result = await find(entry, context);
    if (result.status === 'unknown') throw result.error;
    if (result.status === 'conflicting') return result.reason;
    if (result.status === 'found')
      await context.database.evidence(context.executionRecord, entry.actionMarker, result.evidence);
  }
  return null;
}

// A decided hold, fault or abandonment only finishes its report: a human override still wins, and only the intents of
// its own Terminal Actions (`markers`) are looked for, so no older Action's effect is redone, checked or read.
export async function terminalEffects(
  executionRecord: record.ExecutionRecord,
  {
    gh,
    labelPrefix = labels.DEFAULT_PREFIX,
    cwd,
    markers,
    find,
    database = record,
  }: {
    gh: ReconcileGh;
    labelPrefix?: string;
    cwd?: string;
    markers: string[];
    find?: effectEvidence.FindEffect;
    database?: Database;
  },
): Promise<ReconcileResult> {
  const issueLabels = gh.labelNames(await gh.viewIssue(executionRecord.ticket, cwd));
  const overridden = await humanOverride(executionRecord, issueLabels, labelPrefix);
  if (overridden) return overridden;
  // Its comment and label finders cannot conflict; were one to, the report would stay pending for a human.
  const conflict = await findEffects(
    writeAhead.openIntents(executionRecord).filter((entry) => markers.includes(entry.actionMarker)),
    { executionRecord, gh, cwd, issueLabels, database },
    find,
  );
  if (conflict) throw new Error(conflict);
  return { next: 'continue', cursor: executionRecord.cursor, reason: null };
}

export const INTERRUPTED_ADVICE =
  'The agent may have changed files before gg stopped, including ignored Protected Files. Check ' +
  "them, and restore any it changed, before deleting the record: the Attempt's intent in " +
  'the record saves the baseline, with the bytes of each untracked Protected File. ' +
  'Or keep the Ticket held until gg can recover Interrupted Attempts (#68).';

// A Ticket's row as admission loads it: its Execution Record (null when it has none), or the error that makes the row
// unreadable, which Reconciliation holds for a human.
export type LoadedRecord =
  | { executionRecord: record.ExecutionRecord | null; corrupt: null }
  | { executionRecord: null; corrupt: record.RecordCorruptError };

export async function loadExecutionRecord(commonDir: string, ticket: number): Promise<LoadedRecord> {
  try {
    return { executionRecord: await record.load(commonDir, 'ticket', ticket), corrupt: null };
  } catch (err) {
    if (err instanceof record.RecordCorruptError) return { executionRecord: null, corrupt: err };
    throw err;
  }
}

export type ReconcileOptions = ({ record: record.ExecutionRecord } | { corrupt: record.RecordCorruptError }) & {
  flow: ReconciledFlow;
  git: ReconcileGit;
  integrity?: integrityModule.Integrity;
  gh: ReconcileGh;
  labelPrefix?: string;
  cwd?: string;
  find?: effectEvidence.FindEffect;
  database?: Database;
};

// Labels decide whether an Execution continues, the record where (request 3.5). The record is never discarded.
export async function reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  if ('corrupt' in options)
    return { next: 'hold', cursor: null, reason: `${options.corrupt.message}; it is kept for a human.` };
  const {
    record: executionRecord,
    flow,
    git,
    integrity,
    gh,
    labelPrefix = labels.DEFAULT_PREFIX,
    cwd,
    find,
    database = record,
  } = options;
  const issueLabels = gh.labelNames(await gh.viewIssue(executionRecord.ticket, cwd));
  const overridden = await humanOverride(executionRecord, issueLabels, labelPrefix);
  if (overridden) return overridden;
  const held = configurationHold(executionRecord, flow);
  if (held) return held;
  const hold = (reason: string): Hold => ({ next: 'hold', cursor: executionRecord.cursor, reason });
  if ((await resets(executionRecord, { git, integrity, database })) === 'held') {
    // A rescue's reset is intended only once its ref holds the work.
    const rescue = writeAhead.openRescue(executionRecord);
    return hold(
      'An interrupted reset did not leave the worktree clean at its baseline; nothing was discarded.' +
        (rescue ? ` Rescue Ref ${rescue.ref} keeps the work rescued before it.` : ''),
    );
  }
  const conflict = await findEffects(
    writeAhead.openIntents(executionRecord),
    { executionRecord, git, gh, cwd, issueLabels, database },
    find,
  );
  if (conflict) return hold(conflict);
  // A completed commit has no open intent to check, and an amend keeps its marker: only the branch tip shows the
  // change.
  const last = writeAhead.lastCommit(executionRecord);
  const head = last && (await git.headSha(executionRecord.worktree));
  if (last && head !== last.evidence!.sha) {
    return hold(
      `The branch is at ${head}, not at commit ${last.evidence!.sha} of Action Marker ${last.actionMarker}, ` +
        'so it was changed by hand; nothing was committed, pushed or discarded.',
    );
  }
  return { next: 'continue', cursor: executionRecord.cursor, reason: null };
}

// The holds that need no git: an Interrupted Attempt, a Vertex the Flow no longer has, or a Visit whose Procedure
// changed since it entered.
function configurationHold(executionRecord: record.ExecutionRecord, flow: ReconciledFlow): Hold | null {
  const { vertex } = executionRecord.cursor;
  const hold = (reason: string): Hold => ({ next: 'hold', cursor: executionRecord.cursor, reason });
  // An Interrupted Attempt is held however clean the worktree looks: what its agent changed is not known (ADR 0011).
  // Deleting the record would drop the baseline its intent saved, so the advice says to check the files first.
  const interrupted = writeAhead.openIntents(executionRecord).find((entry) => entry.effect === 'call');
  if (interrupted) {
    return {
      ...hold(
        `The agent Attempt of Action Marker ${interrupted.actionMarker} was interrupted, ` +
          'so the Ticket is held; nothing was discarded.',
      ),
      name: 'interrupted-attempt',
      advice: INTERRUPTED_ADVICE,
    };
  }
  if (!(labels.END_STATES as string[]).includes(vertex) && !flow.ticket.vertices[vertex])
    return hold(`The record continues at Vertex ${vertex}, which the Flow no longer has.`);
  // A Visit in progress runs on the Procedure it entered with, so one whose Procedure has changed is held, not resumed
  // (S6).
  const configurationSnapshot = executionRecord.configurationSnapshot;
  if (
    executionRecord.cursor.action !== null &&
    configurationSnapshot?.vertex === vertex &&
    flow.procedures[configurationSnapshot.procedure.name]?.hash !== configurationSnapshot.procedure.hash
  ) {
    return hold(
      `The Visit in progress at Vertex ${vertex} entered with Procedure ${configurationSnapshot.procedure.name} ` +
        'as it was then, and the configuration has changed it since; nothing was run or discarded.',
    );
  }
  return null;
}
