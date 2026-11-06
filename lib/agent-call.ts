// The agent call under the Integrity Assertions: an Attempt's baseline and write-ahead intent, the Harness's run with
// its heartbeat, and the violations found after it, Test Immutability included.
import * as checks from './checks.ts';
import * as effectErrors from './effect-errors.ts';
import type * as integrity from './integrity.ts';
import * as record from './record.ts';
import * as referencePaths from './reference-paths.ts';
import type { Harness, HarnessResult, RunContext } from './run-context.ts';
import type * as visit from './visit.ts';
import type * as visitScope from './visit-scope.ts';

// One Attempt of the agent Action: `resume` and `nudge` come from the Attempt before it, if any.
export interface Attempt extends visitScope.Running {
  resume: string | null;
  nudge: string | null;
}
// What one Attempt's guarded call gave.
export interface Called {
  response: unknown;
  result: HarnessResult;
  failure: visit.HarnessFailure | null;
  violations: integrity.IntegrityViolation[];
  baseline: integrity.IntegrityBaseline;
}

// While an agent call runs its heartbeat is saved about every 60 s on the clock: a file modified after the last one is
// not the agent's (ADR 0011). A heartbeat that cannot be saved stops and fails the call.
async function withHeartbeat<Result>(runContext: RunContext, run: () => Promise<Result>): Promise<Result> {
  const executionRecord = runContext.record;
  let failed: unknown = null;
  const stop = runContext.clock.every(60_000, () => {
    executionRecord.heartbeat = new Date(runContext.clock.now()).toISOString();
    runContext.database.save(executionRecord).catch((err: unknown) => {
      failed ??= err;
      stop();
    });
  });
  try {
    const result = await run();
    if (failed) throw failed;
    return result;
  } finally {
    stop();
    executionRecord.heartbeat = null;
  }
}

// A write Vertex's agent leaves each committed test as the last gg commit, or else the Execution base, has it (R3); a
// Procedure that writes tests is not held to it, and `tests: named` frees the tests its reference names.
async function changedTests(
  runContext: RunContext,
  { actionIdentity, state }: Attempt,
  baseline: integrity.IntegrityBaseline,
  called: { response: unknown },
): Promise<integrity.IntegrityViolation | null> {
  const executionRecord = runContext.record;
  let { ok, changed } = await runContext.testImmutability(
    executionRecord.worktree,
    executionRecord.testCommits.baseline ?? baseline.head,
    executionRecord.configurationSnapshot!.testPaths,
  );
  const { tests } = state.proc;
  if (typeof tests === 'object' && tests?.named) {
    const named = new Set(
      (referencePaths.read(
        { ...record.visitScope(executionRecord, actionIdentity), response: called.response },
        tests.named,
      ) as string[]) ?? [],
    );
    changed = changed.filter((path) => !named.has(path));
    ok = changed.length === 0;
  }
  return ok ? null : { worktree: executionRecord.worktree, surface: 'committed tests', before: null, after: changed };
}

// The call under the Integrity Assertions. The snapshots are git processes in this worktree, so they run inside the
// busy interval too (request 3.6). The other worktrees are read once per Attempt, so takeBaseline and findViolations
// guard the same worktrees, including any created since admission. The intent is written ahead with its baseline: an
// Attempt whose intent is open at resume is an Interrupted Attempt, held rather than run again on a new baseline.
export async function guardedCall(
  runContext: RunContext,
  attempt: Attempt,
  call: Record<string, unknown>,
  harness: Harness,
): Promise<Called> {
  const { record: executionRecord, protectedPaths, others: listed } = runContext;
  const access = call.access as string;
  const others = typeof listed === 'function' ? await listed() : (listed ?? []);
  const baseline = await runContext.integrity.takeBaseline({
    record: executionRecord,
    others,
    protectedPaths,
    testPaths: checks.testPathSet(executionRecord.configurationSnapshot!.testPaths),
  });
  attempt.state.firstAttemptBaseline ??= baseline;
  effectErrors.crashPoint(runContext, call.marker as string, 'before-intent');
  executionRecord.heartbeat = new Date(runContext.clock.now()).toISOString();
  await runContext.database.intent(executionRecord, call.marker as string, 'call', { baseline });
  const called = await withHeartbeat(runContext, () => harness.run(call));
  const { violations } = await runContext.integrity.findViolations({
    baseline,
    record: executionRecord,
    others,
    access,
    protectedPaths,
  });
  if (access !== 'read-only' && attempt.state.proc.tests !== 'write') {
    const violation = await changedTests(runContext, attempt, baseline, called);
    if (violation) violations.push(violation);
  }
  return { ...called, violations, baseline };
}
