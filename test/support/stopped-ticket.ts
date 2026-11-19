// A Ticket a first gg run has already stopped, as gg work done and gg work resume find it.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as record from '../../lib/record.ts';
import * as run from '../../lib/run.ts';
import * as addSuite from './add-suite.ts';
import * as golden from './golden.ts';
import * as goldenRun from './golden-run.ts';
import * as keys from './keys.ts';
import * as runFixture from './run-fixture.ts';

// The record states gg work done and gg work resume take: each a stop a person hands back.
export const STOPPED = ['needs-human', 'needs-replan', 'held', 'fault', 'abandoned'];

// Ticket 15 run once by gg run over a suite that checks the sum: its green writes a wrong add and finds no recovery, so
// the Execution ends at fault with red's commit and green's outputs saved and an agent call left open. `onRun` sees
// each suite run of every later Run.
// `configure` edits the fixture before its Run, and `fixtureOptions` go to the run fixture.
export interface Faulting {
  responses?: Record<string, unknown>;
  onRun?: () => void;
  configure?: (fixture: runFixture.RunFixture) => void;
  fixtureOptions?: runFixture.RunFixtureOptions;
}
export async function faulted(
  t: TestContext,
  { responses = {}, onRun = () => {}, configure = () => {}, fixtureOptions = {} }: Faulting = {},
) {
  const scripted = {
    ...structuredClone(golden.firstVisitResponses),
    [keys.responseKey({ vertex: 'green', visit: 1, action: 'green' })]: goldenRun.greenWrites({
      'lib/add.mjs': goldenRun.WRONG_ADD,
    }),
    ...responses,
  };
  const fixture = runFixture.fixture(t, {
    responses: scripted as golden.GoldenOptions['responses'],
    ...fixtureOptions,
  });
  configure(fixture);
  fixture.options.deps.exec = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true, onRun });
  await run.runTarget(fixture.options);
  return fixture;
}

// Ticket 15 run once by gg run with red and green passing and the suite failing from publish on, as a broken
// environment would, so the Execution stops at publish with every input it reads saved. `fixed()` mends the suite.
export async function stoppedAtPublish(t: TestContext, onRun: () => void) {
  const fixture = runFixture.fixture(t);
  const suite = addSuite.addSuite({ worktree: fixture.worktree, checksSum: true, onRun });
  const environment = { runs: 0, broken: true };
  fixture.options.deps.exec = {
    ...suite,
    runShell: async (command: string, options?: { cwd?: string }) => {
      environment.runs += 1;
      if (environment.broken && environment.runs > 2)
        return { code: 1, output: 'the suite could not start', timedOut: false, cleanup: addSuite.CONFIRMED };
      return suite.runShell(command, options);
    },
  } as typeof suite;
  const [first] = await run.runTarget(fixture.options);
  const { state } = record.load(fixture.commonDir, 'ticket', runFixture.TICKET)!;
  assert.ok(STOPPED.includes(state), `the first Run stops at publish (${first?.outcome})`);
  return { fixture, fixed: () => (environment.broken = false) };
}
