// An Action Event's Signals as a case reads them: the Claim and the Check signals, which an agent or Check Action's
// Event always holds (lib/events.ts declares each Signal optional, since an effect reads none).
import type * as events from '../../lib/events.ts';

export type ActionSignals = events.ActionSignals & Required<Pick<events.ActionSignals, 'claim' | 'checks'>>;

export const signalsOf = (event: { signals: events.ActionSignals }): ActionSignals => event.signals as ActionSignals;
