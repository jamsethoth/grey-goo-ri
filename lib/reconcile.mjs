import { createHash } from 'node:crypto';
import * as record from './record.mjs';
import * as integrity from './integrity.mjs';
import * as marker from './marker.mjs';
import { has, labels } from './labels.mjs';

const TERMINALS = ['done', 'needs-human', 'replan'];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// The last marker line wins (marker.parseMarker), so agent text that mimics a marker cannot complete an Action.
export const carries = (text, m) => {
  const parts = marker.parseMarker(text);
  return !!parts && marker.formatMarker(parts) === m;
};

const ignoredOf = async (worktree, untracked) => (untracked ? integrity.ignoredFiles(worktree, untracked.pathspecs) : {});

// Where an open reset can be found: 'left' while the worktree is exactly as the agent left it, ignored Protected Files and
// tests included; 'restoring' once the git reset landed, however far its restore of untracked files got, each rollback
// file being absent, as the agent left it or restored; null for anything else, which is a human's (ADR-0005).
async function resetState(worktree, { baseline, untracked, left }, git) {
  const now = await integrity.snapshot(worktree);
  const saved = untracked?.files ?? {};
  const files = untracked ? await integrity.untrackedFiles(worktree, untracked.pathspecs) : {};
  const tree = (await git.runGit(['rev-parse', `${baseline}^{tree}`], { cwd: worktree })).stdout.trim();
  if (now.head === baseline && now.index === tree
    && Object.entries(files).every(([p, f]) => integrity.sameFile(f, left?.files?.[p]) || integrity.sameFile(f, saved[p]))
    && await onlyRestored(worktree, tree, now.tree, files, saved, git)) return 'restoring';
  // An intent saved before the index was fingerprinted proves nothing.
  if (left?.index && now.head === left.head && now.index === left.index && now.tree === left.tree
    && integrity.sameFiles(left.files ?? {}, await ignoredOf(worktree, untracked))) return 'left';
  return null;
}

// The flag-aware tree differs from the baseline only by untracked files the restore has put back with their saved bytes.
async function onlyRestored(worktree, from, to, files, saved, git) {
  if (from === to) return true;
  const changes = (await git.runGit(['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '--no-renames', from, to], { cwd: worktree }))
    .stdout.split('\0').filter(Boolean);
  for (let i = 0; i < changes.length; i += 2) {
    const [status, p] = [changes[i], changes[i + 1]];
    if (status !== 'A' || !integrity.sameFile(files[p], saved[p])) return false;
  }
  return true;
}

// True when the worktree is in a state an open intent proves the agent's (ADR-0005), for Reconciliation to finish the
// intent: a reset's, or a commit's recorded parent and the tree it staged. push, pr-upsert, pr-ready, comment and label
// leave the worktree alone and record none, so they prove no uncommitted change.
async function asRecorded(worktree, { action, payload }, git) {
  if (action === 'reset') return await resetState(worktree, payload, git) !== null;
  if (action !== 'commit') return false;
  const now = await integrity.snapshot(worktree);
  return now.head === payload.parent && now.index === payload.tree && now.tree === payload.tree;
}

// An open reset is made now while the worktree is as the agent left it, and its restore is replayed once the reset
// landed; restoreUntracked skips files already back. Anything else is a human's and Held, nothing discarded, and the
// History item waits in the intent.
export async function resets(rec, { git }) {
  for (const entry of record.openIntents(rec).filter((e) => e.action === 'reset')) {
    if (!record.proof(rec, entry.marker)) {
      const { baseline, untracked } = entry.payload;
      let state = await resetState(rec.worktree, entry.payload, git);
      if (state === 'left') {
        await git.resetTo(rec.worktree, baseline);
        state = await resetState(rec.worktree, entry.payload, git);
      }
      if (state !== 'restoring') return 'held';
      if (untracked) await integrity.restoreUntracked(rec.worktree, untracked);
      const head = await git.headSha(rec.worktree);
      rec.history.push(entry.payload.history);
      await record.evidence(rec, entry.marker, { head });
    }
    await record.complete(rec, entry.marker);
  }
  return 'continue';
}

// Uncommitted changes at Ticket start that no open intent proves the agent's are unknown dirty state, returned with their
// diff stat for the hold and left untouched (ADR-0005). Null when the worktree is clean, or exactly as an open intent
// recorded it, which Reconciliation then finishes.
export async function dirtyState(rec, { git, worktree }) {
  // git write-tree refuses unmerged entries, so a merge conflict cannot be fingerprinted: it is never the agent's.
  const conflicts = [...new Set((await git.runGit(['ls-files', '-u', '-z'], { cwd: worktree })).stdout
    .split('\0').filter(Boolean).map((entry) => entry.slice(entry.indexOf('\t') + 1)))];
  const unmerged = conflicts.length > 0;
  if (!unmerged && await integrity.isCleanAt(worktree, 'HEAD')) return null;
  for (const entry of !unmerged && rec ? record.openIntents(rec) : []) if (await asRecorded(worktree, entry, git)) return null;
  const untracked = (await git.runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree })).stdout.split('\0').filter(Boolean);
  return { conflicts, stat: (await git.runGit(['diff', '--stat', 'HEAD'], { cwd: worktree })).stdout + untracked.map((p) => ` ${p} (untracked)\n`).join('') };
}

// Each finds an open intent's effect by its marker: found (its evidence completes it), conflicting (a hold) or absent (to
// be redone). A lookup that throws is unknown (findEffect), which never counts as absent.
const found = (evidence) => ({ status: 'found', evidence });
const conflicting = (reason) => ({ status: 'conflicting', reason });
const ABSENT = { status: 'absent' };
const FINDERS = {
  async commit({ marker: m, payload }, { rec, git }) {
    const log = (await git.runGit(['log', '--format=%x1e%H%x1f%P%x1f%T%x1f%B', rec.branch], { cwd: rec.worktree })).stdout;
    for (const [sha, parent, tree, body] of log.split('\x1e').slice(1).map((c) => c.split('\x1f'))) {
      if (!carries(body, m)) continue;
      if (parent === payload.parent && tree === payload.tree) return found({ sha });
      return conflicting(`Commit ${sha} carries the Action Marker ${m} but not the intended parent and tree, so it was changed by hand; nothing was committed or discarded.`);
    }
    // The commit is redone from the recorded tree on the recorded parent, so both must still be there.
    const head = await git.headSha(rec.worktree);
    const { code } = await git.runGit(['cat-file', '-e', `${payload.tree}^{tree}`], { cwd: rec.worktree, allowFail: true });
    if (head !== payload.parent || code !== 0) {
      return conflicting(`The commit of Action Marker ${m} was not made and the branch is no longer at its intended parent and tree; nothing was committed or discarded.`);
    }
    return ABSENT;
  },
  async push({ marker: m, payload }, { rec, git }) {
    if (await git.remoteSha(rec.worktree, payload.branch) === payload.sha) return found({ remoteSha: payload.sha });
    const head = (await git.runGit(['rev-parse', `refs/heads/${payload.branch}`], { cwd: rec.worktree })).stdout.trim();
    if (head !== payload.sha) return conflicting(`The push of Action Marker ${m} was not made and ${payload.branch} has moved from ${payload.sha} to ${head}; nothing was pushed.`);
    return ABSENT;
  },
  async 'pr-upsert'({ marker: m, payload }, { rec, gh, cwd }) {
    const listed = await gh.findPr(payload.branch, cwd);
    if (!listed) return ABSENT;
    const pr = await gh.viewPr(listed.number, cwd);
    if (!carries(pr.body, m) || sha256(pr.body) !== payload.bodyHash) return ABSENT;
    rec.pr = pr.number;
    return found({ number: pr.number, url: pr.url });
  },
  async comment({ marker: m, payload: { target } }, { gh, cwd }) {
    const posted = (await (target.kind === 'pr' ? gh.prComments : gh.issueComments)(target.number, cwd)).find((c) => carries(c.body, m));
    return posted ? found({ id: posted.id }) : ABSENT;
  },
  async label({ payload }, { issueLabels }) {
    const shown = payload.add.every((l) => has(issueLabels, l)) && payload.remove.every((l) => !has(issueLabels, l));
    return shown ? found({ ok: true }) : ABSENT;
  },
};

export async function findEffect(entry, ctx) {
  try {
    return await FINDERS[entry.action]?.(entry, ctx) ?? ABSENT;
  } catch (error) {
    return { status: 'unknown', error };
  }
}

// A needs-human label a human set overrides the Execution Record, which the abandonment Terminal keeps but marks abandoned.
export async function humanOverride(rec, issueLabels, labelPrefix = 'gg') {
  const state = labels(labelPrefix).state;
  const needsHuman = state('needs-human');
  // A needs-human Terminal that crashed after its label Action shows gg's own label, not a human's.
  const own = rec.log.some((e) => e.step === 'intent' && e.action === 'label' && has(e.payload.add, needsHuman));
  if (own || !has(issueLabels, needsHuman)) return null;
  return { next: 'abandon', cursor: rec.cursor, reason: `#${rec.ticket} carries ${needsHuman} on GitHub, which overrides the record.`,
    inProgress: has(issueLabels, state('in-progress')) };
}

// Saves the evidence of each open intent whose effect its marker shows; the interpreter completes the Action with its
// Event. Returns the first conflict's reason, if any; an unknown lookup throws its error. `find` defaults to
// findEffect; the interpreter passes one that retries a failed remote lookup on the Action's budget.
async function findEffects(entries, ctx, find = findEffect) {
  for (const entry of entries) {
    if (record.proof(ctx.rec, entry.marker)) continue;
    const result = await find(entry, ctx);
    if (result.status === 'unknown') throw result.error;
    if (result.status === 'conflicting') return result.reason;
    if (result.status === 'found') await record.evidence(ctx.rec, entry.marker, result.evidence);
  }
  return null;
}

// A decided hold, fault or abandonment only finishes its report: a human override still wins, and only the intents of
// its own Terminal Actions (`markers`) are looked for, so no older Action's effect is redone, checked or read.
export async function terminalEffects(rec, { gh, labelPrefix = 'gg', cwd, markers, find }) {
  const issueLabels = gh.labelNames(await gh.viewIssue(rec.ticket, cwd));
  const overridden = await humanOverride(rec, issueLabels, labelPrefix);
  if (overridden) return overridden;
  // Its comment and label finders cannot conflict; were one to, the report would stay pending for a human.
  const conflict = await findEffects(record.openIntents(rec).filter((e) => markers.includes(e.marker)), { rec, gh, cwd, issueLabels }, find);
  if (conflict) throw new Error(conflict);
  return { next: 'continue', cursor: rec.cursor, reason: null };
}

export const INTERRUPTED_ADVICE = 'The agent may have changed files before gg stopped, including ignored Protected Files such as '
  + ".claude/settings.local.json. Check them, and restore any it changed, before deleting the record: the Attempt's intent in "
  + 'the record saves the baseline, with the bytes of each untracked Protected File. Or keep the Ticket held until gg can '
  + 'recover Interrupted Attempts (#68).';

// Labels decide whether an Execution continues, the record where (request 3.5). The record is never discarded.
export async function reconcile({ record: rec, flow, git, gh, labelPrefix = 'gg', cwd, find }) {
  if (rec instanceof record.RecordCorruptError) return { next: 'hold', cursor: null, reason: `${rec.message}; it is kept for a human.` };
  const issueLabels = gh.labelNames(await gh.viewIssue(rec.ticket, cwd));
  const overridden = await humanOverride(rec, issueLabels, labelPrefix);
  if (overridden) return overridden;
  const { vertex } = rec.cursor;
  const hold = (reason) => ({ next: 'hold', cursor: rec.cursor, reason });
  // An Interrupted Attempt is held however clean the worktree looks: what its agent changed is not known (ADR 0011).
  // Deleting the record would drop the baseline its intent saved, so the advice says to check the files first.
  const interrupted = record.openIntents(rec).find((e) => e.action === 'call');
  if (interrupted) {
    return { ...hold(`The agent Attempt of Action Marker ${interrupted.marker} was interrupted, so the Ticket is held; nothing was discarded.`),
      name: 'interrupted-attempt', advice: INTERRUPTED_ADVICE };
  }
  if (!TERMINALS.includes(vertex) && !flow.ticket.vertices[vertex]) return hold(`The record continues at Vertex ${vertex}, which the Flow no longer has.`);
  if (await resets(rec, { git }) === 'held') return hold('An interrupted reset did not leave the worktree clean at its baseline; nothing was discarded.');
  const conflict = await findEffects(record.openIntents(rec), { rec, git, gh, cwd, issueLabels }, find);
  if (conflict) return hold(conflict);
  // A completed commit has no open intent to check, and an amend keeps its marker: only the branch tip shows the change.
  const last = record.lastCommit(rec);
  const head = last && await git.headSha(rec.worktree);
  if (last && head !== last.evidence.sha) {
    return hold(`The branch is at ${head}, not at commit ${last.evidence.sha} of Action Marker ${last.marker}, so it was changed by hand; nothing was committed, pushed or discarded.`);
  }
  return { next: 'continue', cursor: rec.cursor, reason: null };
}
