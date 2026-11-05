// Integrity snapshots without fingerprinting, for tests whose subject is not git behaviour. A snapshot is fixed values;
// `write` and `commit` stand in for an agent changing a worktree, so a test can script a violation. What reads only
// files and git (the untracked files a baseline records and a rollback restores, and Test Immutability) is lib's own
// over the given git, the fake git in the unit tier. test/contract/integrity/ runs this and lib/integrity.ts against
// the same cases, so the violations it reports keep the real shape.
import * as checks from '../../lib/checks.ts';
import * as integrityModule from '../../lib/integrity.ts';
import type * as runContext from '../../lib/run-context.ts';

type Snapshot = integrityModule.WorktreeSnapshot;
type Surface = integrityModule.Surface;

interface WorktreeState extends Snapshot {
  headTree: string;
  written: string[];
  from: number;
}

const TREE = '0'.repeat(40);

const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const isProtected = (path: string, protectedPaths: string[]) =>
  protectedPaths.some((protectedPath) => {
    const bare = fold(protectedPath.replace(/\/+$/, ''));
    return fold(path) === bare || fold(path).startsWith(`${bare}/`);
  });
const diff = (worktree: string, before: Snapshot, after: Snapshot, surfaces: Surface[]) =>
  surfaces
    .filter((surface) => before[surface] !== after[surface])
    .map((surface) => ({ worktree, surface, before: before[surface], after: after[surface] }));

// Each worktree's fixed snapshot values, made on first use with every worktree at `head`.
function worktreeStates(head: string) {
  const worktrees = new Map<string, WorktreeState>();
  const state = (worktree: string): WorktreeState => {
    const known = worktrees.get(worktree);
    if (known) return known;
    const fresh = { head, headTree: TREE, index: TREE, tree: TREE, written: [], from: 0 };
    worktrees.set(worktree, fresh);
    return fresh;
  };
  const snapshot = async (worktree: string): Promise<Snapshot> => {
    const { head: headSha, index, tree } = state(worktree);
    return { head: headSha, index, tree };
  };
  return { state, snapshot };
}

type BeginOptions = Parameters<integrityModule.Integrity['begin']>[0];
type EndOptions = Parameters<integrityModule.Integrity['end']>[0];

function assertions(
  { state, snapshot }: ReturnType<typeof worktreeStates>,
  git: integrityModule.IntegrityGit,
): integrityModule.Integrity {
  return {
    snapshot,
    isCleanAt: async (worktree) => {
      const { tree, index, headTree } = state(worktree);
      return tree === headTree && index === headTree;
    },
    untrackedFiles: (worktree, within) => integrityModule.untrackedFiles(worktree, within, git),
    ignoredFiles: (worktree, within) => integrityModule.ignoredFiles(worktree, within, git),
    restoreUntracked: (worktree, set) => integrityModule.restoreUntracked(worktree, set, git),
    async begin({ record: executionRecord, others, testPaths }: BeginOptions) {
      const own = await snapshot(executionRecord.worktree);
      const idle: integrityModule.IntegrityBaseline['idle'] = {};
      for (const other of others) idle[other] = { generation: 0, snapshot: await snapshot(other) };
      state(executionRecord.worktree).from = state(executionRecord.worktree).written.length;
      const tests = await integrityModule.untrackedFiles(executionRecord.worktree, testPaths, git);
      return { head: own.head, own, idle, untracked: {}, tests };
    },
    // Protected writes count from the last begin: an Attempt's end always follows its own begin.
    async end({ baseline, record: executionRecord, others, access, protectedPaths }: EndOptions) {
      const worktree = executionRecord.worktree;
      const surfaces: Surface[] = access === 'read-only' ? ['head', 'index', 'tree'] : ['head', 'index'];
      const violations: integrityModule.IntegrityViolation[] = diff(
        worktree,
        baseline.own,
        await snapshot(worktree),
        surfaces,
      );
      const { written, from } = state(worktree);
      const touched = [...new Set(written.slice(from).filter((path) => isProtected(path, protectedPaths)))].sort();
      if (touched.length) violations.push({ worktree, surface: 'protected', before: null, after: touched });
      for (const other of others) {
        const idle = baseline.idle[other];
        if (idle) violations.push(...diff(other, idle.snapshot, await snapshot(other), ['head', 'index', 'tree']));
      }
      return { violations };
    },
  };
}

// Every worktree starts at `head`, so a rollback to a baseline head resets to a real commit when `head` is one. `git`
// is the git the case runs on.
export function fakeIntegrity({
  head = 'f'.repeat(40),
  git,
}: {
  head?: string;
  git: integrityModule.IntegrityGit & checks.ChangedPaths;
}) {
  const states = worktreeStates(head);
  const counter = { objects: 0 };
  // Object names in git's form, so nothing that checks one tells the fake apart.
  const next = () => (++counter.objects).toString(16).padStart(40, '0');
  const testImmutability: runContext.TestImmutability = (cwd, baseline, globs) =>
    checks.testImmutability(cwd, baseline, { globs, git });
  return {
    integrity: assertions(states, git),
    testImmutability,
    // A file written into the worktree, tracked or not: the flag-aware tree changes.
    write: (worktree: string, path: string) => {
      const worktreeState = states.state(worktree);
      worktreeState.tree = next();
      worktreeState.written.push(path);
    },
    // Everything written is committed: HEAD moves and the index takes the tree.
    commit: (worktree: string) => {
      const worktreeState = states.state(worktree);
      worktreeState.head = next();
      worktreeState.index = worktreeState.headTree = worktreeState.tree;
    },
  };
}

export type FakeIntegrity = ReturnType<typeof fakeIntegrity>;
