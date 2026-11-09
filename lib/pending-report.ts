// What a Run does for a Ticket it leaves Pending, an Approval Request's or a cleanup hold's: its label and comment
// Actions, each write-ahead with its Action Event, and the ending that stops the Run for the Ticket with its Execution
// still active (Pending, L11, J6).
import * as config from './config.ts';
import * as effectErrors from './effect-errors.ts';
import * as effects from './effects.ts';
import * as github from './github.ts';
import * as outcome from './outcome.ts';
import type * as marker from './marker.ts';
import type { RunContext } from './run-context.ts';

// A label write's intent, as Effect Evidence's finder reads it.
export type LabelPayload = { ticket: number; add: string[]; remove: string[] };

// The Run ends for this Ticket, whose Execution goes on at its next Run.
export const pending = (reason: string) => new effectErrors.EarlyTerminalError({ next: 'pending', reason });

// A gh read a Pending Ticket's Run could not make changes nothing, so the Ticket stays Pending for the next Run: a blip
// on GitHub must not end an Execution that is healthy. Only a gh process that failed: anything else is a real fault. A
// blip passes by the next Run, but a refusal does not, so its class is the Ticket's result and fails the Run's exit
// code, and one that reaches the whole Run (auth) stops it, as a remote Action's does (#240).
export async function keepPendingIfUnread<Result>(
  runContext: Pick<RunContext, 'record' | 'runState'>,
  what: string,
  read: () => Promise<Result>,
): Promise<Result> {
  try {
    return await read();
  } catch (err) {
    if (!(err instanceof github.GhError)) throw err;
    const { failureClass, retryable } = outcome.classifyRemoteFailure(err);
    if (outcome.FAILURE_CLASSES[failureClass].reach === 'run')
      runContext.runState.stop ??= { failureClass, ticket: runContext.record.ticket, source: 'read' };
    const reason = `${what} could not be read from GitHub, class ${failureClass} (${err.message.split('\n')[0]}).`;
    throw new effectErrors.EarlyTerminalError({ next: 'pending', reason, ...(!retryable && { unread: failureClass }) });
  }
}

// A label write that does not land leaves its intent open for the next Run, and the Ticket Pending: nothing was lost,
// and setLabels has reported it.
export const performLabels =
  (runContext: RunContext) =>
  async ({ ticket, add, remove }: LabelPayload): Promise<Record<string, unknown>> => {
    if (!add.length && !remove.length) return { ok: true };
    const ok = await runContext.gh.setLabels(ticket, { add, remove }, runContext.cwd, {
      log: runContext.log,
      ev: runContext.events as github.LabelReport['ev'],
    });
    if (!ok) throw pending(`The label update on #${ticket} failed, so the next Run makes it.`);
    return { ok };
  };

export const labelAction = (
  runContext: RunContext,
  actionIdentity: marker.ActionIdentity,
  { add = [], remove = [] }: { add?: string[]; remove?: string[] },
) =>
  effects.effectAction(runContext, actionIdentity, {
    effect: 'label',
    payload: { ticket: runContext.record.ticket, add, remove },
    perform: performLabels(runContext),
  });

export const commentAction = (runContext: RunContext, actionIdentity: marker.ActionIdentity, body: string) =>
  effects.effectAction(runContext, actionIdentity, {
    effect: 'comment',
    payload: {
      target: { kind: 'issue', number: runContext.record.ticket },
      body,
      bodyHash: config.sha256(body),
    },
    perform: async (payload) => ({
      id: (await runContext.gh.comment(payload.target.number, payload.body, runContext.cwd)).id,
    }),
  });
