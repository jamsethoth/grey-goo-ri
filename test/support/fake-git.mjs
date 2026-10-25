// lib/git.mjs without git, for tests whose subject is not git behaviour: commits, trees, refs, each worktree's index and the
// origin live in memory, while a worktree's files stay on disk, where the fake harness and a test runner read and write
// them. test/contract/git/ runs lib/git.mjs's cases against this and the real module, so a verb that drifts fails there.
// Owned beside lib/git.mjs: a verb added there is added here.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as realGit from '../../lib/git.mjs';
import { canonical, pathKey } from '../../lib/paths.mjs';

const sha1 = (data) => createHash('sha1').update(data).digest('hex');
const sorted = (paths) => [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const fail = (message) => Object.assign(new Error(message), { stderr: `${message}\n` });

// A .gitignore line as git reads it: `dir/` matches directories only, a slash elsewhere anchors it to the root, `*` and `?`
// stay within a path segment and `**` crosses them.
// shortcut: only the worktree root's .gitignore, without `!` negation; tests whose ignore rules need more stay on real git.
function ignoreRules(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const dirOnly = line.endsWith('/');
    const body = line.replace(/^\//, '').replace(/\/$/, '');
    return { re: globRe(body), dirOnly, anchored: line.slice(0, -1).includes('/') };
  });
}
const isIgnored = (rules, path) => {
  const parts = path.split('/');
  return rules.some(({ re, dirOnly, anchored }) => parts.some((_, i) =>
    !(dirOnly && i === parts.length - 1) && re.test(anchored ? parts.slice(0, i + 1).join('/') : parts[i])));
};

const globRe = (glob, flags = '') => new RegExp(`^${glob.split(/(\*\*\/|\*\*|\*|\?)/).map((part) =>
  part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]'
    : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')}$`, flags);

// lib/git.mjs's pathspecs: a literal path matches itself and what is under it, `icase` folds case, `glob` is a glob and
// `exclude` removes matches; with only exclusions everything else matches.
function pathspecMatcher(specs) {
  const include = [], exclude = [];
  for (const spec of specs) {
    const [, magic = '', body] = spec.match(/^(?::\(([a-z,]+)\))?(.*)$/);
    const words = magic.split(',');
    const fold = words.includes('icase') ? (s) => s.toLowerCase() : (s) => s;
    const test = words.includes('glob') ? ((re) => (p) => re.test(p))(globRe(body))
      : body === '.' ? () => true : (p) => fold(p) === fold(body) || fold(p).startsWith(`${fold(body)}/`);
    (words.includes('exclude') ? exclude : include).push(test);
  }
  return (p) => (!include.length || include.some((t) => t(p))) && !exclude.some((t) => t(p));
}

// Lines with their endings, so a missing final newline is a change as it is to git.
const lines = (buf) => buf.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? [];
const isBinary = (buf) => !!buf && buf.includes(0);
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (const x of a) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = x === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

export function fakeGit() {
  const trees = new Map(); // id -> Map(path -> Buffer)
  const commits = new Map(); // sha -> { tree, parents, message, n }
  const repos = [];
  let n = 0;

  const putTree = (files) => {
    const id = sha1(`tree\0${sorted(files.keys()).map((p) => `${p}\0${sha1(files.get(p))}`).join('\0')}`);
    if (!trees.has(id)) trees.set(id, new Map(files));
    return id;
  };
  const putCommit = (tree, parents, message) => {
    const sha = sha1(`commit ${++n}\0${tree}\0${parents.join(' ')}\0${message}`);
    commits.set(sha, { tree, parents, message, n });
    return sha;
  };

  // The worktree at `cwd`, found as git finds it: by the .git entry in that directory, so a plain folder that replaced a
  // worktree is not one.
  const at = (cwd) => {
    for (const repo of repos) {
      for (const wt of repo.worktrees) {
        if (pathKey(wt.path) !== pathKey(cwd)) continue;
        const marker = join(cwd, '.git');
        if (wt.main ? existsSync(marker) : existsSync(marker) && readFileSync(marker, 'utf8') === wt.marker) return { repo, wt };
      }
    }
    throw fail(`fatal: not a git repository: ${cwd}`);
  };
  const headOf = ({ repo, wt }) => {
    const sha = wt.branch ? repo.branches.get(wt.branch) : wt.head;
    if (!sha) throw fail("fatal: ambiguous argument 'HEAD': unknown revision");
    return sha;
  };
  const move = ({ repo, wt }, sha) => (wt.branch ? repo.branches.set(wt.branch, sha) : (wt.head = sha));
  const commitOf = (repo, rev) => {
    const sha = repo.branches.get(rev) ?? (rev.startsWith('origin/') ? repo.tracking.get(rev.slice(7)) : undefined) ?? rev;
    if (!commits.has(sha)) throw fail(`fatal: bad revision '${rev}'`);
    return sha;
  };
  const resolve = (ctx, rev) => (rev === 'HEAD' ? headOf(ctx) : commitOf(ctx.repo, rev));
  const treeFiles = (ctx, rev) => trees.get(trees.has(rev) ? rev : commits.get(resolve(ctx, rev)).tree);

  // shortcut: symlinks are skipped, not stored as links; a test whose subject is a link stays on real git.
  const disk = (wt) => {
    const files = new Map();
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!prefix && entry.name === '.git') continue;
        const full = join(dir, entry.name);
        const path = prefix + entry.name;
        if (lstatSync(full).isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full, `${path}/`);
        else files.set(path, readFileSync(full));
      }
    };
    walk(wt.path, '');
    return files;
  };
  const rulesOf = (wt) => {
    const file = join(wt.path, '.gitignore');
    return existsSync(file) ? ignoreRules(readFileSync(file, 'utf8')) : [];
  };
  // What `add -A` stages: every file on disk but untracked ignored ones, and no tracked file that is gone.
  const addAll = (wt) => {
    const rules = rulesOf(wt);
    return new Map([...disk(wt)].filter(([p]) => wt.index.has(p) || !isIgnored(rules, p)));
  };
  const writeFiles = (root, files) => {
    for (const [p, content] of files) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), content);
    }
  };
  const pruneEmpty = (dir, top = true) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (top && entry.name === '.git') continue;
      if (entry.isDirectory() && !lstatSync(join(dir, entry.name)).isSymbolicLink()) pruneEmpty(join(dir, entry.name), false);
    }
    if (!top && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  };
  const ancestors = (sha) => {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop();
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...commits.get(s).parents);
    }
    return seen;
  };
  const mergeBase = (a, b) => {
    const of = ancestors(a);
    return [...ancestors(b)].filter((s) => of.has(s)).sort((x, y) => commits.get(y).n - commits.get(x).n)[0];
  };
  // Paths whose content differs between two file maps, sorted.
  const differing = (from, to) => sorted(new Set([...from.keys(), ...to.keys()])).filter((p) => {
    const [a, b] = [from.get(p), to.get(p)];
    return !(a && b && a.equals(b));
  });
  const sinceBase = (ctx, base) => {
    const head = headOf(ctx);
    return { from: trees.get(commits.get(mergeBase(commitOf(ctx.repo, base), head)).tree), to: trees.get(commits.get(head).tree) };
  };

  const git = {
    repoInfo: async (cwd) => {
      const { repo, wt } = at(cwd);
      const gitCommonDir = wt.main ? join(cwd, '.git') : canonical(repo.commonDir);
      return { mainRoot: dirname(gitCommonDir), gitCommonDir, name: dirname(gitCommonDir).split(/[\\/]/).at(-1) };
    },
    commonDir: async (cwd) => canonical(at(cwd).repo.commonDir),
    slugify: realGit.slugify,
    worktreePath: realGit.worktreePath,
    pathspecs: realGit.pathspecs,

    async ensureWorktree({ mainRoot, path, branch, base }) {
      const { repo } = at(mainRoot);
      if (existsSync(path)) {
        let found = null;
        try { found = at(path); } catch { /* not a worktree */ }
        if (!found || found.repo !== repo || !found.wt.branch?.startsWith('ticket/')) {
          throw new Error(`${path} exists but is not a git worktree of this repo on a ticket/ branch; remove or move it and re-run`);
        }
        return { path, branch: found.wt.branch };
      }
      if (!repo.reachable) throw fail(`fatal: '${repo.url}' does not appear to be a git repository`);
      if (!repo.origin.has(base)) throw fail(`fatal: couldn't find remote ref ${base}`);
      repo.tracking.set(base, repo.origin.get(base));
      if (!repo.branches.has(branch)) repo.branches.set(branch, repo.tracking.get(base));
      const files = trees.get(commits.get(repo.branches.get(branch)).tree);
      const wt = { path, branch, index: new Map(files), marker: `gitdir: fake ${sha1(`${pathKey(path)}${++n}`)}\n` };
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, '.git'), wt.marker);
      writeFiles(path, files);
      repo.worktrees.push(wt);
      return { path, branch };
    },
    // git lists worktrees by their canonical paths, with forward slashes on Windows too.
    listWorktrees: async (mainRoot) => at(mainRoot).repo.worktrees.filter((w) => w.branch)
      .map((w) => ({ path: canonical(w.path).replaceAll('\\', '/'), branch: w.branch })),
    currentBranch: async (cwd) => at(cwd).wt.branch ?? null,

    async stageAll(cwd) {
      const ctx = at(cwd);
      ctx.wt.index = addAll(ctx.wt);
      return putTree(ctx.wt.index) !== commits.get(headOf(ctx)).tree;
    },
    writeTree: async (cwd) => putTree(at(cwd).wt.index),
    async commitStaged(cwd, message) {
      const ctx = at(cwd);
      const tree = putTree(ctx.wt.index);
      const head = headOf(ctx);
      if (tree === commits.get(head).tree) return null;
      const sha = putCommit(tree, [head], message);
      move(ctx, sha);
      return sha;
    },
    async commitTree(cwd, { message, tree, parent }) {
      const ctx = at(cwd);
      if (commits.get(parent)?.tree === tree) return null;
      if (!trees.has(tree)) throw fail(`fatal: ${tree} is not a valid 'tree' object`);
      const sha = putCommit(tree, [parent], message);
      const head = headOf(ctx);
      if (head !== parent) throw fail(`fatal: update-ref: cannot lock ref 'HEAD': is at ${head} but expected ${parent}`);
      move(ctx, sha);
      return sha;
    },
    // reset --hard then clean -fd: tracked files take the revision's content, untracked ones go unless ignored.
    async resetTo(cwd, sha) {
      const ctx = at(cwd);
      const target = treeFiles(ctx, sha);
      const rules = rulesOf(ctx.wt);
      for (const p of disk(ctx.wt).keys()) {
        if (!target.has(p) && (ctx.wt.index.has(p) || !isIgnored(rules, p))) rmSync(join(cwd, p), { force: true });
      }
      writeFiles(cwd, target);
      pruneEmpty(cwd);
      ctx.wt.index = new Map(target);
      move(ctx, resolve(ctx, sha));
    },
    async push(cwd, branch, sha = branch) {
      const ctx = at(cwd);
      const commit = resolve(ctx, sha);
      if (!ctx.repo.reachable) throw fail(`fatal: '${ctx.repo.url}' does not appear to be a git repository`);
      const theirs = ctx.repo.origin.get(branch);
      if (theirs && !ancestors(commit).has(theirs)) throw fail(` ! [rejected]        ${sha} -> ${branch} (non-fast-forward)`);
      ctx.repo.origin.set(branch, commit);
      ctx.repo.tracking.set(branch, commit);
    },
    headSha: async (cwd) => headOf(at(cwd)),
    async remoteSha(cwd, branch) {
      const { repo } = at(cwd);
      if (!repo.reachable) throw fail(`fatal: '${repo.url}' does not appear to be a git repository`);
      if (!repo.origin.has(branch)) return null;
      repo.tracking.set(branch, repo.origin.get(branch));
      return repo.origin.get(branch);
    },
    async branchHead(cwd, branch) {
      const sha = at(cwd).repo.branches.get(branch);
      if (!sha) throw fail(`fatal: ambiguous argument 'refs/heads/${branch}': unknown revision`);
      return sha;
    },
    treeOf: async (cwd, commit = 'HEAD') => commits.get(resolve(at(cwd), commit)).tree,
    hasTree: async (cwd, tree) => (at(cwd), trees.has(tree)),
    async commitLog(cwd, branch) {
      const ctx = at(cwd);
      return [...ancestors(commitOf(ctx.repo, branch))].sort((a, b) => commits.get(b).n - commits.get(a).n)
        .map((sha) => ({ sha, parents: commits.get(sha).parents, tree: commits.get(sha).tree, message: commits.get(sha).message.replace(/\n+$/, '') }));
    },
    async treeDiff(cwd, from, to) {
      const ctx = at(cwd);
      const [a, b] = [treeFiles(ctx, from), treeFiles(ctx, to)];
      return differing(a, b).map((path) => ({ path, change: !a.has(path) ? 'added' : !b.has(path) ? 'deleted' : 'modified' }));
    },
    // Renames as git detects them by default, but only exact ones: the deleted path of a moved file is not listed.
    async changedPaths(cwd, from, to, within = []) {
      const ctx = at(cwd);
      const [a, b] = [treeFiles(ctx, from), treeFiles(ctx, to)];
      const match = pathspecMatcher(within);
      const changed = differing(a, b).filter(match);
      const added = changed.filter((p) => !a.has(p)).map((p) => b.get(p));
      return changed.filter((p) => {
        if (b.has(p)) return true;
        const i = added.findIndex((c) => c.equals(a.get(p)));
        if (i < 0) return true;
        added.splice(i, 1);
        return false;
      });
    },
    async changedSince(cwd, commit) {
      const ctx = at(cwd);
      const files = disk(ctx.wt);
      const tracked = new Map([...ctx.wt.index.keys()].filter((p) => files.has(p)).map((p) => [p, files.get(p)]));
      return differing(treeFiles(ctx, commit), tracked);
    },
    async untrackedPaths(cwd, { include = 'unignored', within = [] } = {}) {
      const { wt } = at(cwd);
      const rules = rulesOf(wt);
      const match = pathspecMatcher(within);
      const keep = { unignored: (p) => !isIgnored(rules, p), ignored: (p) => isIgnored(rules, p), all: () => true }[include];
      return sorted([...disk(wt).keys()].filter((p) => !wt.index.has(p) && keep(p) && match(p)));
    },
    // shortcut: the fake makes no merges, so nothing is ever conflicted; conflict tests stay on real git.
    conflictedPaths: async (cwd) => (at(cwd), []),
    async diffSummary(cwd) {
      const changed = await git.changedSince(cwd, 'HEAD');
      return changed.length ? `${changed.map((p) => ` ${p} | changed\n`).join('')} ${changed.length} files changed\n` : '';
    },
    async branchDiff(cwd, base) {
      const { from, to } = sinceBase(at(cwd), base);
      return differing(from, to).map((p) => {
        const [a, b] = [from.get(p), to.get(p)];
        if (isBinary(a) || isBinary(b)) return `diff --git a/${p} b/${p}\nBinary files differ\n`;
        const body = [...(a ? lines(a).map((l) => `-${l}`) : []), ...(b ? lines(b).map((l) => `+${l}`) : [])].join('');
        return `diff --git a/${p} b/${p}\n--- ${a ? `a/${p}` : '/dev/null'}\n+++ ${b ? `b/${p}` : '/dev/null'}\n${body}`;
      }).join('');
    },
    // A minimal line diff's counts, which are git's whatever path its diff takes.
    async diffStats(cwd, base) {
      const { from, to } = sinceBase(at(cwd), base);
      return differing(from, to).map((path) => {
        const [a, b] = [from.get(path), to.get(path)];
        if (isBinary(a) || isBinary(b)) return { path, insertions: null, deletions: null };
        const [x, y] = [a ? lines(a) : [], b ? lines(b) : []];
        const common = lcs(x, y);
        return { path, insertions: y.length - common, deletions: x.length - common };
      });
    },
    // No verb sets index flags here, so the tree `add -A` would stage is read from the files themselves.
    async fingerprint(worktree) {
      const ctx = at(worktree);
      return { head: headOf(ctx), index: putTree(ctx.wt.index), tree: putTree(addAll(ctx.wt)) };
    },
  };

  // A bare origin and its clone at root/main with one commit on main holding `files`, pushed: what tests start from.
  function init(root, { files = {}, message = 'init' } = {}) {
    const mainRoot = join(root, 'main');
    const commonDir = join(mainRoot, '.git');
    mkdirSync(commonDir, { recursive: true });
    const tree = putTree(new Map(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)])));
    const base = putCommit(tree, [], message);
    const repo = { commonDir, url: join(root, 'origin.git'), reachable: true, branches: new Map([['main', base]]),
      origin: new Map([['main', base]]), tracking: new Map([['main', base]]), worktrees: [] };
    repo.worktrees.push({ path: mainRoot, branch: 'main', index: new Map(trees.get(tree)), main: true });
    repos.push(repo);
    writeFiles(mainRoot, trees.get(tree));
    return { mainRoot, commonDir, base };
  }

  // The steps a test takes outside gg, as a human or another tool would with git.
  const commit = (dir, message) => {
    const ctx = at(dir);
    ctx.wt.index = addAll(ctx.wt);
    const sha = putCommit(putTree(ctx.wt.index), [headOf(ctx)], message);
    move(ctx, sha);
    return sha;
  };
  const amend = (dir, message) => {
    const ctx = at(dir);
    const sha = putCommit(putTree(ctx.wt.index), commits.get(headOf(ctx)).parents, message);
    move(ctx, sha);
    return sha;
  };
  const branch = (dir, name) => {
    const ctx = at(dir);
    ctx.repo.branches.set(name, headOf(ctx));
    ctx.wt.branch = name;
  };
  const detach = (dir) => {
    const ctx = at(dir);
    ctx.wt.head = headOf(ctx);
    ctx.wt.branch = null;
  };
  const unstage = (dir) => {
    const ctx = at(dir);
    ctx.wt.index = new Map(trees.get(commits.get(headOf(ctx)).tree));
  };
  const breakOrigin = (dir) => {
    const { repo } = at(dir);
    repo.reachable = false;
    repo.url = join(dirname(repo.url), 'gone.git');
    return 'gone.git';
  };

  // `git worktree list`'s count, main checkout included, read without awaiting.
  const worktreeCount = (mainRoot) => at(mainRoot).repo.worktrees.length;

  return { git, init, commit, amend, branch, detach, unstage, breakOrigin, worktreeCount };
}
