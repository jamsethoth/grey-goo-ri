// The write-ahead log an Execution Record keeps: the intent, evidence and completion of every side effect, by its
// Action Marker, so Reconciliation can tell which effects landed (request 3.5). The State Database's writes append to
// it (record.createStateDatabase); these read it.
import type * as record from './record.ts';

// One step of a side effect in the write-ahead log.
export interface WriteAheadEntry {
  step: 'intent' | 'evidence' | 'complete';
  actionMarker: string;
  effect: string | null;
  payload: unknown;
  evidence: Record<string, unknown> | null;
  time: string;
}

// Every entry carries every field, so `payload` and `evidence` are null where its step has none.
export const entryOf = (
  step: WriteAheadEntry['step'],
  actionMarker: string,
  effect: string | null,
  { payload = null, evidence = null }: { payload?: unknown; evidence?: WriteAheadEntry['evidence'] } = {},
): WriteAheadEntry => ({
  step,
  actionMarker,
  effect,
  payload,
  evidence,
  time: new Date().toISOString(),
});

// A marker's first entry at a step.
export const findEntry = (
  executionRecord: record.ExecutionRecord,
  actionMarker: string,
  step: WriteAheadEntry['step'],
): WriteAheadEntry | undefined =>
  executionRecord.writeAheadLog.find((entry) => entry.actionMarker === actionMarker && entry.step === step);

// The effect a marker's intent named, or null before its intent.
export function effectOf(executionRecord: record.ExecutionRecord, actionMarker: string): string | null {
  return (
    executionRecord.writeAheadLog.find((entry) => entry.actionMarker === actionMarker && entry.step === 'intent')
      ?.effect ?? null
  );
}

// The evidence that proves a marker's effect landed. A failed effect saves evidence too (a label write that did not
// land saves { ok: false }), which proves nothing: that Action is reconciled and redone as if it had none.
export const evidenceOf = (
  executionRecord: record.ExecutionRecord,
  actionMarker: string,
): WriteAheadEntry | undefined =>
  executionRecord.writeAheadLog.findLast(
    (entry) => entry.actionMarker === actionMarker && entry.step === 'evidence' && entry.evidence?.ok !== false,
  );

export function openIntents(executionRecord: record.ExecutionRecord): WriteAheadEntry[] {
  const done = new Set(
    executionRecord.writeAheadLog.filter((entry) => entry.step === 'complete').map((entry) => entry.actionMarker),
  );
  return executionRecord.writeAheadLog.filter((entry) => entry.step === 'intent' && !done.has(entry.actionMarker));
}

// The evidence of the last commit gg made, or undefined before its first: the branch must still be at its sha.
export const lastCommit = (executionRecord: record.ExecutionRecord): WriteAheadEntry | undefined =>
  executionRecord.writeAheadLog.findLast(
    (entry) => entry.step === 'evidence' && entry.effect === 'commit' && entry.evidence!.sha,
  );
