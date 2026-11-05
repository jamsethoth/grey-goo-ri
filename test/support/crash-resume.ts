// The golden Execution crashed at one effect's crash point, and the options Reconciliation reads it back with.
import assert from 'node:assert/strict';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as reconcile from '../../lib/reconcile.ts';
import * as record from '../../lib/record.ts';
import * as executionReads from './execution-reads.ts';
import * as golden from './golden.ts';

type GoldenFixture = golden.GoldenFixture;

export const resetEntries = (executionRecord: record.ExecutionRecord) =>
  executionRecord.writeAheadLog.filter((entry) => entry.effect === 'reset').map((entry) => entry.step);

export const withMarker = (bodies: string[], actionMarker: string) =>
  bodies.filter((body) => body.includes(marker.markerComment(actionMarker)));

interface Effect {
  place: golden.MarkerPlace;
  happened: (fixture: GoldenFixture, actionMarker: string) => boolean | Promise<boolean>;
}

// Each write-ahead effect of the golden Execution: where its Action is, and whether its side effect happened.
export const EFFECTS: Record<string, Effect> = {
  commit: {
    place: ['green', 1, 'commit', 0],
    happened: async (fixture, actionMarker) =>
      (await executionReads.branchMessages(fixture)).some((body) => body.includes(marker.markerTrailer(actionMarker))),
  },
  push: {
    place: ['green', 1, 'push', 0],
    happened: async (fixture) =>
      (await executionReads.originSha(fixture)) === (await fixture.options.deps.git.headSha(fixture.worktree)),
  },
  'PR upsert': {
    place: ['green', 1, 'pr', 0],
    happened: (fixture, actionMarker) => {
      const pr = fixture.gh.pr();
      return !!pr && (pr.body as string).includes(marker.markerComment(actionMarker));
    },
  },
  // publish's pr-ready, whose saved target a resume publishes.
  'pr-ready': {
    place: ['publish', 1, 'pr-ready', 0],
    happened: (fixture) => fixture.gh.pr()?.isDraft === false,
  },
  comment: {
    place: ['ready-for-qa', 1, 'end-comment', 0],
    happened: (fixture, actionMarker) =>
      withMarker(
        fixture.gh.comments.map((comment) => comment.body),
        actionMarker,
      ).length > 0,
  },
};

export const POINTS = {
  'before-effect': {
    name: (effect: string) => `golden: crash before the ${effect} effect resumes by redoing it`,
    happened: false,
    steps: ['intent'],
  },
  'after-effect': {
    name: (effect: string) => `golden: crash after the ${effect} effect resumes by completing it`,
    happened: true,
    steps: ['intent'],
  },
  'after-completion': {
    name: (effect: string) => `golden: crash after ${effect} completion resumes past it`,
    happened: true,
    steps: ['intent', 'evidence', 'complete'],
  },
};

// Runs the golden Execution until crashAt fires at `point` of the Action at `place`, and returns that Action's marker
// and the freshly loaded record.
export async function crashed(fixture: GoldenFixture, place: golden.MarkerPlace, point: keyof typeof POINTS) {
  const actionMarker = golden.markerOf(fixture.executionRecord, ...place);
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, crashAt: { marker: actionMarker, point } }),
    (err) => err instanceof interpreter.CrashError,
  );
  return { actionMarker, loaded: await executionReads.loadTicket(fixture) };
}

// What Reconciliation reads a record with. A record that failed to load is passed as `corrupt`, as admission passes it.
export const reconcileOptions = (
  fixture: GoldenFixture,
  loaded: record.ExecutionRecord | record.RecordCorruptError,
  flow = fixture.flow,
): reconcile.ReconcileOptions => ({
  ...(loaded instanceof record.RecordCorruptError ? { corrupt: loaded } : { record: loaded }),
  flow: flow as reconcile.ReconciledFlow,
  git: fixture.options.deps.git,
  gh: fixture.options.deps.gh,
  labelPrefix: 'gg',
  cwd: fixture.mainRoot,
});
