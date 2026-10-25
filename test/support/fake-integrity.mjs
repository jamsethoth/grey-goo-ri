// Integrity and Test Immutability without git, for tests whose subject is not git behaviour. A snapshot is fixed values;
// `write` and `commit` stand in for an agent changing a worktree, so a test can script a violation. test/integrity.test.mjs
// runs one scenario table against this and lib/integrity.mjs, so the violations it reports keep the real shape.
// Every worktree starts at `head`, so a rollback to a baseline head resets to a real commit when `head` is one.
export function fakeIntegrity({ head = 'f'.repeat(40) } = {}) {
  let n = 0;
  // Object names in git's form, so nothing that checks one tells the fake apart.
  const next = () => (++n).toString(16).padStart(40, '0');
  const TREE = '0'.repeat(40);
  const worktrees = new Map();
  const state = (worktree) => {
    if (!worktrees.has(worktree)) worktrees.set(worktree, { head, headTree: TREE, index: TREE, tree: TREE, written: [], from: 0 });
    return worktrees.get(worktree);
  };
  const snapshot = async (worktree) => {
    const { head: h, index, tree } = state(worktree);
    return { head: h, index, tree };
  };
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const isProtected = (p, protectedPaths) => protectedPaths.some((q) => {
    const bare = fold(q.replace(/\/+$/, ''));
    return fold(p) === bare || fold(p).startsWith(`${bare}/`);
  });
  const diff = (worktree, before, after, surfaces) =>
    surfaces.filter((s) => before[s] !== after[s]).map((surface) => ({ worktree, surface, before: before[surface], after: after[surface] }));

  const integrity = {
    snapshot,
    isCleanAt: async (worktree) => {
      const s = state(worktree);
      return s.tree === s.headTree && s.index === s.headTree;
    },
    untrackedFiles: async () => ({}),
    ignoredFiles: async () => ({}),
    restoreUntracked: async () => {},
    async begin({ record: rec, others }) {
      const own = await snapshot(rec.worktree);
      const idle = {};
      for (const other of others) idle[other] = { generation: 0, snap: await snapshot(other) };
      state(rec.worktree).from = state(rec.worktree).written.length;
      return { head: own.head, own, idle, untracked: {}, tests: {} };
    },
    // Protected writes count from the last begin: an Attempt's end always follows its own begin.
    async end({ baseline, record: rec, others, access, protectedPaths }) {
      const worktree = rec.worktree;
      const violations = diff(worktree, baseline.own, await snapshot(worktree), access === 'read-only' ? ['head', 'index', 'tree'] : ['head', 'index']);
      const touched = [...new Set(state(worktree).written.slice(state(worktree).from).filter((p) => isProtected(p, protectedPaths)))].sort();
      if (touched.length) violations.push({ worktree, surface: 'protected', before: null, after: touched });
      for (const other of others) {
        if (baseline.idle[other]) violations.push(...diff(other, baseline.idle[other].snap, await snapshot(other), ['head', 'index', 'tree']));
      }
      return { violations };
    },
  };
  return {
    integrity,
    testImmutability: async () => ({ ok: true, changed: [] }),
    // A file written into the worktree, tracked or not: the flag-aware tree changes.
    write: (worktree, path) => {
      const s = state(worktree);
      s.tree = next();
      s.written.push(path);
    },
    // Everything written is committed: HEAD moves and the index takes the tree.
    commit: (worktree) => {
      const s = state(worktree);
      s.head = next();
      s.index = s.headTree = s.tree;
    },
  };
}
