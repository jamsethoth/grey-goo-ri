// A process that calls runShell on commandLine, with a timeout no case reaches, and exits with the command's code.
// The test runner also loads this file with no arguments, where it does nothing.
import * as exec from '../../../lib/exec.ts';
import * as childScripts from '../child-scripts.ts';

const [commandLine] = process.argv.slice(2);
if (commandLine) {
  const result = await exec.runShell(commandLine, { timeoutMs: childScripts.LIVES_MS });
  process.exitCode = result.code ?? undefined;
}
