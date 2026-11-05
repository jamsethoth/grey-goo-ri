// The suite a fake test runner runs over lib/add.mjs, the golden Ticket's one file, and what it prints.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as runContext from '../../lib/run-context.ts';

export const TEST_NAME = 'adds two numbers';
export const RED_OUTPUT =
  `✖ ${TEST_NAME} (1.2ms)\n` + "  Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'lib/add.mjs'\nℹ fail 1";
export const GREEN_OUTPUT = `✔ ${TEST_NAME} (0.8ms)\nℹ pass 1`;
// What the suite prints when lib/add.mjs exists but does not add.
export const GREEN_FAIL_OUTPUT = 'not ok 1 - adds two numbers\n# fail 1';

// The suite as a fake test runner runs it: red until lib/add.mjs exists, then green; with `checksSum`, green only once
// the file adds (`a + b`). `onRun` sees each command first.
export function addSuite({
  worktree,
  checksSum = false,
  onRun = () => {},
}: {
  worktree: string;
  checksSum?: boolean;
  onRun?: (command: string, cwd: string | undefined) => void;
}): runContext.Deps['exec'] {
  const ran = (code: number, output: string) => ({ code, output, timedOut: false });
  const runShell = async (command: string, options?: { cwd?: string }) => {
    onRun(command, options?.cwd);
    const file = join(options?.cwd ?? worktree, 'lib', 'add.mjs');
    if (!existsSync(file)) return ran(1, RED_OUTPUT);
    if (!checksSum || readFileSync(file, 'utf8').includes('a + b')) return ran(0, GREEN_OUTPUT);
    return ran(1, GREEN_FAIL_OUTPUT);
  };
  return { runShell } as runContext.Deps['exec'];
}
