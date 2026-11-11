import * as jsonValue from '../../lib/json-value.ts';
import type * as record from '../../lib/record.ts';

// The records row lib/record.ts saves, as its text: a test's golden row, or a row it writes behind the module's back.
// An Execution Record comes here through record.toJson, which converts its Maps. Each kind is serialized as
// lib/record.ts serializes it, so a golden row is the text a save writes.
export const json = (row: record.ExecutionRecordJson | Omit<record.EpicRecord, 'commonDir'>): string =>
  `${'execution' in row ? jsonValue.text(row, 'the row', 2) : jsonValue.text(row, 'the row', 2)}\n`;
