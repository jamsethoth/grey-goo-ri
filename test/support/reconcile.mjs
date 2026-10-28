// Helpers the reconcile test files share.
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.mjs';
import * as marker from '../../lib/marker.mjs';
import * as record from '../../lib/record.mjs';
import * as golden from './golden.mjs';

export const resetEntries = (rec) => rec.log.filter((e) => e.action === 'reset').map((e) => e.step);

export const markerOf = (rec, vertex, visit, phase, ordinal) =>
  marker.formatMarker({ execution: rec.execution, vertex, visit, phase, ordinal, run: rec.run, attempt: 1 });
export const stepsOf = (rec, m) => rec.log.filter((e) => e.marker === m).map((e) => e.step);
// Read through the git the case runs on, real or fake. The messages are the branch's commits since base, newest first.
export async function branchMessages(g) {
  const log = await g.options.git.commitLog(g.worktree, golden.BRANCH);
  return log.slice(0, log.findIndex((c) => c.sha === g.base)).map((c) => c.message);
}
export const originSha = (g) => g.options.git.remoteSha(g.mainRoot, golden.BRANCH);
export const withMarker = (bodies, m) => bodies.filter((b) => b.includes(marker.markerComment(m)));
export const loadTicket = (g) => record.load(g.commonDir, 'ticket', golden.TICKET);

export const EFFECTS = {
  commit: {
    at: ['green', 1, 'green', 3],
    happened: async (g, m) => (await branchMessages(g)).some((b) => b.includes(marker.markerTrailer(m))),
  },
  push: {
    at: ['green', 1, 'green', 4],
    happened: async (g) => (await originSha(g)) === (await g.options.git.headSha(g.worktree)),
  },
  'PR upsert': {
    at: ['green', 1, 'green', 5],
    happened: (g, m) => !!g.gh.pr()?.body.includes(marker.markerComment(m)),
  },
  comment: {
    at: ['done', 1, 'done', 2],
    happened: (g, m) => withMarker(g.gh.comments.map((c) => c.body), m).length > 0,
  },
};

export const POINTS = {
  'before-effect': { name: (a) => `golden: crash before the ${a} effect resumes by redoing it`, happened: false, steps: ['intent'] },
  'after-effect': { name: (a) => `golden: crash after the ${a} effect resumes by completing it`, happened: true, steps: ['intent'] },
  'after-completion': { name: (a) => `golden: crash after ${a} completion resumes past it`, happened: true, steps: ['intent', 'evidence', 'complete'] },
};

// Runs the golden Execution until crashAt fires at `point` of the Action at `at`, and returns the freshly loaded record.
export async function crashed(g, at, point) {
  const m = markerOf(g.rec, ...at);
  await assert.rejects(interpreter.runExecution({ ...g.options, crashAt: { marker: m, point } }),
    (err) => err instanceof interpreter.CrashError);
  return { m, loaded: await loadTicket(g) };
}

export const NEEDS_HUMAN = 'gg:state:needs-human';
export const reconcileArgs = (g, rec, flow = g.flow) =>
  ({ record: rec, flow, git: g.options.git, gh: g.options.gh, labelPrefix: 'gg', cwd: g.mainRoot });
