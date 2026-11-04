// A Terminal's report: its comment and label Actions, each write-ahead with its Action Event, the stop it saves
// first, and the state and ticket_end it lands with.
import * as config from './config.mjs';
import * as effectErrors from './effect-errors.ts';
import type * as effectEvidence from './effect-evidence.ts';
import * as effects from './effects.ts';
import * as events from './events.ts';
import * as github from './github.ts';
import * as labels from './labels.ts';
import type * as marker from './marker.ts';
import * as outcome from './outcome.ts';
import * as record from './record.ts';
import * as render from './render.mjs';

type DiffStatsFile = Parameters<typeof events.diffStats>[0][number];

// What a Terminal reads beside the effects' context, which runExecution builds (interpreter.mjs): the Event log and Run
// its ticket_end goes to, the Layer files a stop token's comment renders, and how each Terminal Action is entered and
// marked.
export interface TerminalContext extends effects.EffectContext {
  gh: github.Gh;
  git: effectEvidence.EvidenceGit & { diffStats(worktree: string, base: string): Promise<DiffStatsFile[]> };
  events: ReturnType<typeof events.eventLog>;
  run: string;
  files: unknown;
  publicText: (text: string) => string;
  enter: (actionRef: marker.ActionRef) => Promise<void>;
  markerOf: (actionRef: marker.ActionRef) => string;
}

// What a Terminal returns to the Run: its end state, and whether it was held, a fault, or carried a run stop.
export interface TerminalResult {
  outcome: string;
  held?: true;
  fault?: true;
  runStop?: { failureClass: string };
}

// Any of a Terminal stop's fields; declaredStop fills the rest.
export type StopDeclaration = Partial<record.TerminalStop> & { outcome: string };

// Every Terminal stop is saved with every field, so a reader never meets a missing key: flags false, the rest null.
export const declaredStop = (stop: StopDeclaration): record.TerminalStop => ({
  outcome: stop.outcome,
  response: stop.response ?? null,
  // The stopped Action's identity, or null for a stop decided before any Action.
  actionRef: stop.actionRef ?? null,
  held: stop.held ?? false,
  abandoned: stop.abandoned ?? false,
  inProgress: stop.inProgress ?? false,
  fresh: stop.fresh ?? false,
  // A stop token's `stopped` table decided, and `comment` names the template its comment renders.
  stopped: stop.stopped ?? false,
  commentTemplate: stop.commentTemplate ?? null,
  advice: stop.advice ?? null,
  detail: stop.detail ?? null,
  error: stop.error ?? null,
  failureClass: stop.failureClass ?? null,
  interrupted: stop.interrupted ?? null,
});

// An Execution's run stop: the first of its Action Events whose Failure Class reaches the whole Run, or null. The
// Events only grow, so no later Terminal can lose it (#251).
export const runStopEvent = <Logged extends { type: string }>(executionEvents: Logged[]): Logged | null =>
  executionEvents.find((event) => event.type === 'action' && reachOf(event as { failureClass?: string }) === 'run') ??
  null;

const reachOf = ({ failureClass }: { failureClass?: string }) =>
  outcome.FAILURE_CLASSES[failureClass as outcome.FailureClass]?.reach;

// The run stop an Execution's result reports, read from its Action Events.
export function runStopOf(executionRecord: record.ExecutionRecord): { failureClass: string } | null {
  const event = runStopEvent(events.executionEvents(executionRecord.commonDir, executionRecord.execution));
  return event && { failureClass: (event as events.ActionEvent).failureClass as string };
}

type StopFlags = Pick<record.TerminalStop, 'error' | 'held' | 'abandoned'>;

// The report a Terminal's Actions are named for. A fault report, a hold and an abandonment each have their own, so
// their Actions never replay the open intent of an end they interrupted.
function reportOf(stop: Partial<StopFlags> | null | undefined): 'fault' | 'hold' | 'abandon' | 'end' {
  if (stop?.error) return 'fault';
  if (stop?.held) return 'hold';
  if (stop?.abandoned) return 'abandon';
  return 'end';
}

// A Terminal's Action identity: `<report>-<effect>`, Recovery Number 0. An abandonment is reported under its State
// Label.
export const terminalAt =
  (name: string, stop: Partial<StopFlags> | null | undefined) =>
  (effect: string): marker.ActionRef & { procedure: null } => ({
    vertex: stop?.abandoned ? labels.NEEDS_HUMAN : name,
    visit: 1,
    procedure: null,
    action: `${reportOf(stop)}-${effect}`,
    recovery: 0,
  });

// One deterministic Action of a Terminal: bracketed, write-ahead, with its own Action Event.
async function terminalAction<Payload>(
  context: TerminalContext,
  actionRef: marker.ActionRef,
  { effect, payload, perform }: Omit<effects.SideEffect<Payload>, 'actionMarker' | 'deferred'>,
) {
  const startedAt = context.clock.now();
  await context.enter(actionRef);
  const actionMarker = context.markerOf(actionRef);
  const evidence = await effects.bracket(context, () =>
    effects.sideEffect(context, { actionMarker, effect, payload, perform, deferred: true }),
  );
  await effects.effectDone(context, actionRef, startedAt, actionMarker);
  return evidence;
}

// Saved before the first Terminal Action, so a restart inside the Terminal runs the same Actions under the same ids and
// ends with the same classification: held, fault with its error, or a run stop. The save that decides a hold, fault or
// abandonment also retires the admission decision it reports.
async function savedStop(context: TerminalContext, given: StopDeclaration | undefined) {
  const { record: executionRecord } = context;
  if (!given) return executionRecord.terminalStop;
  const stop = declaredStop(given);
  executionRecord.terminalStop = stop;
  executionRecord.admissionStop = null;
  await context.database.save(executionRecord);
  return stop;
}

// In a fault the report is best effort: a failing comment or label must not keep the state and ticket_end from landing.
function tolerated<Result>(context: TerminalContext, stop: record.TerminalStop | null, report: Promise<Result>) {
  if (!stop?.error) return report;
  return report.catch((err) => {
    if (effectErrors.fatal(err) || err instanceof effectErrors.EarlyTerminal) throw err;
    context.log(`#${context.record.ticket} fault report failed: ${(err as Error | undefined)?.message}`);
  });
}

// A stop token's comment replaces the end comment and carries the Terminal Reason, so the Ticket gets one comment (U6);
// a token that names none posts the Terminal Reason comment.
function commentBody(context: TerminalContext, { name, stop, reason }: Report, actionMarker: string): Promise<string> {
  const { record: executionRecord } = context;
  // A stop comment, the template the stop token names, reads the stopped Visit's outputs, inputs and response (audit
  // 10). Its heading is gg's Outcome, never the response's claim: a route can reach replan with a response that failed
  // validation.
  if (stop?.stopped && stop.response && stop.commentTemplate)
    return render.publicBody(
      config.layerFile(context.files, stop.commentTemplate),
      {
        ...record.visitScope(executionRecord, stop.actionRef!),
        response: stop.response,
        end: name,
        outcome: stop.outcome,
        reason: reason?.text,
      },
      actionMarker,
      context.publicText,
    );
  // A hold's advice is for the human reading its comment, not part of its one-sentence Terminal Reason.
  const shown = stop?.advice ? { ...reason, text: `${reason!.text}\n\n${stop.advice}` } : reason;
  return render.terminalComment(name, shown, actionMarker, stop?.detail, stop?.interrupted, context.publicText);
}

// The Terminal being reported: its end state, its saved stop, and its Terminal Reason as the report began.
interface Report {
  name: string;
  stop: record.TerminalStop | null;
  reason: record.TerminalReason | null;
}

// A failure to render the body is not the report's to tolerate: only the comment Action is.
async function postComment(
  context: TerminalContext,
  report: Report,
  { number, effect }: { number: number; effect: string },
) {
  const actionRef = terminalAt(report.name, report.stop)(effect);
  const body = await commentBody(context, report, context.markerOf(actionRef));
  return tolerated(
    context,
    report.stop,
    terminalAction(context, actionRef, {
      effect: 'comment',
      payload: { target: { kind: 'issue', number }, body, bodyHash: config.sha256(body) },
      perform: async (payload) => ({
        id: github.commentId(await context.gh.comment(payload.target.number, payload.body, context.cwd)),
      }),
    }),
  );
}

// The end's State Label replaces in-progress; an abandonment, under the human's label, only removes in-progress.
function setStateLabel(context: TerminalContext, { name, stop }: Report) {
  const { record: executionRecord, labelPrefix = labels.DEFAULT_PREFIX } = context;
  const state = labels.labels(labelPrefix).state;
  const change = { add: stop?.abandoned ? [] : [state(name)], remove: [state('in-progress')] };
  return tolerated(
    context,
    stop,
    terminalAction(context, terminalAt(name, stop)('label'), {
      effect: 'label',
      payload: { ticket: executionRecord.ticket, ...change },
      perform: async (payload) => {
        const ok = await context.gh.setLabels(
          payload.ticket,
          { add: payload.add, remove: payload.remove },
          context.cwd,
          {
            log: context.log,
            // setLabels reports a failed update as a label_failed Event.
            ev: context.events as github.LabelReport['ev'],
          },
        );
        // A hold or abandonment lands only with its label, so a failed one stays open for the next Run.
        if (!ok && (stop?.held || stop?.abandoned))
          throw new Error(`label update ${JSON.stringify({ add: payload.add, remove: payload.remove })} failed`);
        return { ok };
      },
    }),
  );
}

// The state the record lands in: abandoned, held, fault, or the end state itself.
function landedState(name: string, stop: record.TerminalStop | null): string {
  if (stop?.abandoned) return 'abandoned';
  if (stop?.held) return 'held';
  if (stop?.error) return 'fault';
  return name;
}

// Reports the Terminal `name`: the stop given, or the one saved when a resumed Terminal is given none.
export async function report(
  context: TerminalContext,
  name: string,
  given: StopDeclaration | undefined,
): Promise<TerminalResult> {
  const { record: executionRecord } = context;
  const stop = await savedStop(context, given);
  const report: Report = { name, stop, reason: executionRecord.terminalReason };
  // An abandonment posts nothing.
  if (!stop?.abandoned) await postComment(context, report, { number: executionRecord.ticket, effect: 'comment' });
  // The Epic's plan section replans, so needs-replan posts the same comment there (W9).
  if (name === 'needs-replan' && executionRecord.epic)
    await postComment(context, report, { number: executionRecord.epic, effect: 'epic-comment' });
  // Read outside the label's effect, which a Terminal resumed after it does not run again.
  const diffStats =
    name === 'ready-for-qa'
      ? events.diffStats(
          await effects.bracket(context, () => context.git.diffStats(executionRecord.worktree, executionRecord.base)),
          executionRecord.configurationSnapshot!.testPaths,
        )
      : null;
  if (!stop?.abandoned || stop.inProgress) await setStateLabel(context, report);
  executionRecord.state = landedState(name, stop);
  // The final state and ticket_end commit together: a Terminal has landed in both or in neither.
  await context.database.save(executionRecord, () =>
    context.events('ticket_end', {
      run: context.run,
      execution: executionRecord.execution,
      ticket: executionRecord.ticket,
      outcome: name,
      diffStats,
      terminalReason: report.reason,
      error: stop?.error,
      interrupted: stop?.interrupted,
    }),
  );
  const runStop = runStopOf(executionRecord);
  return {
    outcome: name,
    ...(stop?.held && { held: true as const }),
    ...(stop?.error && { fault: true as const }),
    ...(runStop && { runStop }),
  };
}
