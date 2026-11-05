// How the golden fixture's suite (test/support/add-suite.ts) answers, changed by a case around the suite it runs.
import type * as runContext from '../../lib/run-context.ts';

// A run as the fake suite reports it: an exit code, the output, and whether it timed out.
export interface SuiteRun {
  code: number | null;
  output: string;
  timedOut?: boolean;
  [field: string]: unknown;
}

type Exec = runContext.Deps['exec'];
type Ran = { options: { deps: { exec: Exec } } };
const runOf = (exec: Exec) => exec.runShell as (command: string, options?: { cwd?: string }) => Promise<SuiteRun>;

// Each command runs on the suite as before; `edit` then sees its result and command and returns the result gg gets.
export function editRuns(
  fixture: Ran,
  edit: (result: SuiteRun, command: string) => SuiteRun | Promise<SuiteRun>,
): void {
  const runShell = runOf(fixture.options.deps.exec);
  fixture.options.deps.exec.runShell = (async (command: string, options?: { cwd?: string }) =>
    edit(await runShell(command, options), command)) as Exec['runShell'];
}

// `command` gets `answer`'s result without reaching the suite; every other command runs on the suite as before.
export function answerCommand(fixture: Ran, command: string, answer: () => SuiteRun | Promise<SuiteRun>): void {
  const runShell = runOf(fixture.options.deps.exec);
  fixture.options.deps.exec.runShell = (async (run: string, options?: { cwd?: string }) =>
    run === command ? answer() : runShell(run, options)) as Exec['runShell'];
}

// Every command gets `answer`'s result, and none reaches the suite.
export function answerAll(
  fixture: Ran,
  answer: (command: string, options?: { cwd?: string }) => SuiteRun | undefined | Promise<SuiteRun | undefined>,
): void {
  fixture.options.deps.exec = {
    runShell: async (command: string, options?: { cwd?: string }) => answer(command, options),
  } as Exec;
}
