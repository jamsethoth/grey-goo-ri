// scripts/run-suite.ts's census over the job calls: what it says when a job cannot be used, and a listing that empties.
// The launcher's own runs, with a process really left behind, are in test/e2e/run-suite.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runSuite from '../../../scripts/run-suite.ts';
import * as kernel32Doubles from '../../support/kernel32-doubles.ts';
import * as options from '../../support/shell-case-options.ts';

const stray = { pid: 201, parentPid: 200, exe: 'node.exe' };

test('a stage whose job cannot be set up has no hold, and gives the reason', options.WIN_CASE, async () => {
  assert.match(String(await runSuite.holdStage(kernel32Doubles.noJob())), /CreateJobObjectW: win32 error/);
});

test('a stage with no node:ffi has no hold, and gives the reason', options.CASE, async () => {
  assert.match(String(await runSuite.holdStage(null)), /node:ffi/);
});

// This test process is never put in the job: only the listing is real, and it fails.
test('a job that cannot be read is a census that did not run, never a clean one', options.WIN_CASE, async () => {
  const kernel32 = kernel32Doubles.withKernel32({
    AssignProcessToJobObject: () => 1,
    QueryInformationJobObject: () => 0,
  });
  const strays = (await runSuite.holdStage(kernel32)) as runSuite.Strays;
  const { failed, report } = await runSuite.census(strays);
  assert.equal(failed, false);
  assert.match(report, /^census did not run: QueryInformationJobObject: win32 error/);
});

test('a stage whose job lists nothing has a clean census', options.CASE, async () => {
  assert.deepEqual(await runSuite.census(() => []), { failed: false, report: 'census: no process left' });
});

// A process a file's exit ended takes a moment to go from the listing, so the first look alone names nothing (#290).
test('a process that goes from the listing just after the stage ends is not named', options.CASE, async () => {
  const listings = [[stray], []];
  const { failed, report } = await runSuite.census(() => listings.shift() ?? []);
  assert.deepEqual({ failed, report }, { failed: false, report: 'census: no process left' });
});
