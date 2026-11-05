import type { TestContext } from 'node:test';
import * as gitShell from './git-shell.ts';
import * as tempDirectory from './temp-directory.ts';

// A real repository in a temp directory, with the identity a case needs to commit. Spawns git, so a test that calls it
// is medium (docs/testing.md).
export function committingRepo(t: TestContext): string {
  const repo = tempDirectory.tempDirectory(t, 'gg-checks-');
  gitShell.sh(repo, 'init', '-q', '-b', 'main');
  gitShell.sh(repo, 'config', 'user.name', 't');
  gitShell.sh(repo, 'config', 'user.email', 't@t');
  return repo;
}
