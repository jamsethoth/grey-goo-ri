// An Action Event's Signals as a case reads them; the event declares them only as a record (lib/events.ts).
import type * as visit from '../../lib/visit.ts';

export interface ActionSignals {
  claim: visit.ClaimSignal;
  checks: visit.CheckSignal[];
  [signal: string]: unknown;
}

export const signalsOf = (event: { signals: Record<string, unknown> }): ActionSignals => event.signals as ActionSignals;
