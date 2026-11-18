// The agent call under the Integrity Assertions: an Attempt's baseline and write-ahead intent, the Harness's run with
// its heartbeat, and the violations found after it, Test Immutability included.
import * as checks from './checks.ts';
import type * as commandCleanup from './command-cleanup.ts';
import * as effectErrors from './effect-errors.ts';
import type * as integrity from './integrity.ts';
import type * as jsonValue from './json-value.ts';
import * as record from './record.ts';
import * as referencePaths from './reference-paths.ts';
import type { Harness, HarnessResult, HarnessStarted, RunContext } from './run-context.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';
import * as writeAhead from './write-ahead.ts';

// One Attempt of the agent Action: `resume` and `nudge` come from the Attempt before it, if any.
export interface Attempt extends visitScope.Running {
  resume: string | null;
  nudge: string | null;
}
// What one Attempt's guarded call gave.
export interface Called {
  response: jsonValue.JsonValue;
  result: HarnessResult;
  failure: visit.HarnessFailure | null;
  violations: integrity.IntegrityViolation[];
  baseline: integrity.IntegrityBaseline;
}

// A Harness returns only once its processes are gone, or says it could not confirm that (L6): one that says nothing has
// confirmed nothing.
const UNREPORTED: commandCleanup.CleanupReport = {
  confirmed: false,
  survivors: [],
  reason: 'the Harness reported no cleanup',
  containment: { kind: 'none' },
};

// While an agent call runs its heartbeat is saved about every 60 s on the clock, the call's liveness signal. It proves
// no file the agent's: an Interrupted Attempt's rescue keeps every change, before the last heartbeat or after (V9). A
// heartbeat that cannot be saved stops and fails the call.
async function withHeartbeat<Result>(runContext: RunContext, run: () => Promise<Result>): Promise<Result> {
  const executionRecord = runContext.record;
  let failed: unknown = null;
  const stop = runContext.clock.every(60_000, () => {
    executionRecord.heartbeat = new Date(runContext.clock.now()).toISOString();
    try {
      runContext.database.save(executionRecord);
    } catch (err) {
      failed ??= err;
      stop();
    }
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
  { actionIdentity, state }: visitScope.Running,
  baseline: integrity.IntegrityBaseline,
  called: { response: unknown },
): Promise<integrity.IntegrityViolation | null> {
  const executionRecord = runContext.record;
  let { ok, changed } = await runContext.testImmutability(
    executionRecord.worktree,
    executionRecord.testCommits.baseline ?? baseline.head,
    executionRecord.configurationSnapshot!.testPaths,
  );
  const { tests } = state.procedure;
  if (typeof tests === 'object' && tests?.named) {
    const named = new Set(
      (referencePaths.read(
        { ...visitScope.visitScope(executionRecord, actionIdentity), response: called.response },
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
// Attempt whose intent is open at resume is an Interrupted Attempt, rescued to that baseline before any retry.
export async function guardedCall(
  runContext: RunContext,
  attempt: Attempt,
  call: Record<string, unknown>,
  harness: Harness,
): Promise<Called> {
  const { record: executionRecord } = runContext;
  const access = call.access as string;
  const others = await othersOf(runContext);
  const baseline = await visitBaseline(runContext, others);
  attempt.state.firstAttemptBaseline ??= baseline;
  effectErrors.crashPoint(runContext, call.marker as string, 'before-intent');
  executionRecord.heartbeat = new Date(runContext.clock.now()).toISOString();
  runContext.database.intent(executionRecord, call.marker as string, 'call', { baseline });
  // Neither side keeps an object the other may change: the Harness gets a copy of the call, and gg keeps a copy of the
  // answer, taken before anything reads or keeps it, since every save writes the whole record again.
  const answered = await withHeartbeat(runContext, () =>
    harness.run(structuredClone(call), {
      started: savedContainment(runContext, call.marker as string),
      signal: runContext.runState.signal,
    }),
  );
  // The job handle is no data, and a copy throws on a function it can see, so it comes off the report by name, however
  // the Harness attached it, and is carried over to close the call's processes.
  const reported = answered.result.cleanup as commandCleanup.CleanupReport | undefined;
  const { closeJob, ...report } = reported ?? { confirmed: true, survivors: [] };
  const called = structuredClone(
    reported ? { ...answered, result: { ...answered.result, cleanup: report } } : answered,
  );
  if (closeJob && called.result.cleanup) Object.defineProperty(called.result.cleanup, 'closeJob', { value: closeJob });
  called.result.cleanup ??= UNREPORTED;
  // Its writers may still run, so what a snapshot read now would prove nothing, and the call's validation waits (L15).
  if (!called.result.cleanup.confirmed) {
    attempt.state.unconfirmedCleanup = called.result.cleanup as commandCleanup.CleanupReport;
    return { ...called, violations: [], baseline };
  }
  const violations = await callViolations(runContext, attempt, { baseline, others, access, response: called.response });
  return { ...called, violations, baseline };
}

// The Harness's started report, saved into the call's intent by a second write: the intent is saved before launch, and
// the containment is known only once the call has started (N1). Unsaved, the Interrupted Attempt is held, never reset.
function savedContainment(runContext: RunContext, actionMarker: string) {
  return ({ kind }: HarnessStarted) => {
    const intended = writeAhead.findEntry(runContext.record, actionMarker, 'intent')!;
    intended.payload = { ...(intended.payload as writeAhead.CallPayload), containment: { kind } };
    runContext.database.save(runContext.record);
  };
}

const othersOf = async ({ others: listed }: RunContext) =>
  typeof listed === 'function' ? await listed() : (listed ?? []);

// What the Integrity Assertions compare an Action's run with: a snapshot of the worktree as it stands.
const visitBaseline = (runContext: RunContext, others: string[]) =>
  runContext.integrity.takeBaseline({
    record: runContext.record,
    others,
    protectedPaths: runContext.protectedPaths,
    testPaths: checks.testPathSet(runContext.record.configurationSnapshot!.testPaths),
    database: runContext.database,
  });

// The baseline of a Check with no agent Action before it, whose run is otherwise compared with nothing if it holds for
// cleanup (L15): a Check starts no agent, so the Visit's first Attempt never takes one.
export async function checkBaseline(runContext: RunContext): Promise<integrity.IntegrityBaseline> {
  return visitBaseline(runContext, await othersOf(runContext));
}

// The fixed Integrity Assertions against a baseline, Test Immutability included. `others` are the worktrees that
// baseline guarded, read once per Attempt.
async function callViolations(
  runContext: RunContext,
  running: visitScope.Running,
  {
    baseline,
    others,
    access,
    response,
  }: { baseline: integrity.IntegrityBaseline; others: string[]; access: string; response: unknown },
) {
  const { violations } = await runContext.integrity.findViolations({
    baseline,
    record: runContext.record,
    others,
    access,
    protectedPaths: runContext.protectedPaths,
    database: runContext.database,
  });
  if (access !== 'read-only' && running.state.procedure.tests !== 'write') {
    const violation = await changedTests(runContext, running, baseline, { response });
    if (violation) violations.push(violation);
  }
  return violations;
}

// A held call's validation at a later Run, once its containment confirms its writers gone: every fixed Assertion
// against its original baseline, before any Check, commit or routing (L15). While the Ticket waited a human could
// change the worktree as well as a survivor, and nothing tells them apart. A rollback is safe only for what the agent
// made (request 3.5), so whatever broke an Assertion holds the Ticket and is kept.
export async function validateHeld(
  runContext: RunContext,
  running: visitScope.Running,
  { baseline, response }: { baseline: integrity.IntegrityBaseline; response: unknown },
): Promise<void> {
  const violations = await callViolations(runContext, running, {
    baseline,
    others: await othersOf(runContext),
    access: runContext.record.configurationSnapshot!.access,
    response,
  });
  if (!violations.length) return;
  const surfaces = [...new Set(violations.map(({ surface }) => surface))];
  const changed = violations.flatMap(({ after }) => (Array.isArray(after) ? after : []));
  throw new effectErrors.EarlyTerminalError({
    next: 'hold',
    name: 'changed-while-held',
    reason:
      `${surfaces.join(' and ')} changed while the Ticket waited for its cleanup, by a survivor or a human, so the ` +
      'Ticket is held and nothing was reset.',
    ...(changed.length && { detail: changed.join('\n') }),
  });
}
