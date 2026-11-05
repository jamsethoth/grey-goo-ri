// A process that calls runShell on commandLine, with a timeout no case reaches, and exits with the command's code.
import * as exec from '../../../lib/exec.ts';
import * as childScripts from '../child-scripts.ts';

const [commandLine] = process.argv.slice(2);
const result = await exec.runShell(commandLine, { timeoutMs: childScripts.LIVES_MS });
process.exitCode = result.code ?? undefined;
