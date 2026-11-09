// A Flow that asks a human between green and publish: red -> green -> approve, whose `approved` goes on to publish and
// whose `rejected` goes back to green once. `approvalFixture` builds it and runs nothing.
import type { TestContext } from 'node:test';
import * as interpreter from '../../lib/interpreter.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as executionReads from './execution-reads.ts';
import * as fakeGh from './fake-gh.ts';
import * as golden from './golden.ts';

export const AWAIT_LABEL = 'gg:await:approve';
export const APPROVED_LABEL = 'gg:decide:approve:approved';
export const REJECTED_LABEL = 'gg:decide:approve:rejected';
export const OWNER = 'the-owner';

export function askBeforePublish(configured: golden.GoldenConfig) {
  configured.procedures.approval = {
    actions: [{ id: 'ask', do: 'await-approval', decisions: ['approved', 'rejected'] }],
  };
  const { vertices } = configured.flows.golden!.ticket;
  vertices.green!.route = { ok: 'approve' };
  vertices.approve = {
    procedure: 'approval',
    route: { approved: 'publish', rejected: { to: 'green', max: 1, exhausted: { end: 'needs-human' } } },
  };
}

// The golden fixture over `askBeforePublish`, with OWNER holding write permission.
export async function approvalFixture(t: TestContext, options?: golden.GoldenOptions) {
  const fixture = await golden.fixture(t, options);
  golden.configure(fixture, askBeforePublish);
  fixture.gh.permissions.set(OWNER, 'write');
  return fixture;
}

// A later Run of the fixture's Execution, from its saved record as a new process would read it.
export const laterRun = async (
  fixture: golden.GoldenFixture,
  changes: Partial<Omit<runContext.ExecutionOptions, 'record'>> = {},
) =>
  interpreter.runExecution({
    ...fixture.options,
    ...changes,
    record: executionReads.loadTicket(fixture),
  });

// The Approval Request comments on the Ticket.
export const requestComments = (fixture: Pick<golden.GoldenFixture, 'gh'>) =>
  fixture.gh.comments.map((comment) => comment.body).filter((body) => body.includes('Approval Request'));

// How many times gg has read the Ticket's event timeline.
export const timelineReads = (fixture: Pick<golden.GoldenFixture, 'gh'>) =>
  fixture.gh.calls.filter(({ args }) => args.some((arg) => arg.endsWith(`/issues/${golden.TICKET}/events`))).length;

// The Action Events of the approve Vertex, as a golden trace asserts them.
export const approveTrace = (fixture: Pick<golden.GoldenFixture, 'readEvents'>) =>
  golden.trace(fixture.readEvents()).filter((event) => event.vertex === 'approve');

// A timeline read that fails as gh does.
export const failTimelineRead = (fixture: Pick<golden.GoldenFixture, 'gh'>) =>
  fixture.gh.fail({
    matches: (args: string[]) => args.some((arg) => arg.endsWith('/events')),
    status: 502,
  } satisfies fakeGh.GhFailure);
