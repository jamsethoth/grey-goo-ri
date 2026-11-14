// The write-ahead log an Execution Record keeps: the intent, evidence and completion of every side effect, by its
// Action Marker, so Reconciliation can tell which effects landed (request 3.5). The State Database's writes append to
// it (record.createStateDatabase); these read it.
import type * as approvalAction from './approval-action.ts';
import type * as effects from './effects/index.ts';
import type * as integrity from './integrity.ts';
import type * as jsonValue from './json-value.ts';
import type * as record from './record.ts';

// What an intent saves ahead of its effect: an Effect's payload (lib/effects/), a consumed Decision's, or an agent
// Attempt's baseline.
export type CallPayload = { baseline: integrity.IntegrityBaseline };
export type Payload = effects.Payload | approvalAction.Consumption | CallPayload;

// What a side effect leaves as proof, by its effect's own fields: a sha, an id, a url. A settled Action's also holds
// its Resolution's fields, as JSON, which the next Attempt reads: what a row read back gives (#402).
export type Evidence = Record<string, jsonValue.JsonValue>;

// One step of a side effect in the write-ahead log.
export interface WriteAheadEntry {
  step: 'intent' | 'evidence' | 'complete';
  actionMarker: string;
  effect: string | null;
  payload: Payload | null;
  evidence: Evidence | null;
  time: string;
}

// Every entry carries every field, so `payload` and `evidence` are null where its step has none.
export const entryOf = (
  step: WriteAheadEntry['step'],
  actionMarker: string,
  effect: string | null,
  { payload = null, evidence = null }: { payload?: Payload | null; evidence?: Evidence | null } = {},
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
  executionRecord.writeAheadLog.find(
    (entry) => entry.actionMarker === actionMarker && entry.step === 'evidence' && entry.evidence?.ok !== false,
  );

export function openIntents(executionRecord: Pick<record.ExecutionRecord, 'writeAheadLog'>): WriteAheadEntry[] {
  const done = new Set(
    executionRecord.writeAheadLog.filter((entry) => entry.step === 'complete').map((entry) => entry.actionMarker),
  );
  return executionRecord.writeAheadLog.filter((entry) => entry.step === 'intent' && !done.has(entry.actionMarker));
}
