// A Run over an epic's Tickets on the `gg run` fixture: the epic's issue views, each Ticket's worktree and fake
// Harness.
import { join } from 'node:path';
import * as gitModule from '../../lib/git.ts';
import * as paths from '../../lib/paths.ts';
import * as fakeHarnessModule from './fake-harness.ts';
import * as golden from './golden.ts';
import type * as runFixture from './run-fixture.ts';

type RunFixture = runFixture.RunFixture;

export const EPIC = 20;

// The issue views of an epic whose sub-issues are `children`, with `extra` overriding single issues.
export const epicOf = (children: number[], extra: Record<number, Record<string, unknown>> = {}) => ({
  [EPIC]: { title: 'An epic', subIssues: children.map((number) => ({ number })) },
  ...extra,
});

export const worktreeOf = (fixture: RunFixture, ticket: number) =>
  gitModule.worktreePath(fixture.options.config.user.worktreeRoot, 'main', ticket);
export const addsLabel = (args: string[], ticket: number, label: string) =>
  args[0] === 'issue' &&
  args[1] === 'edit' &&
  args[2] === String(ticket) &&
  args.some((arg, i) => arg === label && args[i - 1] === '--add-label');

// One fake Harness per Ticket behind the name `fake`, chosen by the worktree each call runs in; `before` runs first.
export function ticketHarnesses(
  fixture: RunFixture,
  tickets: number[],
  {
    responses = {},
    before = async () => {},
  }: {
    responses?: Record<number, fakeHarnessModule.ScriptedResponses>;
    before?: (ticket: number, call: fakeHarnessModule.HarnessCall) => Promise<unknown>;
  } = {},
) {
  const fakes = Object.fromEntries(
    tickets.map((ticket) => [
      ticket,
      golden.goldenHarness(
        join(fixture.root, 'transcripts', String(ticket)),
        responses[ticket] ?? golden.firstVisitResponses,
      ),
    ]),
  );
  const ticketOf = (cwd: string) =>
    tickets.find((ticket) => paths.pathKey(cwd) === paths.pathKey(worktreeOf(fixture, ticket))) as number;
  fixture.options.harnesses.fake = {
    ...fakes[tickets[0] as number],
    run: async (call: fakeHarnessModule.HarnessCall) => {
      const ticket = ticketOf(call.cwd);
      await before(ticket, call);
      return (fakes[ticket] as fakeHarnessModule.FakeHarness).run(call);
    },
  };
  return fakes;
}
