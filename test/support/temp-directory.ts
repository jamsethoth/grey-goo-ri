import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from '../../lib/sqlite.ts';

// A temp directory removed when the case ends. The State Database at `commonDirOf(directory)` is closed first, since
// Windows will not remove an open database file. GG_KEEP_TEMP keeps the directory and names it, for debugging a case.
export function tempDirectory(t: TestContext, prefix: string, commonDirOf = (directory: string) => directory): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  if (process.env.GG_KEEP_TEMP) {
    t.diagnostic(`kept temp directory: ${directory}`);
    return directory;
  }
  t.after(() => {
    sqlite.close(commonDirOf(directory));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
