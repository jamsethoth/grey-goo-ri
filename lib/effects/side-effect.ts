// The write-ahead side effects of an Execution's Actions: the context they read, whileBusy, and each Effect's intent,
// evidence and completion with its Action Event. A remote Effect's retries are remote-effects'.
import type * as marker from '../marker.ts';
import type * as writeAhead from '../write-ahead.ts';
import type * as effects from './index.ts';
import type * as legacy from '../effects.ts';

export {
  whileBusy,
  saveResolution,
  replaceResolution,
  completeEffect,
  type EffectContext,
  type RemoteRetry,
  type RunState,
  type RunStop,
  type SavedResolution,
} from '../effects.ts';

export interface SideEffect<Payload, Context> {
  actionMarker: string;
  effect: effects.Effect<Payload, Context>;
  payload: Payload;
  // Completed by `saveResolution`, with its Action Event.
  deferred?: boolean;
}

// An Action whose effect is proven by saved evidence is not repeated; an open one, left by Reconciliation to be redone,
// reuses its intended payload.
export async function sideEffect<Payload extends writeAhead.Payload, Context>(
  _context: legacy.EffectContext & NoInfer<Context>,
  _sideEffect: SideEffect<Payload, Context>,
): Promise<writeAhead.Evidence> {
  return { stub: true };
}

// One deterministic Action outside any Visit's Actions, a Terminal's or a Pending report's: bracketed, write-ahead,
// with its own Action Event.
export async function effectAction<Payload extends writeAhead.Payload, Context>(
  _context: legacy.EffectContext & NoInfer<Context>,
  _actionIdentity: marker.ActionIdentity,
  _sideEffect: Omit<SideEffect<Payload, Context>, 'actionMarker' | 'deferred'>,
): Promise<writeAhead.Evidence> {
  return { stub: true };
}
