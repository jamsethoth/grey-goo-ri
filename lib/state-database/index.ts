// Stub (#367): the State Database's connection and the database a Run is handed, moving here from
// lib/state-database.ts and lib/record.ts.
import * as record from '../record.ts';

export {
  SCHEMA_VERSION,
  StateDatabaseVersionError,
  close,
  create,
  filePath,
  missingMessage,
  open,
} from '../state-database.ts';
export const { createStateDatabase } = record;
export type StateDatabase = record.StateDatabase;

export const {
  save,
  intent,
  evidence,
  complete,
  beforeAppend,
  load,
  loadAll,
  removeRecord,
  appendEvent,
  readEvents,
  executionEvents,
  rowsNaming,
  hasTicketEnd,
  savePinnedConfiguration,
  loadPinnedConfiguration,
  saveCheckResult,
  reusablePass,
} = record.createStateDatabase();
