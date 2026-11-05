import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as run from '../../lib/run.ts';
import * as gitShell from '../support/git-shell.ts';
import * as runFixture from '../support/run-fixture.ts';

test('Ticket branch names use the public title before slugifying', async (t) => {
  const issue: Record<string, unknown> = {};
  const branch = 'ticket/15-add-two-numbers-local';
  const fixture = runFixture.fixture(t, { git: 'real', issue, branch });
  issue.title = `Add two numbers ${fixture.worktree}`;
  const results = await run.runTarget(fixture.options);
  assert.equal(
    gitShell.sh(join(fixture.root, 'origin.git'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket/'),
    branch,
  );
  assert.equal(run.runExitCode(results), 0, JSON.stringify(results));
});
