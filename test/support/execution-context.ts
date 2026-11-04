// The context the effects and Terminal functions read, as runExecution builds it, over a temp State Database, the
// fake gh transport and an injected clock. Each case gets its own and removes it when it ends.
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as events from '../../lib/events.ts';
import * as github from '../../lib/github.ts';
import * as marker from '../../lib/marker.ts';
import * as record from '../../lib/record.ts';
import * as render from '../../lib/render.mjs';
import * as sqlite from '../../lib/sqlite.ts';
import * as golden from './golden.mjs';

export const TICKET = golden.TICKET;
export const NEEDS_HUMAN_LABEL = 'gg:state:needs-human';
export const IN_PROGRESS_LABEL = 'gg:state:in-progress';

interface EmittedEvent extends Record<string, unknown> {
  startedAt: number;
}

export async function executionContext(t: TestContext) {
  const commonDir = await mkdtemp(join(tmpdir(), 'gg-effects-'));
  t.after(async () => {
    sqlite.close(commonDir);
    await rm(commonDir, { recursive: true, force: true });
  });
  const executionRecord = record.createExecution({
    commonDir,
    ticket: TICKET,
    flow: { name: 'default', entry: 'green' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'worktree'),
    branch: golden.BRANCH,
    base: 'main',
  });
  const fakeGh = golden.fakeGh({ branch: golden.BRANCH });
  const sleeps: number[] = [];
  const logs: string[] = [];
  const emitted: EmittedEvent[] = [];
  const time = { now: Date.parse('2026-10-15T00:00:00Z') };
  const clock = {
    now: () => time.now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time.now += ms;
    },
  };
  const context = {
    record: executionRecord,
    database: record.stateDatabase(),
    events: events.eventLog(commonDir),
    run: 'run-1',
    runState: { stop: null as unknown, remoteNotBefore: 0 },
    clock,
    gh: github.createGh(fakeGh.gh),
    cwd: commonDir,
    labelPrefix: 'gg',
    log: (line: string) => logs.push(line),
    publicText: (text: string) => render.publicText(text),
    emit: (actionRef: object, startedAt: number, fields: object) =>
      emitted.push({ ...actionRef, startedAt, ...fields }),
    markerOf: (actionRef: marker.ActionRef) =>
      marker.formatMarker({ execution: executionRecord.execution, run: executionRecord.run, attempt: 1, ...actionRef }),
    // As runExecution's: the cursor moves to the Action, saved before it runs.
    enter: async (actionRef: marker.ActionRef) => {
      const { vertex, visit, action, recovery } = actionRef;
      executionRecord.cursor = { vertex, visit, action, recovery, attempt: 1 };
      await record.save(executionRecord);
    },
  };
  return { context, executionRecord, fakeGh, sleeps, logs, emitted, commonDir };
}

// A remote Action's identity at the green Vertex, where a run stop ends the Execution.
export const PUSH_REF = { vertex: 'green', visit: 1, procedure: 'implement', action: 'push', recovery: 0 };

// The fake gh's comment post, which a case fails with an HTTP status.
export const commentPost = (args: string[]) => golden.isCommentPost(args);
