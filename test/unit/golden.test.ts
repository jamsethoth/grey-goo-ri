import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import * as stateDatabase from '../../lib/state-database/index.ts';
import * as golden from '../support/golden.ts';

// A case's context whose `after` hooks run as node:test runs them when the case ends: in order, the first to throw
// skipping the rest.
function endingCase() {
  const hooks: (() => void)[] = [];
  const context = { after: (hook: () => void) => hooks.push(hook), diagnostic: () => {} };
  const end = () => hooks.forEach((hook) => hook());
  return { context: context as unknown as TestContext, end };
}

test('a golden case that fails its end-of-case check leaves no temp directory', async (t) => {
  const goldenCase = endingCase();
  const fixture = await golden.fixture(goldenCase.context);
  t.after(() => {
    stateDatabase.close(fixture.commonDir);
    rmSync(fixture.root, { recursive: true, force: true });
  });
  // A ticket_end row the end-of-case check refuses.
  stateDatabase
    .open(fixture.commonDir)
    .prepare(
      "INSERT INTO events (ts, type, run, execution, ticket, json) VALUES ('t', 'ticket_end', 'run-1', 'e', ?, '{')",
    )
    .run(golden.TICKET);

  assert.throws(goldenCase.end, { name: 'EventCorruptError' }, 'the end-of-case check fails');
  assert.equal(existsSync(fixture.root), false, `the temp directory ${fixture.root} is removed`);
});
