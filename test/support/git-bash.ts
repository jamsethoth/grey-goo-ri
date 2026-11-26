// Git Bash: the bash.exe in the bin folder of the Git installation the suite's git belongs to (#530, owner's answer A),
// never the first bash.exe on PATH, which can be WSL's or a packaged app's that Windows starts outside any job. Spawns
// git, so a test that calls it is medium (docs/testing.md).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// git --exec-path is <Git>/<mingw64 or the like>/libexec/git-core. Bash is required as git is: a Git without it, such
// as MinGit, fails the case that asks, naming where it looked.
export function gitBash() {
  const gitCore = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const bash = resolve(gitCore, '../../../bin/bash.exe');
  if (!existsSync(bash)) throw new Error(`no Git Bash at ${bash}, beside the git whose exec path is ${gitCore}`);
  return bash;
}
