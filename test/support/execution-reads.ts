// What a case reads back of a golden Execution: its saved record and write-ahead log, its Action Events, and the
// Ticket branch as the injected git holds it.
import * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as terminalReport from '../../lib/terminal-report.ts';
import * as caseDatabase from './case-database.ts';
import * as golden from './golden.ts';

type GoldenFixture = golden.GoldenFixture;
type Readable = Pick<GoldenFixture, 'readEvents'>;

// The saved record of a Ticket, the golden fixture's by default, freshly loaded.
export const loadTicket = (fixture: { commonDir: string }, ticket = golden.TICKET): record.ExecutionRecord =>
  record.load(fixture.commonDir, 'ticket', ticket) as record.ExecutionRecord;

// The saved row read without awaiting, for a getter that cannot await.
export const ticketRow = (fixture: { commonDir: string }): record.ExecutionRecord =>
  JSON.parse(caseDatabase.savedJson(fixture.commonDir, 'ticket', golden.TICKET) as string);

export const intents = (executionRecord: record.ExecutionRecord, effect: string) =>
  executionRecord.writeAheadLog.filter((entry) => entry.step === 'intent' && entry.effect === effect);

// The write-ahead steps an Action Marker's entries took, in order.
export const writeAheadSteps = (executionRecord: record.ExecutionRecord, actionMarker: string): string[] =>
  executionRecord.writeAheadLog.filter((entry) => entry.actionMarker === actionMarker).map((entry) => entry.step);

// The Action Marker of the first Attempt of an Action in the first Visit.
export const actionMarker = (fixture: GoldenFixture, vertex: string, action: string, recovery = 0) =>
  golden.markerOf(fixture.executionRecord, vertex, 1, action, recovery);
export const attemptMarker = (fixture: GoldenFixture, ...place: golden.MarkerPlace) =>
  golden.markerOf(fixture.executionRecord, ...place);

export const isAction = (
  event: events.Event,
  vertex: string,
  action: string,
  recovery: number,
): event is events.ActionEvent =>
  event.type === 'action' && event.vertex === vertex && event.action === action && event.recovery === recovery;

export const actionEvent = (fixture: Readable, vertex: string, action: string, recovery = 0) =>
  fixture.readEvents().find((event) => isAction(event, vertex, action, recovery));
export const attemptsOf = (fixture: Readable, vertex: string, action: string, recovery = 0) =>
  fixture.readEvents().filter((event) => isAction(event, vertex, action, recovery));
// Each visit_end Event, in order, without the identity a case does not vary (time, run, execution and ticket).
export const visitEnds = (fixture: Readable) =>
  fixture
    .readEvents()
    .filter((event): event is events.VisitEndEvent => event.type === 'visit_end')
    .map(({ vertex, visit, outcome, rule, next, edge, count, spent }) => ({
      vertex,
      visit,
      outcome,
      rule,
      next,
      edge,
      count,
      spent,
    }));
// The case's Execution's run stop, as its Action Events record it.
export const runStopEvent = (fixture: GoldenFixture) =>
  terminalReport.runStopEvent(
    fixture
      .readEvents()
      .filter((event) => 'execution' in event && event.execution === fixture.executionRecord.execution),
  );

type GitFixture = Pick<GoldenFixture, 'options' | 'worktree' | 'base' | 'mainRoot'>;

// The Ticket branch as the injected git, real or fake, holds it: commit messages since the base, oldest first. A base
// missing from the log throws, so no commit is dropped or added unnoticed.
export async function branchMessages(fixture: GitFixture): Promise<string[]> {
  const log = await fixture.options.deps.git.commitLog(fixture.worktree, golden.BRANCH);
  const since = log.findIndex((commit) => commit.sha === fixture.base);
  if (since < 0) throw new Error(`base ${fixture.base} is not in the log of ${golden.BRANCH}`);
  return log
    .slice(0, since)
    .map((commit) => commit.message)
    .reverse();
}
export const subjects = async (fixture: GitFixture): Promise<string[]> =>
  (await branchMessages(fixture)).map((message) => message.split('\n')[0] as string);
export const headSha = (fixture: GitFixture) => fixture.options.deps.git.headSha(fixture.worktree);
// The Ticket branch's commit on origin, or null. A test that holds the repo lock passes the unlocked git.
export const originSha = (fixture: GitFixture, git = fixture.options.deps.git) =>
  git.remoteSha(fixture.mainRoot, golden.BRANCH);
