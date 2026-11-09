import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gitDefaultBranch from '../../lib/git-default-branch.ts';

type Runner = Parameters<typeof gitDefaultBranch.defaultBranch>[0];

// A runner that answers each git call from `answers` by its first two arguments, and records every call it is asked.
function answering(answers: Record<string, { code: number; stdout: string }>) {
  const calls: string[] = [];
  const runGit = async (args: string[]) => {
    const key = args.slice(0, 2).join(' ');
    calls.push(key);
    return { stderr: '', ...(answers[key] ?? { code: 1, stdout: '' }) };
  };
  return { runner: { runGit } as unknown as Runner, calls };
}

// An origin that cannot be reached, or asks for credentials, would stall gg init, so the clone's own record is enough.
test("defaultBranch takes the clone's recorded origin HEAD without asking origin", async () => {
  const { runner, calls } = answering({ 'symbolic-ref --quiet': { code: 0, stdout: 'origin/trunk\n' } });
  assert.equal(await gitDefaultBranch.defaultBranch(runner, '/repo'), 'trunk');
  assert.deepEqual(calls, ['symbolic-ref --quiet']);
});

test('defaultBranch asks origin only when the clone recorded no HEAD for it', async () => {
  const { runner, calls } = answering({
    'ls-remote --symref': { code: 0, stdout: 'ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n' },
  });
  assert.equal(await gitDefaultBranch.defaultBranch(runner, '/repo'), 'trunk');
  assert.deepEqual(calls, ['symbolic-ref --quiet', 'ls-remote --symref']);
});
