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

// The reset of a failed red Phase is proven done only by a clean worktree at its baseline. Anything else is Held: dirty
// state found at resume is never discarded (ADR-0005), and the History item waits in the open intent.
export async function resets(rec, { git }) {
  for (const entry of record.openIntents(rec).filter((e) => e.action === 'reset')) {
    if (!rec.log.some((e) => e.marker === entry.marker && e.step === 'evidence')) {
      const head = await git.headSha(rec.worktree);
      if (head !== entry.payload.baseline || !await integrity.isCleanAt(rec.worktree, head)) return 'held';
      // git clean leaves ignored files, so the intent's saved rollbackSet finishes an interrupted restore.
      if (entry.payload.untracked) await integrity.restoreUntracked(rec.worktree, entry.payload.untracked);
      rec.history.push(entry.payload.history);
      await record.evidence(rec, entry.marker, { head });
    }
    await record.complete(rec, entry.marker);
  }
  return 'continue';
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

// Labels decide whether an Execution continues, the record where (request 3.6). The record is never discarded.
export async function reconcile({ record: rec, flow, git, gh, labelPrefix = 'gg', cwd }) {
  if (rec instanceof record.RecordCorruptError) return { next: 'hold', cursor: null, reason: `${rec.message}; it is kept for a human.` };
  const needsHuman = labels(labelPrefix).state('needs-human');
  const issueLabels = gh.labelNames(await gh.viewIssue(rec.ticket, cwd));
  if ((rec.cursor.phase !== null || record.openIntents(rec).length) && issueLabels.includes(needsHuman)) {
    rec.state = 'abandoned';
    await record.save(rec);
    return { next: 'abandon', cursor: rec.cursor, reason: `#${rec.ticket} carries ${needsHuman} on GitHub, which overrides the record.` };
  }
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
  return { next: 'continue', cursor: rec.cursor, reason: null };
}
