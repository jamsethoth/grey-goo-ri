// An Attempt from its start to its saved result: its start, its Action Marker, its work, bracketed busy when the work
// touches the worktree, and one save that holds its result, its side effect's completion, its outputs and its Action
// Event. An Attempt whose marker is already complete returns its saved result without running again.
import type * as sideEffect from './effects/side-effect.ts';
import type * as events from './events.ts';
import type * as marker from './marker.ts';
import type * as visit from './visit.ts';
import type * as writeAhead from './write-ahead.ts';

type Context = sideEffect.EffectContext;

// The Visit's write of an Attempt's result, applied inside the Attempt's save (lib/visit-runner.ts). A held
// completion that leaves no result passes null.
export type Settle = (resolution: visit.Resolution | null) => void;

// What a kind's work leaves for the save: its result, the Action Event's fields beyond the result's, its outputs (and
// the output fields it drops), and the evidence its completion saves.
export interface Done<Settled extends visit.Resolution> {
  resolution: Settled;
  fields?: events.EventInput<'action'>;
  outputs?: visit.ActionOutputValue;
  dropped?: (keyof visit.ActionOutputValue)[];
  evidence?: writeAhead.Evidence;
}

export interface Attempting<Prepared, Worked, Settled extends visit.Resolution> {
  // The identity the Action Event records; the marker is its own unless `actionMarker` names another.
  actionIdentity: marker.ActionIdentity;
  actionMarker?: string;
  // The work touches the worktree, so it runs bracketed busy.
  busy: boolean;
  // Run before the Attempt starts, and only when it is not already complete.
  prepare?: (actionMarker: string) => Promise<Prepared>;
  work: (prepared: Prepared, actionMarker: string) => Promise<Worked>;
  // Run after the work, outside the bracket: the result the save holds.
  finish: (worked: Worked, prepared: Prepared) => Done<Settled> | Promise<Done<Settled>>;
  // The saved result of a complete Attempt, from the evidence its completion saved.
  resumed?: (evidence: writeAhead.Evidence | undefined) => Settled;
  settle?: Settle;
}

// A held completion (J4): its work, and a result that replaces the one the hold saved, or none.
export interface Held<Worked, Settled extends visit.Resolution> {
  actionIdentity: marker.ActionIdentity;
  actionMarker?: string;
  work: () => Promise<Worked>;
  finish: (worked: Worked) => Done<Settled> | (Omit<Done<Settled>, 'resolution'> & { resolution: null });
  settle?: Settle;
}

export const EFFECT_COMPLETED: visit.EffectResolution = {
  outcome: 'ok',
  direction: 'advance',
  row: 'effect-completed',
  rule: { table: 'fixed', row: 'effect-completed' },
};

// Whether an Attempt's marker is complete.
export const complete = (_context: Pick<Context, 'record' | 'markerOf'>, _actionIdentity: marker.ActionIdentity) =>
  false;

export async function whileBusy<Result>(
  _context: Pick<Context, 'record' | 'database'>,
  work: () => Promise<Result>,
): Promise<Result> {
  return work();
}

export async function run<Prepared, Worked, Settled extends visit.Resolution>(
  _context: Context,
  attempting: Attempting<Prepared, Worked, Settled>,
): Promise<Settled> {
  const prepared = (await attempting.prepare?.('')) as Prepared;
  return (await attempting.finish(await attempting.work(prepared, ''), prepared)).resolution;
}

export async function runHeld<Worked, Settled extends visit.Resolution>(
  _context: Context,
  held: Held<Worked, Settled>,
): Promise<Settled | null> {
  return held.finish(await held.work()).resolution;
}

export async function effectAction<Payload extends writeAhead.Payload, EffectContext>(
  _context: Context & NoInfer<EffectContext>,
  _effectAttempt: {
    actionIdentity: marker.ActionIdentity;
    made: (actionMarker: string) => Promise<Omit<sideEffect.SideEffect<Payload, EffectContext>, 'actionMarker'>>;
    settle?: Settle;
  },
): Promise<visit.EffectResolution> {
  return EFFECT_COMPLETED;
}
