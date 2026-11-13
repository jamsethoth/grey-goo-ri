// What a Run does for a Ticket it leaves Pending, an Approval Request's or a cleanup hold's: its label and comment
// Actions, each write-ahead with its Action Event, and the ending that stops the Run for the Ticket with its Execution
// still active (Pending, L11, J6).
import * as attempt from './attempt.ts';
import * as config from './config.ts';
import * as effectErrors from './effect-errors.ts';
import * as comment from './effects/comment.ts';
import * as label from './effects/label.ts';
import * as github from './github.ts';
import * as outcome from './outcome.ts';
import type * as marker from './marker.ts';
import type { RunContext } from './run-context.ts';

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
export const keptPending = label.keepOpen(({ ticket }) =>
  pending(`The label update on #${ticket} failed, so the next Run makes it.`),
);

// Each change and body is made only for an Action not yet complete: a complete one reads nothing again.
export const labelAction = (
  runContext: RunContext,
  actionIdentity: marker.ActionIdentity,
  change: () => Promise<{ add?: string[]; remove?: string[] }>,
) =>
  attempt.effectAction(runContext, {
    actionIdentity,
    prepare: change,
    made: ({ add = [], remove = [] }) => ({
      effect: keptPending,
      payload: { ticket: runContext.record.ticket, add, remove },
    }),
  });

export const commentAction = (
  runContext: RunContext,
  actionIdentity: marker.ActionIdentity,
  body: () => Promise<string>,
) =>
  attempt.effectAction(runContext, {
    actionIdentity,
    prepare: body,
    made: (made) => ({
      effect: comment.effect,
      payload: {
        target: { kind: 'issue', number: runContext.record.ticket },
        body: made,
        bodyHash: config.sha256(made),
      },
    }),
  });
