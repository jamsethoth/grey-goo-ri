import * as record from './record.mjs';
import * as integrity from './integrity.mjs';
import { PROTECTED_PATHS } from './interpreter.mjs';

// shortcut: only an interrupted reset of a failed red Phase is reconciled; the other side effects join when resume lands.
// The reset is proven done only by a clean worktree at its baseline. Anything else is Held: dirty state found at
// resume is never discarded (ADR-0005), and the History item waits in the open intent.
export async function resets(rec, { git }) {
  for (const entry of record.openIntents(rec).filter((e) => e.action === 'reset')) {
    if (!rec.log.some((e) => e.marker === entry.marker && e.step === 'evidence')) {
      const head = await git.headSha(rec.worktree);
      if (head !== entry.payload.baseline || !await integrity.isCleanAt(rec.worktree, head)) return 'held';
      // git clean leaves ignored files, so the intent's saved Protected File bytes and ignored tests finish an interrupted rollback.
      if (entry.payload.untracked) await integrity.restoreUntracked(rec.worktree, entry.payload.untracked, PROTECTED_PATHS);
      if (entry.payload.remove) await integrity.removeIgnored(rec.worktree, entry.payload.remove);
      rec.history.push(entry.payload.history);
      await record.evidence(rec, entry.marker, { head });
    }
    await record.complete(rec, entry.marker);
  }
  return 'continue';
}
