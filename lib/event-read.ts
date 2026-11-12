// Stub (#350): the read side of the event log, each row checked against the declaration it was written from.
import type * as events from './events.ts';

export class EventCorruptError extends Error {
  declare id: number;
  declare raw: string;
  constructor(id: number, type: string, reason: string, raw: string) {
    super(`${id} ${type} ${reason}`);
    this.name = 'EventCorruptError';
    this.id = id;
    this.raw = raw;
  }
}

export const readEvents = (_commonDir: string): events.Event[] => [];

export const executionEvents = (
  _commonDir: string,
  _execution: string,
  _onRefused?: (err: EventCorruptError) => void,
): events.Event[] => [];
