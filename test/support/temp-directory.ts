import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stateDatabase from '../../lib/state-database.ts';

// A temp directory removed when the case ends. The State Database at `commonDirOf(directory)` is closed first, since
// Windows will not remove an open database file. GG_KEEP_TEMP keeps the directory and names it, for debugging a case.
export function tempDirectory(t: TestContext, prefix: string, commonDirOf = (directory: string) => directory): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  if (process.env.GG_KEEP_TEMP) {
    t.diagnostic(`kept temp directory: ${directory}`);
    return directory;
  }
  t.after(() => {
    stateDatabase.close(commonDirOf(directory));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

// A temp directory holding a State Database, as gg init leaves a repository's common dir.
export function stateDatabaseDirectory(t: TestContext, prefix: string): string {
  const directory = tempDirectory(t, prefix);
  stateDatabase.create(directory);
  return directory;
}
