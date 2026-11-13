// The Run context the effects, Attempts and Terminal functions read, built as runExecution builds it, over a temp State
// Database, the fake gh transport and an injected clock. Each case gets its own and removes it when it ends.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as comment from '../../lib/effects/comment.ts';
import * as sideEffect from '../../lib/effects/side-effect.ts';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import * as remoteEffects from '../../lib/remote-effects.ts';
import * as publicText from '../../lib/public-text.ts';
import * as runContextModule from '../../lib/run-context.ts';
import * as fakeGhModule from './fake-gh.ts';
import * as golden from './golden.ts';
import * as pinnedValue from './pinned-value.ts';
import * as tempDirectory from './temp-directory.ts';

export { TICKET } from './golden.ts';
const { TICKET } = golden;
export const NEEDS_HUMAN_LABEL = 'gg:state:needs-human';
export const IN_PROGRESS_LABEL = 'gg:state:in-progress';
// No case here reads a file, command or test path.
const NOTHING_CONFIGURED = { files: {}, commands: {}, testPaths: [] };

export async function executionContext(t: TestContext) {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-effects-');
  const executionRecord = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: TICKET,
    flow: { name: 'default', entry: 'green' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'worktree'),
    branch: golden.BRANCH,
    base: 'main',
  });
  const fakeGh = fakeGhModule.fakeGh({ branch: golden.BRANCH, ticket: TICKET });
  const sleeps: number[] = [];
  const logs: string[] = [];
  const time = { now: Date.parse('2026-10-15T00:00:00Z') };
  const clock = {
    now: () => time.now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time.now += ms;
    },
    // No case here runs a heartbeat.
    every: () => () => {},
  };
  // The real Run context, so each Action is entered, marked and recorded as runExecution's are.
  const context = runContextModule.createRunContext({
    deps: {
      gh: github.createGh(fakeGh.gh),
      // No case here reaches a git verb: the effects take git from their caller, and no Terminal here is ready-for-qa.
      git: {} as runContextModule.RunGit,
      exec: {} as runContextModule.Deps['exec'],
      database: record.createStateDatabase(),
      clock,
    },
    pinned: pinnedValue.pinnedOf(NOTHING_CONFIGURED, golden.resolve(golden.goldenConfig()), executionRecord.configHash),
    record: executionRecord,
    events: events.eventLog(commonDir),
    protectedPaths: [],
    run: 'run-1',
    runState: { stop: null, remoteNotBefore: 0 },
    cwd: commonDir,
    labelPrefix: 'gg',
    log: (line: string) => logs.push(line),
    publicText: (text: string) => publicText.publicText(text),
  });
  return { context, executionRecord, fakeGh, sleeps, logs, commonDir };
}

export type ExecutionContext = Awaited<ReturnType<typeof executionContext>>['context'];

// The Action Events an Execution has recorded, read back from the State Database.
export const actionEvents = (executionRecord: record.ExecutionRecord): events.ActionEvent[] =>
  eventRead
    .executionEvents(executionRecord.commonDir, executionRecord.execution, (err) => assert.fail(err.message))
    .filter((event): event is events.ActionEvent => event.type === 'action');

// A remote Action's identity at the green Vertex, where a run stop ends the Execution.
export const PUSH_ACTION_IDENTITY = { vertex: 'green', visit: 1, procedure: 'implement', action: 'push', recovery: 0 };

// The fake gh's comment post, which a case fails with an HTTP status.
export const commentPost = (args: string[]) => fakeGhModule.isCommentPost(args);

// A remote comment Action on the Ticket at PUSH_ACTION_IDENTITY, as the comment Action posts it: its body carries its
// marker.
function commentEffect(context: ExecutionContext) {
  const actionMarker = context.markerOf(PUSH_ACTION_IDENTITY);
  return {
    actionMarker,
    effect: comment.effect,
    payload: {
      target: { kind: 'issue', number: TICKET },
      body: `A comment.\n${marker.markerComment(actionMarker)}`,
      bodyHash: 'hash',
    },
  };
}

// The remote comment launched as an Action launches it, write-ahead.
export const remoteComment = (context: ExecutionContext) => sideEffect.sideEffect(context, commentEffect(context));

// The remote comment's launch alone, after its intent is logged as sideEffect logs it: a run stop's source and a spent
// budget's effect are read from that intent.
export async function remoteCommentLaunch(context: ExecutionContext) {
  const { actionMarker, effect, payload } = commentEffect(context);
  context.database.intent(context.record, actionMarker, effect.name, payload);
  return remoteEffects.remoteEffect(context, { actionMarker, effect: effect.name, payload }, (planned) =>
    effect.perform(context, planned, { redo: false }),
  );
}

// What a promise rejects with; a promise that resolves fails the case.
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}
