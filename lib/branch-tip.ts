// The branch tip an Execution Record proves, which Reconciliation holds a branch to and publishing pushes and marks
// ready: gg's own last commit, or the tip a person's gg work resume took as the baseline when that came later (Q2 A).
import * as commit from './effects/commit.ts';
import * as eventRead from './event-read.ts';
import type * as record from './record.ts';

// The branch tip the record proves: gg's last commit, or the tip a person's gg work resume took as the baseline when
// that came later or in the same millisecond (Q2 A): a resume stamps a commit it recovers just before it saves its
// own Event. Reconciliation holds a branch elsewhere as changed by hand, and publishing pushes and marks
// ready this commit, never HEAD. Null before either.
export function provenTip(executionRecord: record.ExecutionRecord): { sha: string; what: string } | null {
  const last = commit.lastCommit(executionRecord);
  // A refused resume stops the read: without its baseline, a record with no commit of gg's would check no tip at all.
  // Its columns may be the corrupt part, so a row naming this Execution or a resume anywhere counts; any other refused
  // row is passed over.
  const resumed = eventRead
    .rowsNaming(executionRecord.commonDir, executionRecord.execution, (err) => {
      if (err.type === 'ticket_resumed' || err.raw.includes('"ticket_resumed"')) throw err;
    })
    .findLast((event) => event.type === 'ticket_resumed');
  const committedAt =
    last &&
    executionRecord.writeAheadLog.findLast(
      (entry) => entry.step === 'evidence' && entry.actionMarker === last.actionMarker,
    )?.time;
  if (resumed?.type === 'ticket_resumed' && (!committedAt || resumed.time >= committedAt))
    return { sha: resumed.head, what: `${resumed.head}, the tip gg work resume took as the baseline` };
  return last ? { sha: last.sha, what: `commit ${last.sha} of Action Marker ${last.actionMarker}` } : null;
}
