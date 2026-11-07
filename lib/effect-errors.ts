// What an Action's effects throw, and what each means to the code that catches it: a test's crash, a fatal save, an
// early Terminal, and a remote Action's spent retries or final failure.
import type * as outcome from './outcome.ts';
import type * as reconcile from './reconcile.ts';
import * as record from './record.ts';

export type CrashPointName =
  'before-intent' | 'before-effect' | 'after-effect' | 'after-completion' | 'after-retry-saved';

// Test-only crash injection (T18): rethrown untouched, so the record is left exactly as the crash found it.
export class CrashError extends Error {
  name = 'CrashError';
}

// A crash, or a record save that failed: either way nothing more of the record is saved.
export const fatal = (err: unknown): boolean => err instanceof CrashError || err instanceof record.RecordSaveError;

// crashAt (tests only) throws at a named point of the Action or Attempt with that marker.
export function crashPoint(
  context: { crashAt?: { marker: string; point: CrashPointName } },
  actionMarker: string,
  point: CrashPointName,
): void {
  if (context.crashAt?.marker === actionMarker && context.crashAt.point === point)
    throw new CrashError(`crash ${point} ${actionMarker}`);
}

// A hold found inside an Action: a conflicting effect, a corrupt retry deadline, a publish refused or a rescue that
// cannot go on (`name`), with what its comment adds to the reason.
export interface HoldEnding {
  next: 'hold';
  reason: string;
  name?: string;
  advice?: string;
  detail?: string;
}
// Another Execution's run stop, found while this one waited: in a backoff (`retrying`) or for the repo lock.
export interface RunStoppedEnding {
  next: 'run-stopped';
  retrying: boolean;
  reason: string;
}
// This Execution's own remote Action failed with a class that stops the whole Run (#240).
export interface RunStopEnding {
  next: 'run-stop';
  failureClass: outcome.FailureClass;
  source: string;
  detail: string;
  reason: string;
}
// The Run ends for this Ticket, which is Pending: its Execution stays active and a later Run goes on (L11, X1b).
export interface PendingEnding {
  next: 'pending';
  reason: string;
  // The Failure Class of a read GitHub refused, which a next Run will not get past by itself.
  unread?: string;
}
// How an Execution ends before its route reaches an end state: held, abandoned for a human's label, stopped, or left
// Pending.
export type Ending = HoldEnding | reconcile.HumanOverride | RunStoppedEnding | RunStopEnding | PendingEnding;

// An Action found that the Execution must end now, before its route reaches an end state: held when gg cannot go on
// safely, abandoned for a human's needs-human label, or stopped for a run stop, its own or another Ticket's; or that
// this Run must leave it Pending. Thrown
// rather than returned because it is found deep inside an Action, in a repo-lock guard, an effect's retry, a finder's
// lookup or a perform callback, about five calls below the runExecution and terminal.terminal that catch it and end
// the Execution as `ending` says (terminal.endEarly). Every layer between passes it on untouched.
export class EarlyTerminalError extends Error {
  name = 'EarlyTerminalError';
  readonly ending: Ending;
  constructor(ending: Ending) {
    super(ending.reason);
    this.ending = ending;
  }
}

// What a remote Action spent its retries on.
export interface SpentRetries {
  failureClass: outcome.FailureClass;
  status: number | null;
  count: number;
  effect: string | null;
}
// A remote Action whose retry budget ran out on transient failures, so terminal.fault says the budget ran out rather
// than that the fault was unexpected. `cause` is the last failure, whose message this error keeps.
export class RetriesExhaustedError extends Error {
  name = 'RetriesExhaustedError';
  readonly spent: SpentRetries;
  constructor(message: string, spent: SpentRetries, options?: ErrorOptions) {
    super(message, options);
    this.spent = spent;
  }
}

// A final remote failure's class, which remote-effects puts on its error for terminal.fault's Terminal Reason.
export interface FinalRemoteFailure {
  failureClass: outcome.FailureClass;
  status: number | null;
  reach: 'retry' | 'run' | 'ticket';
  effect: string;
}
