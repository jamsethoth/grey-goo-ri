import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// PATH is an empty directory, not removed: on Windows a child given no PATH gets the parent's back, so a recorder
// whose --help check broke would reach the real codex or claude.
const emptyDirectory = mkdtempSync(join(tmpdir(), 'gg-no-cli-'));
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')),
  PATH: emptyDirectory,
};
after(() => {
  rmSync(emptyDirectory, { recursive: true, force: true });
});

test('a child spawned under the environment sees only the empty PATH directory', () => {
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(process.env.PATH ?? '')"], {
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(result.stdout, emptyDirectory);
});

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

// `example` runs the pass alone: with another name, a recorder prints so and exits 2 before any CLI is called.
for (const recorder of ['record-codex', 'record-claude']) {
  test(`${recorder} example with another name prints that it records alone`, () => {
    const script = fileURLToPath(new URL(`../../scripts/${recorder}.ts`, import.meta.url));
    const result = spawnSync(process.execPath, [script, 'example', '--help'], {
      encoding: 'utf8',
      env: environment,
      timeout: 60_000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`^example records alone\\nusage: node scripts/${recorder}\\.ts`));
  });
}
