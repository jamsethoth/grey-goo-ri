// The child scripts the exec contract suites run, and the command lines that start them. Each script takes its inputs
// as arguments, so no value a case passes becomes code; with none, as the test runner loads it, it does nothing. Spawns
// nothing itself.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// How long a test process lives unless it is killed: longer than any case, so no command ends on its own first.
export const LIVES_MS = 600_000;

const childScript = (name: string) => fileURLToPath(new URL(`./child-scripts/${name}.ts`, import.meta.url));
export const LONG_LIVED = childScript('long-lived');
export const ORPHAN_MIDDLE = childScript('orphan-middle');
export const CHILD_STARTER = childScript('child-starter');
export const DETACHED_CHILD = childScript('detached-child');
export const WAITS_FOR_FILE = childScript('waits-for-file');
export const PRINTS_LINE = childScript('prints-line');
export const STDIN_EOF = childScript('stdin-eof');
export const SPLIT_CHARACTER = childScript('split-character');
export const SHELL_CALLER = childScript('shell-caller');
export const SLOW_TASKKILL = childScript('slow-taskkill');
export const FORGED_JOB_NOTES = childScript('forged-job-notes');
export const BREAKAWAY_CHILD = childScript('breakaway-child');

// The command line that runs node with these arguments, each one quoted, for cmd.exe and sh alike.
export const nodeCommand = (...args: string[]) => [process.execPath, ...args].map((arg) => `"${arg}"`).join(' ');

// A command whose child starts a middle process, which writes midFile, starts a detached grandchild that writes
// pidFile, and lingers until goFile exists; then it exits, leaving the grandchild an orphan while the command outlives
// the timeout.
export function orphanChain(directory: string, name: string) {
  const pidFile = join(directory, `${name}.pid`);
  const midFile = join(directory, `${name}-mid.pid`);
  const goFile = join(directory, `${name}.go`);
  const commandLine = nodeCommand(CHILD_STARTER, ORPHAN_MIDDLE, midFile, goFile, LONG_LIVED, pidFile);
  return { pidFile, midFile, goFile, commandLine };
}

// A command whose child, still linked to the shell, writes pidFile.
export function linkedChild(directory: string, name: string) {
  const pidFile = join(directory, `${name}.pid`);
  return { pidFile, commandLine: nodeCommand(CHILD_STARTER, LONG_LIVED, pidFile) };
}
