// The remote Actions' failures a golden Execution meets: a `gh pr` verb failed or crashed, and a git push refused.
import assert from 'node:assert/strict';
import * as github from '../../lib/github.ts';
import * as interpreter from '../../lib/interpreter.ts';
import * as run from '../../lib/run.ts';
import * as executionReads from './execution-reads.ts';
import type * as golden from './golden.ts';
import * as reviewFlow from './review-flow.ts';

export const isPr = (verb: string) => (args: string[]) => args[0] === 'pr' && args[1] === verb;
// Fails the next `times` launches of `gh pr <verb>` transiently.
export function failPr(fixture: golden.GoldenFixture, verb: string, times: number): void {
  for (let launch = 0; launch < times; launch++) fixture.gh.fail({ matches: isPr(verb), status: 502 });
}
export const prCalls = (fixture: golden.GoldenFixture, verb: string) =>
  fixture.gh.calls.filter((call) => isPr(verb)(call.args));

// A push git refused with `stderr`: only its text carries the status, with no headers to say how long to wait.
export const refusedPush = (stderr: string) =>
  Object.assign(new Error('git push exited 128'), { code: 128, stdout: '', stderr });
export const pushError = () =>
  refusedPush("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503");

// The golden Execution on the orchestrator's locked git, whose nth raw push runs `push(n, real)`; returns the count.
export function pushThrough(
  fixture: golden.GoldenFixture,
  push: (launch: number, real: () => Promise<unknown>) => Promise<unknown>,
): () => number {
  let launches = 0;
  const git = fixture.options.deps.git;
  fixture.options.deps.git = run.lockedGit(
    { ...git, push: (...args) => push(++launches, () => git.push(...args)) },
    fixture.commonDir,
  );
  return () => launches;
}

// Fails the first two launches of `gh pr <verb>` transiently and crashes the third as it launches; returns the count.
export function crashPr(fixture: golden.GoldenFixture, verb: string): () => number {
  let launches = 0;
  fixture.gh.fail({ matches: isPr(verb), status: 502 });
  fixture.gh.fail({ matches: isPr(verb), status: 502 });
  fixture.options.deps.gh = github.createGh(async (args, cwd, input) => {
    if (isPr(verb)(args) && ++launches === 3) throw new interpreter.CrashError(`crash as pr ${verb} launched`);
    return fixture.gh.gh(args, cwd, input);
  });
  return () => launches;
}

export const HOUR = 3_600_000;
// GitHub's secondary rate limit on the review comment, asking for a wait of `ms`.
export const rateLimitedFor = (ms: number) =>
  reviewFlow.onPr({
    status: 403,
    headers: { 'Retry-After': String(ms / 1000) },
    body: { message: 'You have exceeded a secondary rate limit.' },
  });

// A retried Action that finished: the Ticket is ready-for-qa, the Action has one evidence and completion, and one
// retry was spent after the 60 s fallback.
export async function retriedOnce(
  fixture: golden.GoldenFixture,
  result: Awaited<ReturnType<typeof interpreter.runExecution>>,
  key: string,
  marker: string,
) {
  assert.equal(result.outcome, 'ready-for-qa', JSON.stringify(result));
  assert.deepEqual(fixture.sleeps, [60_000]);
  const final = await executionReads.loadTicket(fixture);
  assert.deepEqual(executionReads.writeAheadSteps(final, marker), ['intent', 'evidence', 'complete']);
  assert.equal(final.retries[key]!.remote!.count, 1);
  return final;
}
