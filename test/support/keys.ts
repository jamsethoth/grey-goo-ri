// The slash-joined keys tests look things up by. They look alike, so each is built by name.
import * as marker from '../../lib/marker.ts';

interface ActionPlace {
  vertex: string;
  visit: number;
  action: string;
}

// The fake harness's scripted response for one Attempt of an agent phase: `vertex/visit/phase/attempt`.
export const responseKey = (vertex: string, visit: number, phase: string, attempt: number): string =>
  `${vertex}/${visit}/${phase}/${attempt}`;

// An Action's retries in the Execution Record: `vertex/visit/action/recovery`, lib's own key.
export const retryKey = (actionRef: ActionPlace & { recovery: number }): string => marker.actionKeyOf(actionRef);

// An agent Action's Session in the Execution Record: `vertex/visit/action`.
export const sessionKey = ({ vertex, visit, action }: ActionPlace): string => `${vertex}/${visit}/${action}`;

// One Attempt's Action Event: `vertex/visit/action/recovery/attempt`.
export const eventKey = (event: ActionPlace & { recovery: number; attempt: number }): string =>
  `${retryKey(event)}/${event.attempt}`;
