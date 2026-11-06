// A Flow whose green failure routes to another Vertex: red -> green, green's `failed` -> senior-green, each of them ok ->
// publish, on real git with the real integrity, since a rescue's subject is git behaviour (docs/testing.md).
// `rescueFixture` builds it and runs nothing.
import type { TestContext } from 'node:test';
import type * as fakeHarness from './fake-harness.ts';
import * as gitShell from './git-shell.ts';
import * as golden from './golden.ts';
import * as goldenRun from './golden-run.ts';
import * as keys from './keys.ts';

type GoldenFixture = golden.GoldenFixture;

export const GREEN_CALL = keys.responseKey('green', 1, 'green', 1);
export const GREEN_RECOVERY = keys.responseKey('green', 1, 'recover', 1);
export const SENIOR_CALL = keys.responseKey('senior-green', 1, 'green', 1);

// green writes this twice and fails its Check both times.
export const FAILING_WORK = { 'lib/add.mjs': goldenRun.WRONG_ADD, 'notes.txt': 'what green tried\n' };
export const failingGreen = (): fakeHarness.ScriptedResponses => ({
  [GREEN_CALL]: goldenRun.greenWrites(FAILING_WORK),
  [GREEN_RECOVERY]: goldenRun.greenWrites(FAILING_WORK),
});
export const rightSenior = (): fakeHarness.ScriptedResponses => ({
  [SENIOR_CALL]: goldenRun.greenWrites({ 'lib/add.mjs': goldenRun.RIGHT_ADD }),
});

// Adds senior-green, which reads the failed work as `previous`, and routes green's failure to it.
export function routeFailureToSenior(configured: golden.GoldenConfig) {
  const { vertices } = configured.flows.golden!.ticket;
  vertices.green!.route = { ok: 'publish', failed: 'senior-green' };
  vertices['senior-green'] = {
    use: 'implementer',
    procedure: 'implement',
    inputs: { ...golden.GREEN_INPUTS, previous: { from: 'green.rescue', optional: true } },
    route: { ok: 'publish' },
  };
  vertices.publish!.inputs = {
    report: { from: ['green.green.response', 'senior-green.green.response'] },
    red: { from: 'red.red-check.evidence' },
    green: { from: ['green.test.evidence', 'senior-green.test.evidence'] },
  };
}

// The golden fixture on real git over the first Visit's responses and `responses`, whose suite passes only once
// lib/add.mjs really adds, with green's failure routed to senior-green. It runs nothing.
export async function rescueFixture(t: TestContext, responses: fakeHarness.ScriptedResponses): Promise<GoldenFixture> {
  const fixture = await goldenRun.greenFixture(t, { responses, integrity: 'real', git: 'real' });
  golden.configure(fixture, routeFailureToSenior);
  return fixture;
}

// The Rescue Refs the repository holds.
export const rescueRefs = (fixture: GoldenFixture): string[] =>
  gitShell.sh(fixture.worktree, 'for-each-ref', '--format=%(refname)', 'refs/gg/rescue').split('\n').filter(Boolean);

// A file as the ref's commit holds it.
export const inRef = (fixture: GoldenFixture, ref: string, path: string): string =>
  gitShell.sh(fixture.worktree, 'show', `${ref}:${path}`);
