// `gg work`: a person's recovery verbs over the Tickets gg runs. Only abandon is implemented.
import type * as github from './github.ts';
import * as labels from './labels.ts';
import type * as locks from './locks.ts';
import * as record from './record.ts';

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
// stay, so the next gg run starts a new Execution on that branch. An in-progress label with no record behind it reads
// as stuck, so it goes first, and the row only once it has.
export async function abandon({ ticket, commonDir, cwd, labelPrefix, gh, locks }: AbandonOptions): Promise<string> {
  const lock = await locks.tryAcquire(commonDir, `ticket-${ticket}`);
  if (!lock)
    throw new Error(
      `another process holds the ticket-${ticket} lock, so Ticket ${ticket} may be running; abandon it once that ` +
        'process ends',
    );
  try {
    const executionRecord = record.load(commonDir, 'ticket', ticket);
    if (!executionRecord) throw new Error(`Ticket ${ticket} has no Execution Record to abandon`);
    const inProgress = labels.labelsFor(labelPrefix).state('in-progress');
    const labelled = labels.hasLabel(gh.labelNames(await gh.viewIssue(ticket, cwd)), inProgress);
    const failures: string[] = [];
    const report = { log: (line: string) => failures.push(line), ev: () => {} };
    if (labelled && !(await gh.setLabels(ticket, { remove: [inProgress] }, cwd, report)))
      throw new Error(`${failures.join('; ')}; Execution Record ticket-${ticket} is kept`);
    record.removeRecord(commonDir, 'ticket', ticket);
    const removed = labelled ? ` and removed the ${inProgress} label` : '';
    return (
      `gg work abandon deleted Execution Record ticket-${ticket} of Flow ${executionRecord.flow}${removed}; its ` +
      `Events, its worktree ${executionRecord.worktree} and its branch ${executionRecord.branch} are kept. ` +
      `gg run ${ticket} --flow <name> starts a new Execution on that branch.\n`
    );
  } finally {
    await locks.release(lock);
  }
}
