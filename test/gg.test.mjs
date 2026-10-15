import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/gg.mjs', import.meta.url));
const commands = ['init', 'doctor', 'plan', 'publish', 'run', 'work', 'trace', 'stats'];

function gg(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

function assertUsage(text) {
  for (const name of commands) assert.match(text, new RegExp(`\\b${name}\\b`), `usage lists ${name}`);
  for (const verb of ['list', 'resume', 'abandon', 'reset', 'approve']) assert.match(text, new RegExp(`\\b${verb}\\b`), `usage lists work ${verb}`);
}

test('gg with no arguments prints usage and exits 0', () => {
  const r = gg();
  assert.equal(r.status, 0, r.stderr);
  assertUsage(r.stdout);
});

test('gg --help prints usage and exits 0', () => {
  const r = gg('--help');
  assert.equal(r.status, 0, r.stderr);
  assertUsage(r.stdout);
  assert.equal(r.stdout, gg().stdout);
});

test('gg with an unknown command prints usage to stderr and exits 1', () => {
  const r = gg('bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gg: unknown command bogus/);
  assertUsage(r.stderr);
});

test('every listed command exits 1 with a not-implemented message', () => {
  for (const name of commands) {
    const r = gg(name, '1');
    assert.equal(r.status, 1, `${name} exit code`);
    assert.equal(r.stderr.trim(), `gg ${name}: not implemented`);
  }
  const r = gg('work', 'list');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'gg work: not implemented');
});
