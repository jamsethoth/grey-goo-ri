// Execution Records seeded into a State Database in each of the shapes a Run tells apart: a resume, a report still to
// finish, a fresh hold that landed, a held record and a finished one.
import * as events from '../../lib/events.ts';
import type * as interpreter from '../../lib/interpreter.ts';
import * as record from '../../lib/record.ts';

const RUN = '20261016T000000Z-seed00';

// A Terminal's stop with every field, held unless `change` says otherwise.
const terminalStop = (change: Partial<record.TerminalStop>): record.TerminalStop => ({
  outcome: 'needs-human',
  response: null,
  actionRef: null,
  held: true,
  abandoned: false,
  inProgress: false,
  fresh: false,
  stopped: false,
  commentTemplate: null,
  advice: null,
  detail: null,
  error: null,
  failureClass: null,
  interrupted: null,
  ...change,
});

const ADMISSION_HOLD: record.AdmissionStop = {
  kind: 'hold',
  name: 'branch-mismatch',
  terminalReasonText: 'An earlier Run held the Ticket.',
  fresh: false,
  advice: null,
  detail: null,
  inProgress: false,
  error: null,
};

// Each shape by the Resumption a Run gives it: the changes to a new record, and whether its ticket_end landed.
export const SHAPES: {
  name: string;
  resumption: interpreter.Resumption;
  change: Partial<record.ExecutionRecord>;
  ended: boolean;
}[] = [
  { name: 'an active record', resumption: 'resume', change: {}, ended: false },
  {
    name: 'an admission hold whose report has not landed',
    resumption: 'finish-report',
    change: { admissionStop: ADMISSION_HOLD },
    ended: false,
  },
  {
    name: 'an active record with an admission hold that landed',
    resumption: 'resume',
    change: { admissionStop: ADMISSION_HOLD },
    ended: true,
  },
  {
    name: 'a held record whose report has not landed',
    resumption: 'finish-report',
    change: { state: 'held', terminalStop: terminalStop({}) },
    ended: false,
  },
  {
    name: 'a held record whose report landed',
    resumption: 'held',
    change: { state: 'held', terminalStop: terminalStop({}) },
    ended: true,
  },
  {
    name: 'a fresh hold whose report has not landed',
    resumption: 'finish-report',
    change: { state: 'held', terminalStop: terminalStop({ fresh: true }) },
    ended: false,
  },
  {
    name: 'a fresh hold whose report landed',
    resumption: 'restart',
    change: { state: 'held', terminalStop: terminalStop({ fresh: true }) },
    ended: true,
  },
  { name: 'a finished record', resumption: 'finished', change: { state: 'ready-for-qa' }, ended: true },
  {
    name: 'an abandoned record whose report has not landed',
    resumption: 'finish-report',
    change: { state: 'needs-human', terminalStop: terminalStop({ held: false, abandoned: true }) },
    ended: false,
  },
];

// Ticket `ticket`'s record pinned to `flow`, in `shape`, saved in `commonDir`'s State Database.
export function seed(
  commonDir: string,
  ticket: number,
  flow: string,
  shape: (typeof SHAPES)[number],
): record.ExecutionRecord {
  const executionRecord = {
    ...record.createExecutionRecord({
      commonDir,
      repository: 'o/r',
      ticket,
      epic: null,
      flow: { name: flow, entry: 'red' },
      configHash: 'x',
      run: RUN,
      worktree: `${commonDir}/wt/ticket-${ticket}`,
      branch: `ticket/${ticket}-seeded`,
      base: 'main',
    }),
    ...shape.change,
  };
  record.save(executionRecord);
  if (shape.ended)
    events.eventLog(commonDir, { run: RUN })('ticket_end', { run: RUN, execution: executionRecord.execution, ticket });
  return executionRecord;
}
