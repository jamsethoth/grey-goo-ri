import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// With no PATH, a recorder whose --help check broke cannot reach the real codex or claude.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));

// Each recorder's --help prints its usage alone and exits 2, before any CLI is called (#479, D14 A).
for (const recorder of ['record-codex', 'record-claude']) {
  test(`${recorder} --help prints the usage alone`, () => {
    const script = fileURLToPath(new URL(`../../scripts/${recorder}.ts`, import.meta.url));
    const result = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
      env: environment,
      timeout: 60_000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`^usage: node scripts/${recorder}\\.ts`));
  });
}
