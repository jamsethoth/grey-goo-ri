// Git Bash: the bash.exe in the bin folder of the Git installation the suite's git belongs to (#530, owner's answer A),
// never the first bash.exe on PATH, which can be WSL's or a packaged app's that Windows starts outside any job, and the
// scripts the cases run in it. gitBash spawns git, so a test that calls it is medium (docs/testing.md).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as childScripts from './child-scripts.ts';

// git --exec-path is <Git>/<mingw64 or the like>/libexec/git-core. Bash is required as git is: a Git without it, such
// as MinGit, fails the case that asks, naming where it looked.
export function gitBash() {
  const gitCore = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const bash = resolve(gitCore, '../../../bin/bash.exe');
  if (!existsSync(bash)) throw new Error(`no Git Bash at ${bash}, beside the git whose exec path is ${gitCore}`);
  return bash;
}

// A path as bash reads it inside single quotes, in forward slashes so no backslash is read as an escape. A ' or " would
// end a quote and a % would be expanded by cmd.exe; no path these cases use holds one.
function bashQuoted(path: string) {
  if (/['"%]/.test(path)) throw new Error(`a Git Bash case cannot quote ${path}`);
  return `'${path.replaceAll('\\', '/')}'`;
}

// A Git Bash script whose background node runs scripts with pidFile last, which the last script writes; Git Bash starts
// each non-MSYS child asking to break away from the job (ADR 0030). Its output is away from gg's pipes, which it would
// otherwise hold open past the result. Then bash exits once the pid is written, so the node has started before the
// command ends, or with waits it waits for the node, so only a clock ends the command.
export function backgroundNode(
  pidFile: string,
  { scripts = [childScripts.LONG_LIVED], waits = false }: { scripts?: string[]; waits?: boolean } = {},
) {
  const [node, ...args] = [process.execPath, ...scripts, pidFile].map(bashQuoted);
  const pid = args.at(-1);
  const then = waits ? 'wait' : `until [ -s ${pid} ]; do sleep 0.1; done`;
  return `${node} ${args.join(' ')} >/dev/null 2>&1 </dev/null & ${then}`;
}
