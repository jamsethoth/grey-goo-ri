// A real repository with two worktrees, for the integrity cases in test/e2e/ and test/contract/integrity/.
import type { TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as record from '../../lib/record.ts';
import * as gitShell from './git-shell.ts';
import * as tempDirectory from './temp-directory.ts';

export const PROTECTED = ['.agents/', '.claude/', '.codex/', '.mcp.json', 'AGENTS.md', 'CLAUDE.md'];

const sh = gitShell.sh;

// A fresh Execution Record of Ticket `ticket` that owns `worktree`.
export function worktreeRecord(commonDir: string, ticket: number, worktree: string) {
  return record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree,
    branch: `ticket/${ticket}`,
    base: 'main',
  });
}

// An initialized worktree with no commit in a temp directory, for the rollback cases.
export function emptyWorktree(t: TestContext) {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-');
  const worktree = join(root, 'wt');
  mkdirSync(worktree);
  sh(worktree, 'init', '-q', '-b', 'main');
  return { root, worktree };
}

// `own` is the agent's worktree and `other` an idle one, each owned by a ticket record saved in the State Database.
export async function twoWorktrees(t: TestContext) {
  const root = tempDirectory.tempDirectory(t, 'gg-integrity-', (directory) => join(directory, 'own', '.git'));
  const own = join(root, 'own');
  const other = join(root, 'other');
  mkdirSync(own);
  sh(own, 'init', '-q', '-b', 'main');
  sh(own, 'config', 'user.name', 't');
  sh(own, 'config', 'user.email', 't@t');
  writeFileSync(join(own, 'a.txt'), 'a\n');
  writeFileSync(join(own, 'AGENTS.md'), '# agents\n');
  sh(own, 'add', '-A');
  sh(own, 'commit', '-q', '-m', 'init');
  sh(own, 'worktree', 'add', '-q', '-b', 'ticket/2', other);
  const commonDir = join(own, '.git');
  const ownRecord = worktreeRecord(commonDir, 1, own);
  record.save(ownRecord);
  record.save(worktreeRecord(commonDir, 2, other));
  return { root, own, other, commonDir, ownRecord };
}
