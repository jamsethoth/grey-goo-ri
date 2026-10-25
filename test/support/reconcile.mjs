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
export const commitMessages = (g) => golden.sh(g.worktree, 'log', '--format=%B%x00', `${g.base}..HEAD`).split('\0').map((m) => m.trim()).filter(Boolean);
export const remoteSha = (g) => golden.sh(g.mainRoot, 'ls-remote', 'origin', `refs/heads/${golden.BRANCH}`).split('\t')[0] || null;
export const withMarker = (bodies, m) => bodies.filter((b) => b.includes(marker.markerComment(m)));
export const loadTicket = (g) => record.load(g.commonDir, 'ticket', golden.TICKET);

export const EFFECTS = {
  commit: {
    at: ['implementer', 1, 'green', 3],
    happened: (g, m) => commitMessages(g).some((b) => b.includes(marker.markerTrailer(m))),
  },
  push: {
    at: ['implementer', 1, 'green', 4],
    happened: (g) => remoteSha(g) === golden.sh(g.worktree, 'rev-parse', 'HEAD'),
  },
  'PR upsert': {
    at: ['implementer', 1, 'green', 5],
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
