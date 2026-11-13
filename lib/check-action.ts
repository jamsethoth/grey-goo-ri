// The check Action (R1, R4): its Check kind checks, on the tree it read when the kind reads one, and its result is the
// Check signal { id, kind, state, tree }, with the output and reason the recovery Brief and Terminal Reason read.
import * as agentCall from './agent-call.ts';
import * as attempt from './attempt.ts';
import * as checks from './checks.ts';
import * as cleanupHold from './cleanup-hold.ts';
import * as commandCleanup from './command-cleanup.ts';
import * as integrity from './integrity.ts';
import type * as procedures from './procedures.ts';
import type * as record from './record.ts';
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
  failure?: string | null;
  reason?: string;
  output?: string;
  evidence?: visit.ActionOutputValue['evidence'];
  outputs?: visit.ActionOutputValue;
  tree?: string | null;
  // What its command left, or NO_COMMAND's report for a kind that could run one and did not.
  cleanup?: commandCleanup.CallCleanup;
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
    return {
      passed: true,
      ran: false,
      output,
      evidence: { command: line, output },
      cleanup: commandCleanup.NO_COMMAND,
    };
  }
  const run = await checks.greenCheck(line, runContext.record.worktree, { runShell: runContext.exec.runShell });
  const evidence = checks.checkEvidence(line, run);
  // A non-zero exit is recoverable; a timeout or a command that could not start is not (T4c).
  return {
    passed: run.passed,
    ran: true,
    recoverable: !run.timedOut && run.code !== null && run.code !== 127,
    output: evidence.output,
    evidence,
    cleanup: run.cleanup,
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
      cleanup: commandCleanup.NO_COMMAND,
    };
  }
  const line = commandLine(runContext, action);
  const run = await checks.greenCheck(line, executionRecord.worktree, { runShell: runContext.exec.runShell });
  const named = referencePaths.read(visitScope.scopeOf(executionRecord, actionIdentity, state), action.testNames);
  const red = checks.redCheck(run, (named as string[] | undefined) ?? []);
  // A pass found by the test's name alone, with no per-test statuses, says so for the reviewer (J8).
  const evidence = {
    ...checks.checkEvidence(line, run),
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
    cleanup: run.cleanup,
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
  if (kind.tree && !running.state.call)
    running.state.firstAttemptBaseline ??= await agentCall.checkBaseline(runContext);
  const checked = { ...(await kind.run(runContext, { ...running, tree })), tree };
  if (checked.cleanup?.confirmed === false) {
    running.state.unconfirmedCleanup = checked.cleanup as commandCleanup.CleanupReport;
    return checked;
  }
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

// What a Check's run leaves as outputs. Evidence is one only when it passed (N9); a failing pass drops an earlier
// pass's evidence, so nothing reads a pass the last one contradicts.
function outputsOf(checked: Checked): attempt.Outputs {
  const outputs = {
    ...(checked.passed && checked.evidence && { evidence: checked.evidence }),
    ...checked.outputs,
    ...(checked.cleanup && { cleanup: checked.cleanup }),
  };
  return { ...(Object.keys(outputs).length && { outputs }), dropped: checked.passed ? [] : ['evidence'] };
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
  // A pass whose command may still be writing is not a pass of the tree it read.
  if (action.reuse === 'tree' && checked.ran && checked.cleanup?.confirmed !== false) {
    stateDatabase.saveCheckResult(executionRecord.commonDir, {
      tree: signal.tree!,
      command: checked.evidence!.command,
      state: signal.state,
      marker: runContext.markerOf(actionIdentity),
      output: checked.output!,
    });
  }
  state.checks.set(action.id, signal);
  state.runs.set(action.id, {
    output: checked.output ?? null,
    reason: checked.reason ?? null,
    failure: checked.failure ?? null,
    recoverable: !checked.passed && !!checked.recoverable && action.recoverable !== false,
  });
  return signal;
}

// A failure's output is diagnosis, not Evidence: it travels with the signal on the Event and to the Terminal comment
// instead of into the outputs (N9). Only a worktree Check starts processes in the worktree, so only it is busy (request
// 3.6).
export function check(runContext: RunContext, running: visitScope.Running): Promise<visitScope.ActionResolution> {
  const { actionIdentity, action, state } = running;
  const { harnessResult: result, claim, signal: callSignal } = state.call ?? visitScope.IMPLICIT_OK;
  return attempt.run(runContext, {
    actionIdentity,
    busy: CHECK_KINDS[action.kind!].tree,
    settle: running.settle,
    work: () => runCheck(runContext, running),
    outputs: outputsOf,
    finish: (checked) => {
      const signal = keepResult(runContext, running, checked);
      const output = signal.state === 'failed' ? checked.output : undefined;
      const resolution = visitScope.settle(runContext.record, actionIdentity, state, {
        result: callSignal,
        claim,
        checks: visitScope.resolverChecks([], [signal]),
        retries: {},
        cleanup: checked.cleanup,
      });
      return {
        resolution: { reason: checked.reason ?? null, signal, output: output ?? null, ...resolution },
        fields: {
          check: action.id,
          cleanup: checked.cleanup,
          signals: {
            harnessResult: { status: result.status },
            claim,
            checks: [{ ...signal, ...(output && { output }) }],
            integrity: [],
          },
        },
      };
    },
  });
}

// A Check held for cleanup, its processes now confirmed gone (J4, L15). Its result stands on the tree it read; a
// changed one, which the Assertions allowed, leaves no result, so the Visit re-runs its Checks from the first (T1) and
// nothing reads a pass of an older tree.
export async function completeHeld(
  runContext: RunContext,
  running: visitScope.Running,
): Promise<visitScope.ActionResolution | 'rerun-checks'> {
  const { record: executionRecord, git, locks } = runContext;
  const { actionIdentity, action, state } = running;
  const baseline = state.call?.baseline ?? state.firstAttemptBaseline!;
  const completed = await attempt.runHeld(runContext, {
    actionIdentity,
    settle: running.settle,
    work: async () => {
      await agentCall.validateHeld(runContext, running, { baseline, response: state.response });
      const held = visitScope.outputOf(executionRecord, actionIdentity)?.value.cleanup as commandCleanup.CleanupReport;
      const { tree } = await integrity.snapshot(executionRecord.worktree, git, locks);
      return { tree, confirmed: cleanupHold.confirmedReport(held) };
    },
    outputs: ({ confirmed }) => ({ outputs: { cleanup: confirmed } }),
    finish: ({ tree, confirmed }) => {
      const signal = visitScope.checkSignal(state, action.id);
      if (tree !== signal.tree) return { resolution: null };
      const { harnessResult: result, claim, signal: callSignal } = state.call ?? visitScope.IMPLICIT_OK;
      const resolution = visitScope.settle(executionRecord, actionIdentity, state, {
        result: callSignal,
        claim,
        checks: visitScope.resolverChecks([], [signal]),
        retries: {},
      });
      const { output, reason } = visitScope.checkRun(state, action.id);
      return {
        resolution: { reason, signal, output: signal.state === 'failed' ? output : null, ...resolution },
        fields: {
          check: action.id,
          cleanup: confirmed,
          signals: { harnessResult: { status: result.status }, claim, checks: [signal], integrity: [] },
        },
      };
    },
  });
  return completed ?? 'rerun-checks';
}
