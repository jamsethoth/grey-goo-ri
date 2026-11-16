import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as addSuite from '../support/add-suite.ts';
import * as golden from '../support/golden.ts';
import * as goldenRun from '../support/golden-run.ts';
import * as keys from '../support/keys.ts';
import * as runFixture from '../support/run-fixture.ts';

// Resume requires a clean worktree, so a person's uncommitted work is never run over. Real git and integrity, since
// only they see a file a person changed and did not commit.
test('gg work resume refuses a worktree with uncommitted changes and keeps the record', async (t) => {
  const responses = {
    ...structuredClone(golden.firstVisitResponses),
    [keys.responseKey('green', 1, 'green', 1)]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.WRONG_ADD }),
  };
  const fixture = runFixture.fixture(t, { responses, git: 'real', integrity: 'real' });
  fixture.options.deps.exec = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true });
  await run.runTarget(fixture.options);
  const before = record.load(fixture.commonDir, 'ticket', runFixture.TICKET);
  assert.equal(before?.state, 'fault', 'the first Run stops at green');
  writeFileSync(join(fixture.worktree, 'lib', 'add.mjs'), goldenRun.RIGHT_ADD);
  const [result] = await run.runTarget({ ...fixture.options, resume: { vertex: 'green' } });
  assert.match(String(result?.error), /is not clean; commit or discard its changes first/);
  assert.deepEqual(record.load(fixture.commonDir, 'ticket', runFixture.TICKET), before, 'the record is kept');
});
