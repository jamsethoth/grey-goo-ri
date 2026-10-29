import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as integrity from '../../lib/integrity.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import { reviewFlow, okReview, onPr } from '../support/interpreter.mjs';

test("a worktree backing off is idle to other Tickets' integrity checks", async (t) => {
  const g = await reviewFlow(t, okReview, { git: 'real' });
  g.gh.fail(onPr({ status: 502 }));
  // Another Ticket's Action, in the main checkout, writes into this worktree while it backs off.
  const other = { worktree: g.mainRoot, commonDir: g.commonDir };
  const check = { others: [g.worktree], protectedPaths: g.options.protectedPaths, git: g.options.git };
  const stray = join(g.worktree, 'stray.txt');
  let violations;
  g.clock.onSleep = async () => {
    const baseline = await integrity.begin({ record: other, ...check });
    writeFileSync(stray, 'stray\n');
    ({ violations } = await integrity.end({ baseline, record: other, access: 'workspace-write', ...check }));
    rmSync(stray);
  };
  const result = await interpreter.runExecution(g.options);

  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.ok(violations?.some((v) => v.worktree === g.worktree && v.surface === 'tree'), JSON.stringify(violations));
});
