// The child scripts the exec contract suites run, and the command lines that start them. Each script takes its inputs
// as arguments; with none, as the test runner loads it, it does nothing. Spawns nothing itself.
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as caseEnv from './case-env.ts';
import * as processProbe from './process-probe.ts';

// How long a test process lives unless it is killed: longer than any case, so no command ends on its own first.
export const LIVES_MS = 600_000;

const childScript = (name: string) => fileURLToPath(new URL(`./child-scripts/${name}.ts`, import.meta.url));
export const LONG_LIVED = childScript('long-lived');
export const ORPHAN_MIDDLE = childScript('orphan-middle');
export const CHILD_STARTER = childScript('child-starter');
export const LINKED_STARTER = childScript('linked-starter');
export const DETACHED_CHILD = childScript('detached-child');
export const WAITS_FOR_FILE = childScript('waits-for-file');
export const PRINTS_LINE = childScript('prints-line');
export const STDIN_EOF = childScript('stdin-eof');
export const SPLIT_CHARACTER = childScript('split-character');
export const SHELL_CALLER = childScript('shell-caller');
export const SLOW_TASKKILL = childScript('slow-taskkill');
export const FAILING_TASKKILL = childScript('failing-taskkill');
export const FORGED_JOB_NOTES = childScript('forged-job-notes');
export const BREAKAWAY_CHILD = childScript('breakaway-child');
export const BACKGROUND_STARTER = childScript('background-starter');
export const BACKGROUND_WRITER = childScript('background-writer');
export const SHIFTED_PS = childScript('shifted-ps');

// The command line that runs node with these arguments. No value is written into it: each is set in an environment
// variable for the case, and the line names the variable in double quotes. sh never parses an expanded "$NAME" again;
// cmd.exe expands %NAME% once and then parses the line, where the quotes keep `&`, `|`, `^` and the like plain. So a
// `$`, `%` or `&` in a path stays a plain character, where a quoted path would be expanded by sh or cmd.exe. A name is
// derived from its value, so two commands in one case never give one name two values.
export function nodeCommand(t: TestContext, ...args: string[]) {
  // A case past its timeout has run its cleanup, so a variable set now would outlive it.
  t.signal.throwIfAborted();
  // A " would close cmd.exe's quotes early; no Windows path holds one, so it is refused, never escaped, before any
  // variable is set.
  const quoted = args.find((value) => value.includes('"'));
  if (process.platform === 'win32' && quoted !== undefined) {
    throw new Error(`nodeCommand cannot pass a " to cmd.exe: ${quoted}`);
  }
  return [process.execPath, ...args]
    .map((value) => {
      // cmd.exe leaves %NAME% as it is when NAME is empty, so an empty argument is written as one.
      if (value === '') return '""';
      const name = `GG_TEST_ARG_${createHash('sha256').update(value).digest('hex').slice(0, 16).toUpperCase()}`;
      // set once per case: a second caseEnv would restore the value the first had set, after the first removed it
      if (process.env[name] !== value) caseEnv.caseEnv(t, { [name]: value });
      return process.platform === 'win32' ? `"%${name}%"` : `"$${name}"`;
    })
    .join(' ');
}

// A command whose child starts a middle process, which writes midFile, starts a detached grandchild that writes
// pidFile, and lingers until goFile exists; then it exits, leaving the grandchild an orphan while the command outlives
// the timeout. The grandchild and the middle are ended when the case ends, with two exceptions for the middle. One seen
// to exit is left, as its pid may be another process's by then; middleExited says whether it was seen to. One whose
// grandchild has not written its pid is left to runShell's cleanup, which can find that grandchild only through it.
export function orphanChain(t: TestContext, directory: string, name: string) {
  const pidFile = join(directory, `${name}.pid`);
  const midFile = join(directory, `${name}-mid.pid`);
  const goFile = join(directory, `${name}.go`);
  const commandLine = nodeCommand(t, CHILD_STARTER, ORPHAN_MIDDLE, midFile, goFile, LONG_LIVED, pidFile);
  let exited = false;
  const middleExited = () => {
    const mid = processProbe.pidIn(midFile);
    exited ||= mid > 0 && !processProbe.alive(mid);
    return exited;
  };
  t.after(() => {
    const grandchild = processProbe.pidIn(pidFile);
    if (!grandchild) return;
    processProbe.endProcess(grandchild);
    if (!middleExited()) processProbe.endProcessIn(midFile);
  });
  return { pidFile, midFile, goFile, commandLine, middleExited };
}

// A command whose child, still linked to the shell, writes pidFile. That child is ended when the case ends.
export function linkedChild(t: TestContext, directory: string, name: string) {
  const pidFile = join(directory, `${name}.pid`);
  t.after(() => processProbe.endProcessIn(pidFile));
  return { pidFile, commandLine: nodeCommand(t, LINKED_STARTER, LONG_LIVED, pidFile) };
}
