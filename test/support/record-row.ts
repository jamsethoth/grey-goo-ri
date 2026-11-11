import type * as record from '../../lib/record.ts';

// The records row lib/record.ts saves, as its text: a test's golden row, or a row it writes behind the module's back.
// An Execution Record comes here through record.toJson, which converts its Maps.
export const json = (row: record.ExecutionRecordJson | Omit<record.EpicRecord, 'commonDir'>): string =>
  `${JSON.stringify(row, null, 2)}\n`;
