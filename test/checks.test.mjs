import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as checks from '../lib/checks.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/runner-output/${name}`, import.meta.url), 'utf8');

test('red check: a timed-out run is rejected even if it printed the test name', () => {
  const r = checks.redCheck({ code: null, timedOut: true, output: 'not ok - rejects bad input' }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/i);
});

test('red check: runner-not-found is rejected', () => {
  const r = checks.redCheck({ code: 127, output: 'rejects bad input\n[ff: could not start command (win32 error 2)]\n' }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not start|not found/i);
});

test('red check: nonzero exit without the reported test names is rejected', () => {
  const r = checks.redCheck({ code: 1, output: 'SyntaxError: unexpected token' }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /rejects bad input/);
});

test('red check: nonzero exit naming a reported failing test is accepted', () => {
  assert.deepEqual(checks.redCheck({ code: 1, output: 'not ok 1 - rejects bad input' }, ['rejects bad input']), { ok: true });
});

test('red check requires the named test to be failing where the runner reports per-test status', () => {
  const accepted = checks.redCheck({ code: 1, output: fixture('node-spec.txt') }, ['rejects bad input']);
  assert.equal(accepted.ok, true);
  assert.ok(!accepted.heuristic);
  // The name appears in the output, but the runner reports that test passing; only an unrelated test failed.
  const r = checks.redCheck({ code: 1, output: fixture('node-spec-counterexample.txt') }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /rejects bad input/);
  assert.match(r.reason, /pass/i);
});

test('red check reads coloured node:test spec output', () => {
  // As printed by node --test with FORCE_COLOR=1.
  const output = '\x1b[32m✔ rejects bad input \x1b[90m(0.93ms)\x1b[39m\x1b[39m\n\x1b[31m✖ old unrelated test \x1b[90m(1.55ms)\x1b[39m\x1b[39m\n';
  const r = checks.redCheck({ code: 1, output }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.ok(!r.heuristic);
  assert.match(r.reason, /pass/i);
  assert.deepEqual(checks.redCheck({ code: 1, output }, ['old unrelated test']), { ok: true });
});

test('red check matches a full pytest identifier', () => {
  assert.deepEqual(checks.redCheck({ code: 1, output: fixture('pytest.txt') }, ['tests/test_parse.py::test_rejects_bad_input']), { ok: true });
  assert.equal(checks.redCheck({ code: 1, output: fixture('pytest.txt') }, ['tests/test_parse.py::test_accepts_good_input']).ok, false);
});

test('red check falls back to the substring rule and marks it heuristic', () => {
  const r = checks.redCheck({ code: 1, output: fixture('no-status.txt') }, ['rejects bad input']);
  assert.equal(r.ok, true);
  assert.equal(r.heuristic, true);
});

test('red check reads TAP, jest and pytest failure lines', () => {
  for (const [file, failing, passing] of [
    ['tap.txt', 'rejects bad input', 'accepts good input'],
    ['jest.txt', 'rejects bad input', 'accepts good input'],
    ['pytest.txt', 'test_rejects_bad_input', 'test_accepts_good_input'],
  ]) {
    const ok = checks.redCheck({ code: 1, output: fixture(file) }, [failing]);
    assert.equal(ok.ok, true, `${file}: ${ok.reason}`);
    assert.ok(!ok.heuristic, `${file} is a recognised format`);
    const bad = checks.redCheck({ code: 1, output: fixture(file) }, [passing]);
    assert.equal(bad.ok, false, `${file}: a passing test is not red evidence`);
  }
});

test('test immutability lists added, renamed and modified test paths and ignores lib', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-checks-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  mkdirSync(join(dir, 'test')); mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'test', 'a.test.mjs'), 'a');
  writeFileSync(join(dir, 'test', 'old.test.mjs'), 'old');
  writeFileSync(join(dir, 'lib', 'x.mjs'), 'x');
  g('add', '-A'); g('commit', '-q', '-m', 'baseline');
  const baseline = g('rev-parse', 'HEAD');
  assert.deepEqual(await checks.testImmutability(dir, baseline), { ok: true, changed: [] });

  writeFileSync(join(dir, 'test', 'a.test.mjs'), 'a changed');
  g('commit', '-q', '-am', 'edit a test after the baseline');
  g('mv', 'test/old.test.mjs', 'test/renamed.test.mjs');
  writeFileSync(join(dir, 'test', 'new.test.mjs'), 'new');
  writeFileSync(join(dir, 'lib', 'x.mjs'), 'x changed');

  const r = await checks.testImmutability(dir, baseline);
  assert.equal(r.ok, false);
  for (const p of ['test/a.test.mjs', 'test/renamed.test.mjs', 'test/new.test.mjs']) assert.ok(r.changed.includes(p), `${p} in ${r.changed}`);
  assert.ok(!r.changed.some((p) => p.startsWith('lib/')), `lib ignored: ${r.changed}`);
});

test('test immutability sees non-ASCII and git-ignored test paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-checks-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test', 'café.mjs'), 'a');
  writeFileSync(join(dir, '.gitignore'), 'test/ignored.mjs\n');
  g('add', '-A'); g('commit', '-q', '-m', 'baseline');
  const baseline = g('rev-parse', 'HEAD');

  writeFileSync(join(dir, 'test', 'café.mjs'), 'a changed');
  writeFileSync(join(dir, 'test', 'naïve.mjs'), 'new');
  writeFileSync(join(dir, 'test', 'ignored.mjs'), 'new');

  const r = await checks.testImmutability(dir, baseline);
  assert.deepEqual(r, { ok: false, changed: ['test/café.mjs', 'test/ignored.mjs', 'test/naïve.mjs'] });
});

test('test immutability sees a test added under an ignored directory but not installed dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-checks-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  writeFileSync(join(dir, '.gitignore'), 'generated/\nnode_modules/\n');
  g('add', '-A'); g('commit', '-q', '-m', 'baseline');
  const baseline = g('rev-parse', 'HEAD');

  mkdirSync(join(dir, 'generated'));
  writeFileSync(join(dir, 'generated', 'new.test.mjs'), 'new');
  mkdirSync(join(dir, 'node_modules', 'dep', 'test'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'test', 'index.js'), 'dep');

  const r = await checks.testImmutability(dir, baseline);
  assert.deepEqual(r, { ok: false, changed: ['generated/new.test.mjs'] });
});

test('findings hash ignores whitespace, order and line numbers', () => {
  const a = [
    { severity: 'major', file: 'lib/a.mjs', issue: 'Off by one at lib/a.mjs:12 in the loop', fix: 'x' },
    { severity: 'minor', file: 'lib/b.mjs', issue: 'Unused   variable on line 40', fix: 'y' },
    { severity: 'blocker', file: 'lib/c.mjs', issue: 'Throws at L7', fix: 'z' },
  ];
  const b = [
    { severity: 'blocker', file: 'lib/c.mjs', issue: '  Throws   at L99 ', fix: 'other' },
    { severity: 'major', file: 'lib/a.mjs', issue: 'Off by one at lib/a.mjs:345\n in the loop', fix: 'x' },
    { severity: 'minor', file: 'lib/b.mjs', issue: 'Unused variable on line 3', fix: 'y' },
  ];
  const h = checks.findingsHash(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(checks.findingsHash(b), h);
});

test('findings hash changes with severity', () => {
  const f = (severity) => [{ severity, file: 'lib/a.mjs', issue: 'Off by one', fix: 'x' }];
  assert.notEqual(checks.findingsHash(f('major')), checks.findingsHash(f('minor')));
});

test('review-pass needs dodMet, tddEvidenceOk and no blocker or major finding', () => {
  const ok = { claim: 'ok', summary: '', dodMet: true, tddEvidenceOk: true, findings: [{ severity: 'minor', file: 'a', issue: 'nit', fix: '' }], diagnosis: '' };
  assert.deepEqual(checks.reviewPass(ok), { passed: true, reasons: [] });
  const fails = [
    { ...ok, findings: [{ severity: 'major', file: 'a', issue: 'bug', fix: '' }] },
    { ...ok, findings: [{ severity: 'blocker', file: 'a', issue: 'bug', fix: '' }] },
    { ...ok, dodMet: false },
    { ...ok, tddEvidenceOk: false },
  ];
  for (const response of fails) {
    const r = checks.reviewPass(response);
    assert.equal(r.passed, false);
    assert.ok(r.reasons.length > 0 && r.reasons.every((s) => typeof s === 'string' && s), JSON.stringify(r));
  }
});

test('green check reports a timeout as failed', async () => {
  const calls = [];
  const runShell = async (command, opts) => { calls.push([command, opts]); return { code: null, timedOut: true, output: 'still running' }; };
  const r = await checks.greenCheck('npm test', 'C:/repo', { runShell });
  assert.equal(r.timedOut, true);
  assert.equal(r.passed, false);
  assert.equal(r.code, null);
  assert.equal(r.output, 'still running');
  assert.equal(typeof r.durationMs, 'number');
  assert.deepEqual(calls, [['npm test', { cwd: 'C:/repo', timeoutMs: 30 * 60_000 }]]);
  assert.deepEqual(checks.evidence('npm test', { output: 'x'.repeat(5000) + 'end' }), { command: 'npm test', output: ('x'.repeat(5000) + 'end').slice(-3000) });
});
