// A real repository with two worktrees, for the integrity cases in test/e2e/ and test/contract/integrity/.
import type { TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as record from '../../lib/record.ts';
import * as sqlite from '../../lib/sqlite.ts';

export const PROTECTED = ['.agents/', '.claude/', '.codex/', '.mcp.json', 'AGENTS.md', 'CLAUDE.md'];

export const sh = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', input }).trim();

function newExecution(commonDir: string, ticket: number, worktree: string) {
  return record.createExecution({
    commonDir,
    ticket,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree,
    branch: `ticket/${ticket}`,
    base: 'main',
  });
}

// `own` is the agent's worktree and `other` an idle one, each owned by a ticket record saved in the State Database.
export async function twoWorktrees(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'gg-integrity-'));
  t.after(() => {
    sqlite.close(join(root, 'own', '.git'));
    rmSync(root, { recursive: true, force: true });
  });
  const own = join(root, 'own');
  const other = join(root, 'other');
  mkdirSync(own);
  sh(own, ['init', '-q', '-b', 'main']);
  sh(own, ['config', 'user.name', 't']);
  sh(own, ['config', 'user.email', 't@t']);
  writeFileSync(join(own, 'a.txt'), 'a\n');
  writeFileSync(join(own, 'AGENTS.md'), '# agents\n');
  sh(own, ['add', '-A']);
  sh(own, ['commit', '-q', '-m', 'init']);
  sh(own, ['worktree', 'add', '-q', '-b', 'ticket/2', other]);
  const commonDir = join(own, '.git');
  const ownRecord = newExecution(commonDir, 1, own);
  await record.save(ownRecord);
  await record.save(newExecution(commonDir, 2, other));
  return { root, own, other, commonDir, ownRecord };
}
