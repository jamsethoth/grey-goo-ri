import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as admission from '../../lib/admission.ts';
import * as runContextModule from '../../lib/run-context.ts';
import type * as terminalReport from '../../lib/terminal-report.ts';
import * as golden from '../support/golden.ts';

test('harnessOf gives null, not undefined, before the first Visit pins an Agent', async (t) => {
  const fixture = await golden.fixture(t);
  const { harness: _harness, ...options } = fixture.options;
  const runContext = runContextModule.createRunContext({ ...options, harnesses: {} });
  assert.equal(fixture.executionRecord.configurationSnapshot, null, 'no Visit has pinned an Agent');
  assert.equal(runContext.harnessOf(), null);
});

// What the Config Hash covers reaches an Execution only in the one value that carries the hash, so what runs is what
// was hashed (#369). Each key named here is one a caller could once pass beside it; tsc fails while any is declared.
test('runExecution takes the hashed configuration as one value, with no part of it beside', () => {
  type Separate = 'flow' | 'files' | 'commands' | 'testPaths' | 'approvers' | 'configHash';
  const options: [Extract<keyof runContextModule.ExecutionOptions, Separate>] extends [never] ? true : false = true;
  const context: [Extract<keyof runContextModule.RunContext, Exclude<Separate, 'flow'>>] extends [never]
    ? true
    : false = true;
  const terminal: [Extract<keyof terminalReport.TerminalContext, 'files'>] extends [never] ? true : false = true;
  const admitted: [Extract<keyof admission.AdmissionContext, 'commands' | 'testPaths'>] extends [never] ? true : false =
    true;
  assert.deepEqual([options, context, terminal, admitted], [true, true, true, true]);
});

test("the Run context's Flow is the Flow of the value it runs under", async (t) => {
  const fixture = await golden.fixture(t);
  const pinned = { ...fixture.options.pinned, flow: golden.resolve(golden.goldenConfig()) };
  const runContext = runContextModule.createRunContext({ ...fixture.options, pinned });
  assert.equal(runContext.flow, pinned.flow);
});
