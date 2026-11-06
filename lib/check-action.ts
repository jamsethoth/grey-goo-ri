// The check Action (R1, R4): its Check kind checks, on the tree it read when the kind reads one, and its result is the
// Check signal { id, kind, state, tree }, with the output and reason the recovery Brief and Terminal Reason read.
import * as checks from './checks.ts';
import * as effects from './effects.ts';
import * as integrity from './integrity.ts';
import type * as procedures from './procedures.ts';
import * as referencePaths from './reference-paths.ts';
import type { RunContext } from './run-context.ts';
import * as stateDatabase from './state-database.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';

// What a Check kind's run found: whether it passed and, on a failure, whether a recovery pass can fix it (and, for a
// kind with several such failures, which: `failure`), with its reason and output; `ran` when it ran a command.
interface Checked {
  passed: boolean;
  ran: boolean;
  recoverable?: boolean;
  failure?: unknown;
  reason?: string;
  output?: string;
  evidence?: { command: string; output: string; [field: string]: unknown };
  outputs?: Record<string, unknown>;
  tree?: string | null;
}
// One run of a Check kind: the Action as the Visit runs it, and the tree it checks, if it reads one.
interface Checking extends visitScope.Running {
  tree: string | null;
}
// A Check kind (procedures.CHECK_KEYS; R4, U13, T4c). A `tree` kind reads the worktree, so its result holds only on the
// tree it checked (R1b); the others read the agent's response.
interface CheckKind {
  tree: boolean;
  run(runContext: RunContext, checking: Checking): Promise<Checked>;
}

const commandLine = (runContext: RunContext, action: procedures.Action) =>
  runContext.record.configurationSnapshot!.commands[action.command as string] as string;

// A Declared Command's exit. With `reuse: tree`, a pass this repository recorded for the same tree and command line
// stands in for the run, and its output says which run (L8, L13); a failure is never reused.
async function commandCheck(runContext: RunContext, { action, tree }: Checking): Promise<Checked> {
  const line = commandLine(runContext, action);
  const reused = action.reuse === 'tree' ? stateDatabase.reusablePass(runContext.record.commonDir, tree!, line) : null;
  if (reused) {
    const output = `Reused the passing run of ${reused.marker} on this tree.\n${reused.output}`;
    return { passed: true, ran: false, output, evidence: { command: line, output } };
  }
  const run = await checks.greenCheck(line, runContext.record.worktree, { runShell: runContext.exec.runShell });
  const evidence = checks.evidence(line, run);
  // A non-zero exit is recoverable; a timeout or a command that could not start is not (T4c).
  return {
    passed: run.passed,
    ran: true,
    recoverable: !run.timedOut && run.code !== null && run.code !== 127,
    output: evidence.output,
    evidence,
  };
}

// The named tests fail before implementation. A test file under testPaths must have changed since the Visit's
// baseline, added, modified, deleted or renamed, untracked included; if none did, the command is not run (U2, K7, V8).
async function testsFailCheck(runContext: RunContext, { actionIdentity, action, state }: Checking): Promise<Checked> {
  const { record: executionRecord, git } = runContext;
  const { testPaths } = executionRecord.configurationSnapshot!;
  const since = state.firstAttemptBaseline?.head ?? (await git.headSha(executionRecord.worktree));
  const tracked = (await git.changedSince(executionRecord.worktree, since)).filter(checks.testPathMatcher(testPaths));
  // An untracked test, ignored ones included, counts only if it differs from the baseline's: build output left under a
  // test glob before the Visit is not a test written in it.
  const before = state.firstAttemptBaseline?.tests ?? {};
  const now = await integrity.untrackedFiles(executionRecord.worktree, checks.testPathSet(testPaths), git);
  const untracked = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(
    (path) => !integrity.sameFile(before[path], now[path]),
  );
  if (!tracked.length && !untracked.length) {
    return {
      passed: false,
      ran: false,
      recoverable: true,
      failure: 'unchanged',
      reason: "No file under testPaths changed since the Visit's baseline, so no test was written.",
    };
  }
  const line = commandLine(runContext, action);
  const run = await checks.greenCheck(line, executionRecord.worktree, { runShell: runContext.exec.runShell });
  const named = referencePaths.read(visitScope.scopeOf(executionRecord, actionIdentity, state), action.testNames);
  const red = checks.redCheck(run, (named as string[] | undefined) ?? []);
  // A pass found by the test's name alone, with no per-test statuses, says so for the reviewer (J8).
  const evidence = {
    ...checks.evidence(line, run),
    ...(red.ok && red.foundByNameOnly && { foundByNameOnly: true }),
  };
  // Named tests that passed, or that the output does not name, are recoverable (T4c, N5); a timeout or a runner that
  // could not start is not.
  return {
    passed: red.ok,
    ran: true,
    recoverable: !!red.failure,
    failure: red.failure ?? null,
    reason: red.reason,
    output: evidence.output,
    evidence,
  };
}

const CHECK_KINDS: Record<procedures.CheckKind, CheckKind> = {
  command: { tree: true, run: commandCheck },
  'tests-fail': { tree: true, run: testsFailCheck },
  // Conditions on the agent's response, `allOf` passing when each holds (R4a, P5d).
  response: {
    tree: false,
    async run(_runContext, { action, state }) {
      const { passed, reasons } = checks.responseCheck(state.response, action as checks.ResponseCondition);
      return { passed, ran: false, reason: reasons.join('\n') || undefined };
    },
  },
  // Fails when the list repeats one an earlier Visit of this Vertex recorded in this Execution (R4c); its hash is an
  // output.
  repeat: {
    tree: false,
    async run(runContext, { actionIdentity, action, state }) {
      const list = referencePaths.read(visitScope.scopeOf(runContext.record, actionIdentity, state), action.list);
      const hash = checks.findingsHash(
        (list as Record<string, unknown>[] | undefined) ?? [],
        action.fields as string[],
      );
      const repeat = runContext.record.outputs.some(
        (output) =>
          output.vertex === actionIdentity.vertex &&
          output.action === actionIdentity.action &&
          output.visit !== actionIdentity.visit &&
          output.value.findingsHash === hash,
      );
      return { passed: !repeat, ran: false, outputs: { findingsHash: hash } };
    },
  },
};

// Runs the Check on the tree it reads. A Check must leave the tree it checked as it found it (T1b).
async function runCheck(runContext: RunContext, running: visitScope.Running): Promise<Checked> {
  const { record: executionRecord, git, locks } = runContext;
  const { action } = running;
  const kind = CHECK_KINDS[action.kind!];
  const tree = kind.tree ? (await integrity.snapshot(executionRecord.worktree, git, locks)).tree : null;
  const checked = { ...(await kind.run(runContext, { ...running, tree })), tree };
  if (checked.ran && tree && (await integrity.snapshot(executionRecord.worktree, git, locks)).tree !== tree) {
    Object.assign(checked, {
      passed: false,
      recoverable: false,
      failure: null,
      reason: `The ${action.kind} Check ${action.id} changed the worktree, so its result does not count.`,
    });
  }
  return checked;
}

// The Check signal and what the recovery Brief and the Terminal Reason read of its run. `recoverable: false` on the
// Check opts out of its kind's recoverable failures (T4c).
function keepResult(runContext: RunContext, { actionIdentity, action, state }: visitScope.Running, checked: Checked) {
  const executionRecord = runContext.record;
  const signal: visit.CheckSignal = {
    id: action.id,
    kind: action.kind!,
    state: checked.passed ? 'passed' : 'failed',
    tree: checked.tree ?? null,
  };
  if (action.reuse === 'tree' && checked.ran) {
    stateDatabase.saveCheckResult(executionRecord.commonDir, {
      tree: signal.tree!,
      command: checked.evidence!.command,
      state: signal.state,
      marker: runContext.markerOf(actionIdentity),
      output: checked.output!,
    });
  }
  state.checks[action.id] = signal;
  state.runs[action.id] = {
    output: checked.output ?? null,
    reason: checked.reason ?? null,
    failure: checked.failure ?? null,
    recoverable: !checked.passed && !!checked.recoverable && action.recoverable !== false,
  };
  // Evidence is an output only when it passed (N9); a failing pass drops an earlier pass's evidence, so nothing reads a
  // pass the last one contradicts.
  if (checked.passed && checked.evidence)
    visitScope.recordOutput(executionRecord, actionIdentity, { evidence: checked.evidence });
  else if (!checked.passed) delete visitScope.outputOf(executionRecord, actionIdentity)?.value.evidence;
  if (checked.outputs) visitScope.recordOutput(executionRecord, actionIdentity, checked.outputs);
  return signal;
}

// A failure's output is diagnosis, not proof: it travels with the signal on the Event and to the Terminal comment
// instead of into the outputs (N9). Only a worktree Check starts processes in the worktree, so only it is bracketed
// (request 3.6).
export async function check(runContext: RunContext, running: visitScope.Running): Promise<visitScope.ActionResolution> {
  const { actionIdentity, action, state } = running;
  const startedAt = runContext.clock.now();
  const { harnessResult: result, claim, signal: callSignal } = state.call ?? visitScope.IMPLICIT_OK;
  const work = () => runCheck(runContext, running);
  const checked = CHECK_KINDS[action.kind!].tree ? await effects.bracket(runContext, work) : await work();
  const signal = keepResult(runContext, running, checked);
  const output = signal.state === 'failed' ? checked.output : undefined;
  const resolution = visitScope.settle(runContext.record, actionIdentity, state, {
    result: callSignal,
    claim,
    checks: visitScope.resolverChecks([], [signal]),
    retries: {},
  });
  return effects.finish(runContext, {
    actionIdentity,
    startedAt,
    resolution: { reason: checked.reason ?? null, signal, output: output ?? null, ...resolution },
    fields: {
      check: action.id,
      signals: {
        harnessResult: { status: result.status },
        claim,
        checks: [{ ...signal, ...(output && { output }) }],
        integrity: [],
      },
    },
  });
}
