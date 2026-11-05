// The State Database a case's fixtures write through, and the saved rows read back as another process reads them.
import type { TestContext } from 'node:test';
import type * as events from '../../lib/events.ts';
import * as record from '../../lib/record.ts';
import * as sqlite from '../../lib/sqlite.ts';

type Saved = record.ExecutionRecord | record.EpicRecord;
type SaveHook = (next: Saved) => void;
type AppendHook = (event: events.Event) => void;

// A saved record's JSON as its row holds it, or undefined when none is saved, read without awaiting, for a getter that
// cannot await.
export function savedJson(commonDir: string, kind: 'ticket' | 'epic', number: number): string | undefined {
  const row = sqlite.openDb(commonDir).prepare('SELECT json FROM records WHERE kind = ? AND n = ?').get(kind, number);
  return row?.json as string | undefined;
}

// The hooks of each case's State Database, keyed by the case's test context: every fixture the case builds writes
// through them, and they end with the case, so none reaches the next one.
const caseHooks = new WeakMap<TestContext, { saves: Set<SaveHook>; appends: Set<AppendHook> }>();
function hooksOf(t: TestContext) {
  const known = caseHooks.get(t);
  if (known) return known;
  const fresh = { saves: new Set<SaveHook>(), appends: new Set<AppendHook>() };
  caseHooks.set(t, fresh);
  return fresh;
}

// The State Database a case's fixtures write through: each hook `onSave` or `failAppends` added for the case sees every
// record about to be saved or Event about to be inserted, and may throw to fail that write.
export function caseDatabase(t: TestContext): record.StateDatabase {
  const hooks = hooksOf(t);
  return record.createStateDatabase({
    beforeSave: (next: Saved) => hooks.saves.forEach((hook) => hook(next)),
    beforeAppend: (event: events.Event) => hooks.appends.forEach((hook) => hook(event)),
  });
}

// Runs `hook` before each save the case's fixtures make, until the returned function is called.
export function onSave(t: TestContext, hook: SaveHook): () => boolean {
  const { saves } = hooksOf(t);
  saves.add(hook);
  return () => saves.delete(hook);
}

// Fails each save whose record, and the row saved for it so far (or undefined), match `when(saved, next)`, as a disk
// error would. Undone by the returned function or when the case ends.
export const failSaves = (t: TestContext, when: (saved: Saved | undefined, next: Saved) => boolean): (() => boolean) =>
  onSave(t, (next) => {
    const json =
      'execution' in next
        ? savedJson(next.commonDir, 'ticket', next.ticket)
        : savedJson(next.commonDir, 'epic', next.epic);
    if (when(json === undefined ? undefined : JSON.parse(json), next)) throw new Error('disk I/O error');
  });

// Fails each Event insert that matches `when(event)`, as a disk error would. Undone by the returned function or when
// the case ends.
export function failAppends(t: TestContext, when: (event: events.Event) => boolean): () => boolean {
  const { appends } = hooksOf(t);
  const hook: AppendHook = (event) => {
    if (when(event)) throw new Error('disk I/O error');
  };
  appends.add(hook);
  return () => appends.delete(hook);
}
