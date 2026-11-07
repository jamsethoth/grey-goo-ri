import * as nodeFs from 'node:fs/promises';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as locksModule from './locks.ts';
import * as paths from './paths.ts';
import * as record from './record.ts';

// A worktree's checked surfaces: HEAD, the index's tree, and the flag-aware tree of everything in it (git.fingerprint).
export interface WorktreeSnapshot {
  head: string;
  index: string;
  tree: string;
}
export type Surface = keyof WorktreeSnapshot;

// An untracked file's content, which git keeps no copy of: a link's target, or the bytes in base64.
export type UntrackedFile = { link: string; base64?: undefined } | { base64: string; link?: undefined };
export type UntrackedFiles = Record<string, UntrackedFile>;

// What a listing is limited to: `paths` and anything under them, `globs`, less `exclude` (git.pathspecs). An array is
// the pathspecs a reset intent saved before #144.
export type Within = { paths?: string[]; globs?: string[]; exclude?: string[] } | string[];

// What git clean leaves that a rollback must put back: the baseline's untracked files, and where to look for new ones.
// `pathspecs` stands in for `within` in a reset intent saved before #144.
export interface RollbackSet {
  files: UntrackedFiles;
  within?: Within;
  pathspecs?: string[];
}

// Another worktree's snapshot, taken while it was idle at that activity generation.
export interface IdleSnapshot {
  generation: number;
  snapshot: WorktreeSnapshot;
}

// What an agent Attempt starts from (takeBaseline), saved in its call intent: its own worktree's snapshot, the idle
// others', and the untracked Protected Files and tests a rollback restores.
export interface IntegrityBaseline {
  head: string;
  own: WorktreeSnapshot;
  idle: Record<string, IdleSnapshot>;
  untracked: UntrackedFiles;
  tests: UntrackedFiles;
}

// A failed Integrity Assertion: a surface that moved, the Protected Files the Attempt touched, or the committed tests
// it changed (Test Immutability, R3).
export type IntegrityViolation =
  | { worktree: string; surface: Surface; before: string; after: string }
  | { worktree: string; surface: 'protected' | 'committed tests'; before: null; after: string[] };

// The git verbs the Integrity Assertions call: lib/git.ts's, or the fake git's in the unit tier.
export interface IntegrityGit {
  commonDir(worktree: string): Promise<string>;
  fingerprint(worktree: string): Promise<WorktreeSnapshot>;
  treeOf(worktree: string, commit?: string): Promise<string>;
  untrackedPaths(
    worktree: string,
    options?: { include?: 'unignored' | 'ignored' | 'all'; within?: Within },
  ): Promise<string[]>;
  changedPaths(worktree: string, from: string, to: string, within?: Within): Promise<string[]>;
}

// A virus scanner or an indexer holding a file for a moment raises EBUSY or EPERM on Windows; fs.rm retries those only
// when asked.
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

type RepoLocks = Pick<locksModule.Locks, 'withLock'>;
// The writes restoreUntracked makes: node:fs/promises', or a test's that crashes one of them.
export type RestoreFs = Pick<typeof nodeFs, 'lstat' | 'rm' | 'mkdir' | 'symlink' | 'writeFile'>;
// The worktree an Attempt runs in, and the repository whose records say which other worktrees are busy.
type AttemptWorktree = Pick<record.ExecutionRecord, 'worktree' | 'commonDir'>;

// A fingerprint writes objects, so a snapshot waits for the repo lock like every other git write (request 3.5).
export async function snapshot(
  worktree: string,
  git: IntegrityGit,
  locks: RepoLocks = locksModule,
): Promise<WorktreeSnapshot> {
  return locks.withLock(await git.commonDir(worktree), 'repo', () => git.fingerprint(worktree), {
    timeoutMs: locksModule.REPO_LOCK_TIMEOUT_MS,
  });
}

async function flip(
  executionRecord: record.ExecutionRecord,
  busy: boolean,
  database: Pick<record.StateDatabase, 'save'> = record,
): Promise<void> {
  executionRecord.activity = { busy, generation: executionRecord.activity.generation + 1 };
  await database.save(executionRecord);
}

// Clean at HEAD: neither the index nor the flag-aware tree differs from it. Unlike git status this sees edits that
// assume-unchanged hides, which reset --hard would still overwrite.
export async function isCleanAt(worktree: string, git: IntegrityGit, locks?: RepoLocks): Promise<boolean> {
  const worktreeSnapshot = await snapshot(worktree, git, locks);
  const tree = await git.treeOf(worktree);
  return worktreeSnapshot.tree === tree && worktreeSnapshot.index === tree;
}

export const markBusy = (executionRecord: record.ExecutionRecord, database?: Pick<record.StateDatabase, 'save'>) =>
  flip(executionRecord, true, database);
// Never once a call's cleanup is unconfirmed: a writer may still be running there, so other Tickets' Integrity
// Assertions must keep off it (L11), whichever wait or report asks.
export const markIdle = async (
  executionRecord: record.ExecutionRecord,
  database?: Pick<record.StateDatabase, 'save'>,
) => {
  if (!executionRecord.visitState?.unconfirmedCleanup) await flip(executionRecord, false, database);
};

export async function readActivity(
  commonDir: string,
  worktreePath: string,
): Promise<record.ExecutionRecord['activity']> {
  const owner = (await record.loadAll(commonDir, 'ticket')).find(
    (executionRecord) => paths.pathKey(executionRecord.worktree) === paths.pathKey(worktreePath),
  );
  return owner?.activity ?? { busy: false, generation: 0 };
}

// The snapshot counts only if the worktree was idle and no transition happened while it was taken.
async function idleSnapshot(
  commonDir: string,
  worktree: string,
  git: IntegrityGit,
  locks?: RepoLocks,
): Promise<IdleSnapshot | null> {
  const first = await readActivity(commonDir, worktree);
  if (first.busy) return null;
  const stable = (second: record.ExecutionRecord['activity']) => !second.busy && second.generation === first.generation;
  let worktreeSnapshot;
  try {
    worktreeSnapshot = await snapshot(worktree, git, locks);
  } catch (err) {
    // A worktree that turned busy mid-snapshot may be in a state git cannot fingerprint; only a stable idle failure is
    // ours.
    if (!stable(await readActivity(commonDir, worktree))) return null;
    throw err;
  }
  return stable(await readActivity(commonDir, worktree))
    ? { generation: first.generation, snapshot: worktreeSnapshot }
    : null;
}

// A rollback set's paths: `within`, or the git pathspecs a reset intent saved before #144, which git.ts still takes.
export const withinOf = (set: RollbackSet): Within | undefined => set.within ?? set.pathspecs;

// No paths named: an empty { paths, globs, exclude } or an empty saved pathspec array.
const none = (within: Within | undefined) =>
  !within || Object.values(within).every((value: string | string[] | undefined) => !value?.length);

// Untracked files `within` the given paths with their content, ignored ones included: git keeps no copy, so a rollback
// restores from this. Base64, so the copy can be saved in a reset intent and survive a crash.
export async function untrackedFiles(
  worktree: string,
  within: Within | undefined,
  git: IntegrityGit,
  include: 'all' | 'ignored' = 'all',
): Promise<UntrackedFiles> {
  if (none(within)) return {};
  // Ignored ones too: an ignored Protected File is still agent configuration, and an ignored test still runs.
  const untrackedPaths = await git.untrackedPaths(worktree, { include, within });
  const files: UntrackedFiles = {};
  for (const path of untrackedPaths) {
    const full = join(worktree, path);
    files[path] = (await lstat(full)).isSymbolicLink()
      ? { link: await readlink(full) }
      : { base64: (await readFile(full)).toString('base64') };
  }
  return files;
}

// The ignored ones alone: the snapshot tree already covers the rest, and git clean removes them.
export const ignoredFiles = (worktree: string, within: Within | undefined, git: IntegrityGit) =>
  untrackedFiles(worktree, within, git, 'ignored');

const untrackedProtected = (worktree: string, protectedPaths: string[], git: IntegrityGit) =>
  untrackedFiles(worktree, { paths: protectedPaths }, git);

export const sameFile = (first: UntrackedFile | undefined, second: UntrackedFile | undefined): boolean =>
  !!first && !!second && first.link === second.link && first.base64 === second.base64;
export const sameFiles = (first: UntrackedFiles, second: UntrackedFiles): boolean =>
  Object.keys(first).length === Object.keys(second).length &&
  Object.keys(first).every((path) => sameFile(first[path], second[path]));

// `testPaths` is { globs, exclude } for the test files.
export async function takeBaseline({
  record: executionRecord,
  others,
  protectedPaths = [],
  testPaths,
  git,
  locks,
}: {
  record: AttemptWorktree;
  others: string[];
  protectedPaths?: string[];
  testPaths?: Within;
  git: IntegrityGit;
  locks?: RepoLocks;
}): Promise<IntegrityBaseline> {
  const own = await snapshot(executionRecord.worktree, git, locks);
  const idle: Record<string, IdleSnapshot> = {};
  for (const worktree of others) {
    const otherSnapshot = await idleSnapshot(executionRecord.commonDir, worktree, git, locks);
    if (otherSnapshot) idle[worktree] = otherSnapshot;
  }
  return {
    head: own.head,
    own,
    idle,
    untracked: await untrackedProtected(executionRecord.worktree, protectedPaths, git),
    tests: await untrackedFiles(executionRecord.worktree, testPaths, git),
  };
}

// What git clean leaves that a rollback must put back: the untracked Protected Files and tests of the baseline, and
// where to look for new ones. Ignored files outside these paths are neither detected nor rolled back (request 3.5).
export const rollbackSet = (
  baseline: Pick<IntegrityBaseline, 'untracked' | 'tests'>,
  protectedPaths: string[],
  { globs, exclude }: { globs?: string[]; exclude?: string[] },
): RollbackSet => ({
  files: { ...baseline.untracked, ...baseline.tests },
  within: { paths: protectedPaths, globs, exclude },
});

// The agent may have swapped a directory for a link (or junction) out of the worktree, and git lists the files behind
// a junction as the worktree's, so deleting or writing through one would change files outside. rm removes the link
// itself, never its target. A plain file in a directory's place is cleared too, so the restore can recreate the
// directory. True when something was removed: nothing under it is in the worktree any more.
async function unlinkParents(worktree: string, path: string, fs: RestoreFs): Promise<boolean> {
  let directory = worktree;
  for (const part of path.split('/').slice(0, -1)) {
    directory = join(directory, part);
    const stats = await fs.lstat(directory).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!stats) return false;
    if (!stats.isDirectory()) {
      await fs.rm(directory, RM_OPTIONS);
      return true;
    }
  }
  return false;
}

// git clean keeps ignored files, so after a reset a rollbackSet is put back by hand: links over the baseline's
// directories replaced first, then new files removed, then changed or deleted ones rewritten against a fresh listing.
// `fs` is node:fs/promises, or a test's that crashes one of these writes.
export async function restoreUntracked(
  worktree: string,
  set: RollbackSet,
  git: IntegrityGit,
  fs: RestoreFs = nodeFs,
): Promise<void> {
  const { files: untracked } = set;
  const within = withinOf(set);
  for (const path of Object.keys(untracked)) await unlinkParents(worktree, path, fs);
  for (const path of Object.keys(await untrackedFiles(worktree, within, git))) {
    if (!untracked[path] && !(await unlinkParents(worktree, path, fs))) await fs.rm(join(worktree, path), RM_OPTIONS);
  }
  const now = await untrackedFiles(worktree, within, git);
  for (const [path, file] of Object.entries(untracked)) {
    if (sameFile(file, now[path])) continue;
    const full = join(worktree, path);
    await fs.rm(full, RM_OPTIONS);
    await fs.mkdir(dirname(full), { recursive: true });
    await (file.link !== undefined
      ? fs.symlink(file.link, full)
      : fs.writeFile(full, Buffer.from(file.base64, 'base64')));
  }
}

type TakeBaselineOptions = Omit<Parameters<typeof takeBaseline>[0], 'git' | 'locks'>;
type FindViolationsOptions = Omit<Parameters<typeof findViolations>[0], 'git' | 'locks'>;

// The Integrity Assertions over an injected git, in the shape the interpreter and Reconciliation call. `fs` reaches
// restoreUntracked, and `locks` (locks.createLocks) times and sees each snapshot's wait for the repo lock.
export const createIntegrity = (git: IntegrityGit, fs?: RestoreFs, locks?: RepoLocks) => ({
  snapshot: (worktree: string) => snapshot(worktree, git, locks),
  isCleanAt: (worktree: string) => isCleanAt(worktree, git, locks),
  untrackedFiles: (worktree: string, within: Within | undefined) => untrackedFiles(worktree, within, git),
  ignoredFiles: (worktree: string, within: Within | undefined) => ignoredFiles(worktree, within, git),
  restoreUntracked: (worktree: string, set: RollbackSet) => restoreUntracked(worktree, set, git, fs),
  takeBaseline: (options: TakeBaselineOptions) => takeBaseline({ ...options, git, locks }),
  findViolations: (options: FindViolationsOptions) => findViolations({ ...options, git, locks }),
});
// The Integrity Assertions a Run is given: createIntegrity's, or the fake integrity's in the unit tier.
export type Integrity = ReturnType<typeof createIntegrity>;

const diffSurfaces = (
  worktree: string,
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
  surfaces: Surface[],
): IntegrityViolation[] =>
  surfaces
    .filter((surface) => before[surface] !== after[surface])
    .map((surface) => ({ worktree, surface, before: before[surface], after: after[surface] }));

export async function findViolations({
  baseline,
  record: executionRecord,
  others,
  access,
  protectedPaths,
  git,
  locks,
}: {
  baseline: IntegrityBaseline;
  record: AttemptWorktree;
  others: string[];
  access: string;
  protectedPaths: string[];
  git: IntegrityGit;
  locks?: RepoLocks;
}): Promise<{ violations: IntegrityViolation[] }> {
  const worktree = executionRecord.worktree;
  const own = await snapshot(worktree, git, locks);
  const violations = diffSurfaces(
    worktree,
    baseline.own,
    own,
    access === 'read-only' ? ['head', 'index', 'tree'] : ['head', 'index'],
  );

  // Against the fingerprint tree, not the real index, so index flags cannot hide an edit.
  const changed = await git.changedPaths(worktree, baseline.head, own.tree, { paths: protectedPaths });
  // Untracked Protected Files that were already there and are unchanged are the owner's, not the agent's.
  const before = baseline.untracked ?? {};
  const now = await untrackedProtected(worktree, protectedPaths, git);
  const untracked = [...Object.keys(now), ...Object.keys(before)].filter((path) => !sameFile(before[path], now[path]));
  const touched = [...new Set([...changed, ...untracked].filter(Boolean))];
  if (touched.length) violations.push({ worktree, surface: 'protected', before: null, after: touched });

  for (const other of others) {
    const start = baseline.idle[other];
    if (!start) continue;
    const otherNow = await idleSnapshot(executionRecord.commonDir, other, git, locks);
    if (!otherNow || otherNow.generation !== start.generation) continue;
    violations.push(...diffSurfaces(other, start.snapshot, otherNow.snapshot, ['head', 'index', 'tree']));
  }
  return { violations };
}
