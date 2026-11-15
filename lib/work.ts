// `gg work`: a person's recovery verbs over the Tickets gg runs: abandon, done and resume.
import type * as events from './events.ts';
import type * as github from './github.ts';
import * as labels from './labels.ts';
import type * as locks from './locks.ts';
import type * as model from './model.ts';
import * as record from './record.ts';
import type * as runContext from './run-context.ts';
import * as stateDatabase from './state-database.ts';

// What gg work abandon reaches: the repository's State Database and ticket lock, and GitHub for its State Label.
export interface AbandonOptions {
  ticket: number;
  commonDir: string;
  cwd: string;
  labelPrefix: string;
  gh: github.Gh;
  locks: Pick<locks.Locks, 'tryAcquire' | 'release'>;
}

// Request 3.5's abandon: keep the worktree, forget the position. The record's row goes, as the recovery advice tells a
// person to do by hand, since admission skips a record that is merely marked finished; its Events, worktree and branch
// stay, so the next gg run starts a new Execution on that branch. Readiness refuses a Ticket with any State Label, and
// an in-progress one with no record behind it reads as stuck, so every State Label goes first, and the row only once
// they have.
export async function abandon({ ticket, commonDir, cwd, labelPrefix, gh, locks }: AbandonOptions): Promise<string> {
  // Before the lock, which would leave its file in a repository gg init never set up (#150).
  stateDatabase.open(commonDir);
  const lock = await locks.tryAcquire(commonDir, `ticket-${ticket}`);
  if (!lock)
    throw new Error(
      `another process holds the ticket-${ticket} lock, so Ticket ${ticket} may be running; abandon it once that ` +
        'process ends',
    );
  try {
    const executionRecord = record.load(commonDir, 'ticket', ticket);
    if (!executionRecord) throw new Error(`Ticket ${ticket} has no Execution Record to abandon`);
    const names = labels.labelsFor(labelPrefix);
    const stateLabels = gh
      .labelNames(await gh.viewIssue(ticket, cwd))
      .filter((name) => names.parse(name)?.family === 'state');
    const failures: string[] = [];
    const report = { log: (line: string) => failures.push(line), ev: () => {} };
    if (stateLabels.length && !(await gh.setLabels(ticket, { remove: stateLabels }, cwd, report)))
      throw new Error(`${failures.join('; ')}; Execution Record ticket-${ticket} is kept`);
    record.removeRecord(commonDir, 'ticket', ticket);
    const plural = stateLabels.length > 1 ? 's' : '';
    const removed = stateLabels.length ? ` and removed the ${stateLabels.join(', ')} label${plural}` : '';
    return (
      `gg work abandon deleted Execution Record ticket-${ticket} of Flow ${executionRecord.flow}${removed}; its ` +
      `Events, its worktree ${executionRecord.worktree} and its branch ${executionRecord.branch} are kept. ` +
      `gg run ${ticket} --flow <name> starts a new Execution on that branch.\n`
    );
  } finally {
    await locks.release(lock);
  }
}

// What gg work done reaches: the deps a Run has, with the locks, and whether the person passed --close.
export interface DoneOptions {
  ticket: number;
  commonDir: string;
  cwd: string;
  labelPrefix: string;
  deps: runContext.Deps & { locks: locks.Locks };
  close: boolean;
  log: (line: string) => void;
}

// Stub (#133): records nothing.
export async function done(_options: DoneOptions): Promise<string> {
  return '';
}

// What gg work resume reaches, under the ticket lock gg run's admission holds: the Flow the record runs under, and the
// deps of the Run that resumes it.
export interface ResumeOptions {
  ticket: number;
  vertex: string;
  commonDir: string;
  cwd: string;
  labelPrefix: string;
  flow: model.ResolvedFlow | undefined;
  deps: Pick<runContext.Deps, 'gh' | 'git' | 'integrity' | 'locks' | 'database'>;
  events: ReturnType<typeof events.eventLog>;
}

// Stub (#133): repositions nothing.
export async function resume(_options: ResumeOptions): Promise<void> {}
