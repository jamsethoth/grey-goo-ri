import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as recordReadNode from '../../lib/record-read-node.ts';

interface Intent {
  step: string;
  effect: string;
  payload: unknown;
}
// The intents of the record fixture's write-ahead log: one of every Effect and of an agent call, each with the payload
// it saves.
export const INTENTS = (
  JSON.parse(readFileSync(new URL('../fixtures/record-rows.json', import.meta.url), 'utf8')) as {
    execution: { writeAheadLog: Intent[] };
  }
).execution.writeAheadLog.filter((entry) => entry.step === 'intent');

// What a payload reader makes of each intent's payload, as a list of what it got wrong: its own effect's payload read
// as anything but itself, or another effect's read, or refused by a problem not naming the payload's path.
export function misreads(name: string, read: recordReadNode.Read<unknown>): string[] {
  return INTENTS.flatMap(({ effect, payload }) => {
    let outcome: { read: unknown } | { refused: string };
    try {
      outcome = { read: read({ value: payload, path: 'payload' }) };
    } catch (err) {
      if (!(err instanceof recordReadNode.RowFieldError)) throw err;
      outcome = { refused: err.message };
    }
    if (effect === name)
      return isDeepStrictEqual(outcome, { read: payload })
        ? []
        : [`${name} misreads its own payload ${JSON.stringify(payload)}: ${JSON.stringify(outcome)}`];
    return 'refused' in outcome && /^its payload[ .]/.test(outcome.refused)
      ? []
      : [`${name} does not refuse ${effect}'s payload by its path: ${JSON.stringify(outcome)}`];
  });
}
