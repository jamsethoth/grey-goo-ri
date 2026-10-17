import { createHash } from 'node:crypto';
import * as record from './record.mjs';
import * as integrity from './integrity.mjs';
import * as marker from './marker.mjs';
import { labels } from './labels.mjs';

const TERMINALS = ['done', 'needs-human', 'replan'];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// The last marker line wins (marker.parseMarker), so agent text that mimics a marker cannot complete an Action.
const carries = (text, m) => {
  const parts = marker.parseMarker(text);
  return !!parts && marker.formatMarker(parts) === m;
};

const ignoredOf = async (worktree, untracked) => (untracked ? integrity.ignoredFiles(worktree, untracked.pathspecs) : {});

// The worktree an open intent recorded before its effect, by Action kind. A reset records the worktree as the agent left
// it, ignored Protected Files and tests included; a commit its parent and the tree it staged. push, pr-upsert, pr-ready,
// comment and label leave the worktree alone and record none, so they prove no uncommitted change.
const RECORDED = {
  // An intent saved before the index was fingerprinted proves nothing.
  reset: ({ left, untracked }) => left?.index && { head: left.head, index: left.index, tree: left.tree, files: left.files ?? {}, untracked },
  commit: ({ parent, tree }) => ({ head: parent, index: tree, tree }),
};

// True when the worktree is exactly as an open intent recorded it: only then are its uncommitted changes proven the
// agent's (ADR-0005), for Reconciliation to finish the intent.
async function asRecorded(worktree, { action, payload }) {
  const want = RECORDED[action]?.(payload);
  if (!want) return false;
  const now = await integrity.snapshot(worktree);
  return now.head === want.head && now.index === want.index && now.tree === want.tree
    && (!want.files || integrity.sameFiles(want.files, await ignoredOf(worktree, want.untracked)));
}

// An open reset is done when the worktree is clean at its baseline, and is made now when the worktree is exactly as its
// intent recorded it. Anything else is a human's and Held, nothing discarded, and the History item waits in the intent.
export async function resets(rec, { git }) {
  for (const entry of record.openIntents(rec).filter((e) => e.action === 'reset')) {
    if (!rec.log.some((e) => e.marker === entry.marker && e.step === 'evidence')) {
      const { baseline, untracked, left } = entry.payload;
      let head = await git.headSha(rec.worktree);
      if (head !== baseline || !await integrity.isCleanAt(rec.worktree, head)) {
        if (!await asRecorded(rec.worktree, entry)) return 'held';
        await git.resetTo(rec.worktree, baseline);
        head = await git.headSha(rec.worktree);
      }
      // git clean leaves ignored files, so the intent's saved rollbackSet finishes an interrupted restore, but only over
      // ignored files still as the agent left them or already restored: any other state is a human's.
      if (untracked && !integrity.sameFiles(await ignoredOf(rec.worktree, untracked), left?.files ?? {})
        && !integrity.sameFiles(await integrity.untrackedFiles(rec.worktree, untracked.pathspecs), untracked.files)) return 'held';
      if (untracked) await integrity.restoreUntracked(rec.worktree, untracked);
      rec.history.push(entry.payload.history);
      await record.evidence(rec, entry.marker, { head });
    }
    await record.complete(rec, entry.marker);
  }
  return 'continue';
}

// Uncommitted changes at Ticket start that no open intent proves the agent's are unknown dirty state: Held with their
// diff stat and left untouched (ADR-0005). Null when the worktree is clean, or exactly as an open intent recorded it, which
// Reconciliation then finishes.
export async function dirtyState(rec, { git, worktree }) {
  // git write-tree refuses unmerged entries, so a merge conflict cannot be fingerprinted: it is never the agent's.
  const unmerged = (await git.runGit(['ls-files', '-u'], { cwd: worktree })).stdout.trim() !== '';
  if (!unmerged && await integrity.isCleanAt(worktree, 'HEAD')) return null;
  for (const entry of !unmerged && rec ? record.openIntents(rec) : []) if (await asRecorded(worktree, entry)) return null;
  if (rec) {
    rec.state = 'held';
    await record.save(rec);
  }
  const untracked = (await git.runGit(['ls-files', '--others', '--exclude-standard'], { cwd: worktree })).stdout.split('\n').filter(Boolean);
  return { stat: (await git.runGit(['diff', '--stat', 'HEAD'], { cwd: worktree })).stdout + untracked.map((p) => ` ${p} (untracked)\n`).join('') };
}

// Each finds an open intent's effect by its marker: evidence completes it, a hold stops, null leaves it to be redone.
const FINDERS = {
  async commit({ marker: m, payload }, { rec, git }) {
    const log = (await git.runGit(['log', '--format=%x1e%H%x1f%P%x1f%T%x1f%B', rec.branch], { cwd: rec.worktree })).stdout;
    for (const [sha, parent, tree, body] of log.split('\x1e').slice(1).map((c) => c.split('\x1f'))) {
      if (!carries(body, m)) continue;
      if (parent === payload.parent && tree === payload.tree) return { evidence: { sha } };
      return { hold: `Commit ${sha} carries the Action Marker ${m} but not the intended parent and tree, so it was changed by hand; nothing was committed or discarded.` };
    }
    // The commit is redone from the recorded tree on the recorded parent, so both must still be there.
    const head = await git.headSha(rec.worktree);
    const { code } = await git.runGit(['cat-file', '-e', `${payload.tree}^{tree}`], { cwd: rec.worktree, allowFail: true });
    if (head !== payload.parent || code !== 0) {
      return { hold: `The commit of Action Marker ${m} was not made and the branch is no longer at its intended parent and tree; nothing was committed or discarded.` };
    }
    return null;
  },
  async push({ marker: m, payload }, { rec, git }) {
    if (await git.remoteSha(rec.worktree, payload.branch) === payload.sha) return { evidence: { remoteSha: payload.sha } };
    const head = (await git.runGit(['rev-parse', `refs/heads/${payload.branch}`], { cwd: rec.worktree })).stdout.trim();
    if (head !== payload.sha) return { hold: `The push of Action Marker ${m} was not made and ${payload.branch} has moved from ${payload.sha} to ${head}; nothing was pushed.` };
    return null;
  },
  async 'pr-upsert'({ marker: m, payload }, { rec, gh, cwd }) {
    const found = await gh.findPr(payload.branch, cwd);
    if (!found) return null;
    const pr = await gh.viewPr(found.number, cwd);
    if (!carries(pr.body, m) || sha256(pr.body) !== payload.bodyHash) return null;
    rec.pr = pr.number;
    return { evidence: { number: pr.number, url: pr.url } };
  },
  async comment({ marker: m, payload: { target } }, { gh, cwd }) {
    const found = (await (target.kind === 'pr' ? gh.prComments : gh.issueComments)(target.number, cwd)).find((c) => carries(c.body, m));
    return found ? { evidence: { id: found.id } } : null;
  },
  async label({ payload }, { issueLabels }) {
    const shown = payload.add.every((l) => issueLabels.includes(l)) && payload.remove.every((l) => !issueLabels.includes(l));
    return shown ? { evidence: { ok: true } } : null;
  },
};

// A needs-human label a human set on a started Execution overrides its record, which is kept but marked abandoned.
export async function humanOverride(rec, issueLabels, labelPrefix = 'gg') {
  const needsHuman = labels(labelPrefix).state('needs-human');
  // A needs-human Terminal that crashed after its label Action shows gg's own label, not a human's.
  const own = rec.log.some((e) => e.step === 'intent' && e.action === 'label' && e.payload.add.includes(needsHuman));
  if (own || !(rec.cursor.phase !== null || record.openIntents(rec).length) || !issueLabels.includes(needsHuman)) return null;
  rec.state = 'abandoned';
  await record.save(rec);
  return { next: 'abandon', cursor: rec.cursor, reason: `#${rec.ticket} carries ${needsHuman} on GitHub, which overrides the record.` };
}

// Labels decide whether an Execution continues, the record where (request 3.5). The record is never discarded.
export async function reconcile({ record: rec, flow, git, gh, labelPrefix = 'gg', cwd }) {
  if (rec instanceof record.RecordCorruptError) return { next: 'hold', cursor: null, reason: `${rec.message}; it is kept for a human.` };
  const issueLabels = gh.labelNames(await gh.viewIssue(rec.ticket, cwd));
  const overridden = await humanOverride(rec, issueLabels, labelPrefix);
  if (overridden) return overridden;
  const { vertex } = rec.cursor;
  const hold = (reason) => ({ next: 'hold', cursor: rec.cursor, reason });
  if (!TERMINALS.includes(vertex) && !flow.ticket.vertices[vertex]) return hold(`The record continues at Vertex ${vertex}, which the Flow no longer has.`);
  if (await resets(rec, { git }) === 'held') return hold('An interrupted reset did not leave the worktree clean at its baseline; nothing was discarded.');
  for (const entry of record.openIntents(rec)) {
    const found = await FINDERS[entry.action]?.(entry, { rec, git, gh, cwd, issueLabels });
    if (found?.hold) return hold(found.hold);
    if (found) {
      await record.evidence(rec, entry.marker, found.evidence);
      await record.complete(rec, entry.marker);
    }
  }
  // A completed commit has no open intent to check, and an amend keeps its marker: only the branch tip shows the change.
  const last = record.lastCommit(rec);
  const head = last && await git.headSha(rec.worktree);
  if (last && head !== last.evidence.sha) {
    return hold(`The branch is at ${head}, not at commit ${last.evidence.sha} of Action Marker ${last.marker}, so it was changed by hand; nothing was committed, pushed or discarded.`);
  }
  return { next: 'continue', cursor: rec.cursor, reason: null };
}
