import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as checks from '../../lib/checks.ts';
import { fakeGit } from '../support/fake-git.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/runner-output/${name}`, import.meta.url), 'utf8');

test('red check: a timed-out run is rejected even if it printed the test name', () => {
  const red = checks.redCheck({ code: null, timedOut: true, output: 'not ok - rejects bad input' }, [
    'rejects bad input',
  ]);
  assert.equal(red.ok, false);
  assert.match(red.reason ?? '', /timed out/i);
});

test('red check: runner-not-found is rejected', () => {
  const red = checks.redCheck(
    { code: 127, output: 'rejects bad input\n[gg: could not start command (win32 error 2)]\n' },
    ['rejects bad input'],
  );
  assert.equal(red.ok, false);
  assert.match(red.reason ?? '', /could not start|not found/i);
});

test('red check: nonzero exit without the reported test names is rejected', () => {
  const red = checks.redCheck({ code: 1, output: 'SyntaxError: unexpected token' }, ['rejects bad input']);
  assert.equal(red.ok, false);
  assert.match(red.reason ?? '', /rejects bad input/);
});

test('red check: nonzero exit naming a reported failing test is accepted', () => {
  assert.deepEqual(checks.redCheck({ code: 1, output: 'not ok 1 - rejects bad input' }, ['rejects bad input']), {
    ok: true,
  });
});

test('red check requires the named test to be failing where the runner reports per-test status', () => {
  const accepted = checks.redCheck({ code: 1, output: fixture('node-spec.txt') }, ['rejects bad input']);
  assert.equal(accepted.ok, true);
  assert.ok(!accepted.foundByNameOnly);
  // The name appears in the output, but the runner reports that test passing; only an unrelated test failed.
  const red = checks.redCheck({ code: 1, output: fixture('node-spec-counterexample.txt') }, ['rejects bad input']);
  assert.equal(red.ok, false);
  assert.match(red.reason ?? '', /rejects bad input/);
  assert.match(red.reason ?? '', /pass/i);
});

test('red check reads coloured node:test spec output', () => {
  // As printed by node --test with FORCE_COLOR=1.
  const output =
    '\x1b[32m✔ rejects bad input \x1b[90m(0.93ms)\x1b[39m\x1b[39m\n' +
    '\x1b[31m✖ old unrelated test \x1b[90m(1.55ms)\x1b[39m\x1b[39m\n';
  const red = checks.redCheck({ code: 1, output }, ['rejects bad input']);
  assert.equal(red.ok, false);
  assert.ok(!red.foundByNameOnly);
  assert.match(red.reason ?? '', /pass/i);
  assert.deepEqual(checks.redCheck({ code: 1, output }, ['old unrelated test']), { ok: true });
});

test('red check matches a full pytest identifier', () => {
  assert.deepEqual(
    checks.redCheck({ code: 1, output: fixture('pytest.txt') }, ['tests/test_parse.py::test_rejects_bad_input']),
    { ok: true },
  );
  assert.equal(
    checks.redCheck({ code: 1, output: fixture('pytest.txt') }, ['tests/test_parse.py::test_accepts_good_input']).ok,
    false,
  );
});

// tap-directives.txt is as printed by node --test --test-reporter=tap: only "old unrelated test" causes the nonzero
// exit.
test('red check rejects a test that TAP reports as TODO', () => {
  const red = checks.redCheck({ code: 1, output: fixture('tap-directives.txt') }, ['new test']);
  assert.equal(red.ok, false);
  assert.match(red.reason ?? '', /TODO or SKIP/);
});

test('red check rejects a test that TAP reports as SKIP', () => {
  const red = checks.redCheck({ code: 1, output: fixture('tap-directives.txt') }, ['skipped one']);
  assert.equal(red.ok, false);
  assert.match(red.reason ?? '', /TODO or SKIP/);
});

test('red check takes a lone TAP TODO line as per-test status, not grounds for the substring fallback', () => {
  const lone = checks.redCheck({ code: 1, output: 'not ok 1 - new test # TODO\n' }, ['new test']);
  assert.equal(lone.ok, false);
  assert.ok(!lone.foundByNameOnly);
});

test('red check decodes an escaped hash in a failing TAP test name', () => {
  assert.deepEqual(checks.redCheck({ code: 1, output: fixture('tap-directives.txt') }, ['rejects issue #123']), {
    ok: true,
  });
});

test('red check decodes an escaped backslash and hash in a passing TAP test name', () => {
  const passing = checks.redCheck({ code: 1, output: fixture('tap-directives.txt') }, [
    'passes with \\ backslash and # hash',
  ]);
  assert.equal(passing.ok, false);
  assert.match(passing.reason ?? '', /pass/i);
});

test('red check keeps a genuine TAP failure whatever order a same-named TODO or SKIP appears in', () => {
  const tap = (...lines: string[]) => lines.join('\n') + '\n';
  const failThenTodo = tap('not ok 1 - dup', 'not ok 2 - dup # TODO', 'ok 3 - dup # SKIP');
  const todoThenFail = tap('not ok 1 - dup # TODO', 'ok 2 - dup # SKIP', 'not ok 3 - dup');
  assert.deepEqual(checks.redCheck({ code: 1, output: failThenTodo }, ['dup']), { ok: true });
  assert.deepEqual(checks.redCheck({ code: 1, output: todoThenFail }, ['dup']), { ok: true });
  const onlyExcused = checks.redCheck({ code: 1, output: tap('not ok 1 - dup # TODO', 'ok 2 - dup # SKIP') }, ['dup']);
  assert.equal(onlyExcused.ok, false);
  assert.match(onlyExcused.reason ?? '', /TODO or SKIP/);
});

test('red check falls back to the substring rule and marks it found by name only', () => {
  const red = checks.redCheck({ code: 1, output: fixture('no-status.txt') }, ['rejects bad input']);
  assert.equal(red.ok, true);
  assert.equal(red.foundByNameOnly, true);
});

// Default jest output for several files: no ✓ or ✕ lines, one `● suite › test` heading per failure.
test('red check reads a jest failure heading by test name or suite path', () => {
  const output = fixture('jest-multi.txt');
  assert.deepEqual(checks.redCheck({ code: 1, output }, ['rejects bad input']), { ok: true });
  assert.deepEqual(checks.redCheck({ code: 1, output }, ['parse › rejects bad input']), { ok: true });
});

test('red check does not take a jest test named inside a failure message or console block as red evidence', () => {
  const passing = checks.redCheck({ code: 1, output: fixture('jest-multi.txt') }, ['removes item']);
  assert.equal(passing.ok, false);
  assert.ok(!passing.foundByNameOnly, 'headings are per-test status, so the substring rule does not apply');
});

test('red check reads a jest suite named Console and excludes only the bare Console heading', () => {
  const consoleSuite =
    '  ● Console › logs on failure\n\n    expect(received).toBe(true)\n\n  ● Console\n\n    console.log\n      hello\n';
  assert.deepEqual(checks.redCheck({ code: 1, output: consoleSuite }, ['logs on failure']), { ok: true });
  const quiet = checks.redCheck({ code: 1, output: consoleSuite }, ['hello']);
  assert.equal(quiet.ok, false);
  assert.ok(!quiet.foundByNameOnly);
});

const FAILURE_LINES = [
  ['tap.txt', 'rejects bad input', 'accepts good input'],
  ['jest.txt', 'rejects bad input', 'accepts good input'],
  ['pytest.txt', 'test_rejects_bad_input', 'test_accepts_good_input'],
];
for (const [file, failing, passing] of FAILURE_LINES) {
  test(`red check reads ${file} failure lines`, () => {
    assert.deepEqual(
      checks.redCheck({ code: 1, output: fixture(file) }, [failing]),
      { ok: true },
      `${file} is a recognised format`,
    );
    assert.equal(
      checks.redCheck({ code: 1, output: fixture(file) }, [passing]).ok,
      false,
      'a passing test is not red evidence',
    );
  });
}

test('red check reports a passing named test before an excused one', () => {
  const passed = {
    ok: false,
    failure: 'passed',
    reason: 'The runner reports a as passing, so it is not evidence of a failing test.',
  };
  assert.deepEqual(checks.redCheck({ code: 1, output: 'ok 1 - a\nnot ok 2 - b # TODO\n' }, ['a', 'b']), passed);
  // Whichever is named or printed first.
  assert.deepEqual(checks.redCheck({ code: 1, output: 'not ok 1 - b # TODO\nok 2 - a\n' }, ['b', 'a']), passed);
});

test('findings hash ignores whitespace, order and line numbers', () => {
  const findings = [
    { severity: 'major', file: 'lib/a.mjs', issue: 'Off by one at lib/a.mjs:12 in the loop', fix: 'x' },
    { severity: 'minor', file: 'lib/b.mjs', issue: 'Unused   variable on line 40', fix: 'y' },
    { severity: 'blocker', file: 'lib/c.mjs', issue: 'Throws at L7', fix: 'z' },
  ];
  const reordered = [
    { severity: 'blocker', file: 'lib/c.mjs', issue: '  Throws   at L99 ', fix: 'other' },
    { severity: 'major', file: 'lib/a.mjs', issue: 'Off by one at lib/a.mjs:345\n in the loop', fix: 'x' },
    { severity: 'minor', file: 'lib/b.mjs', issue: 'Unused variable on line 3', fix: 'y' },
  ];
  const hash = checks.findingsHash(findings);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(checks.findingsHash(reordered), hash);
});

test('findings hash changes with severity', () => {
  const findingsOf = (severity: string) => [{ severity, file: 'lib/a.mjs', issue: 'Off by one', fix: 'x' }];
  assert.notEqual(checks.findingsHash(findingsOf('major')), checks.findingsHash(findingsOf('minor')));
});

const review = {
  claim: 'ok',
  summary: '',
  definitionOfDoneMet: true,
  redGreenEvidenceOk: true,
  findings: [{ severity: 'minor', file: 'a', issue: 'nit', fix: '' }],
  diagnosis: '',
};

// The shipped review's review-pass Check (P5d).
const REVIEW_PASS = {
  allOf: [
    { field: 'definitionOfDoneMet', is: true },
    { field: 'redGreenEvidenceOk', is: true },
    { none: 'findings', where: { severity: ['blocker', 'major'] } },
  ],
};

test('review-pass passes a review with definitionOfDoneMet, redGreenEvidenceOk and only a minor finding', () => {
  assert.deepEqual(checks.responseCheck(review, REVIEW_PASS), { passed: true, reasons: [] });
});

const REVIEW_FAILS = [
  [
    'a major finding',
    { ...review, findings: [{ severity: 'major', file: 'a', issue: 'bug', fix: '' }] },
    'findings has 1 of 1 items where severity is blocker or major; expected none',
  ],
  [
    'a blocker finding',
    { ...review, findings: [{ severity: 'blocker', file: 'a', issue: 'bug', fix: '' }] },
    'findings has 1 of 1 items where severity is blocker or major; expected none',
  ],
  [
    'definitionOfDoneMet false',
    { ...review, definitionOfDoneMet: false },
    'definitionOfDoneMet is false, expected true',
  ],
  ['redGreenEvidenceOk false', { ...review, redGreenEvidenceOk: false }, 'redGreenEvidenceOk is false, expected true'],
];
for (const [name, response, reason] of REVIEW_FAILS) {
  test(`review-pass fails a review with ${name}`, () => {
    assert.deepEqual(checks.responseCheck(response, REVIEW_PASS), { passed: false, reasons: [reason] });
  });
}

test('green check reports a timeout as failed', async () => {
  const calls: [string, { cwd: string; timeoutMs: number }][] = [];
  const runShell = async (command: string, options: { cwd: string; timeoutMs: number }) => {
    calls.push([command, options]);
    return { code: null, timedOut: true, output: 'still running' };
  };
  const green = await checks.greenCheck('npm test', 'C:/repo', { runShell });
  assert.equal(green.timedOut, true);
  assert.equal(green.passed, false);
  assert.equal(green.code, null);
  assert.equal(green.output, 'still running');
  assert.equal(typeof green.durationMs, 'number');
  assert.deepEqual(calls, [['npm test', { cwd: 'C:/repo', timeoutMs: 30 * 60_000 }]]);
});

test('Check evidence keeps output under the bound whole, raw paths included', () => {
  const raw = `at run (${homedir()}\\test.mjs:3:4)\n`;
  assert.equal(checks.checkEvidence('npm test', { output: raw }).output, raw);
  const output = 'x'.repeat(5000) + '\nend';
  assert.deepEqual(checks.checkEvidence('npm test', { output }), { command: 'npm test', output });
});

// The bound is 65,536 characters: a 100-character first line fits beside the last one, a 101-character one does not.
const LAST = 'b'.repeat(65_435);
const BOUNDED = [
  ['keeps a first line that fits', 'a'.repeat(100) + '\n' + LAST, 'a'.repeat(100) + '\n' + LAST],
  ['drops a first line that does not fit', 'a'.repeat(101) + '\n' + LAST, LAST],
];
for (const [name, output, expected] of BOUNDED) {
  test(`Check evidence is bounded on a line boundary: it ${name}`, () => {
    assert.equal(checks.checkEvidence('npm test', { output }).output, expected);
  });
}

const EXACT = '/home/alice/private.txt' + ' '.repeat(65_520);
const OVERLONG = [
  ['a single overlong line', EXACT, `[${EXACT.length} characters of output omitted]`],
  ['an overlong line with a newline', 'x'.repeat(70_000) + '\n', '[70001 characters of output omitted]'],
  ['an overlong line between short ones', 'a\n' + 'x'.repeat(70_000) + '\nend', 'end'],
];
for (const [name, output, expected] of OVERLONG) {
  test(`Check evidence never keeps part of an overlong line: ${name}`, () => {
    assert.equal(checks.checkEvidence('npm test', { output }).output, expected);
  });
}

test('test immutability covers a declared test path outside the default globs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-checks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakeGit();
  const { mainRoot, base } = fake.init(root, { files: { 'spec/cart.mjs': 'a\n', 'lib/cart.mjs': 'x\n' } });
  writeFileSync(join(mainRoot, 'spec', 'cart.mjs'), 'a weakened\n');
  writeFileSync(join(mainRoot, 'lib', 'cart.mjs'), 'x changed\n');

  assert.deepEqual(await checks.testImmutability(mainRoot, base, { globs: ['spec/**'], git: fake.git }), {
    ok: false,
    changed: ['spec/cart.mjs'],
  });
  assert.deepEqual(await checks.testImmutability(mainRoot, base, { globs: checks.DEFAULT_TEST_GLOBS, git: fake.git }), {
    ok: true,
    changed: [],
  });
});

test('a test path glob ignores ASCII case only, as git icase pathspecs do', () => {
  const isTest = checks.testPathMatcher(['**/test/**', 'spec/É*']);
  assert.equal(isTest('lib/test/x.mjs'), true);
  assert.equal(isTest('lib/Test/x.mjs'), true);
  assert.equal(isTest('SPEC/É.mjs'), true);
  assert.equal(isTest('spec/é.mjs'), false);
});

test('a test path glob without a wildcard matches that path and what is under it, as a git pathspec does', () => {
  const isTest = checks.testPathMatcher(['spec', 'scripts/run-suite.mjs']);
  assert.equal(isTest('spec/unit/a.mjs'), true);
  assert.equal(isTest('scripts/run-suite.mjs'), true);
  assert.equal(isTest('specs/b.mjs'), false);
  assert.equal(isTest('scripts/run-suite.mjs.bak'), false);
});

test('a test path glob matches a path holding a newline, as git does', () => {
  assert.equal(checks.testPathMatcher(['spec/**'])('spec/a\nb.mjs'), true);
  assert.equal(checks.testPathMatcher(['**/*.test.*'])('x\ny/c.test.mjs'), true);
  assert.equal(checks.testPathMatcher(['**/f/**'])('d\ne/f/g.mjs'), true);
  assert.equal(checks.testPathMatcher(['spec'])('spec/a\nb.mjs'), true);
});

test('the fake git reads a ? in a glob as the test path matcher does, literally', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-checks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakeGit();
  const { mainRoot } = fake.init(root);
  writeFileSync(join(mainRoot, 'abc.mjs'), 'x\n');

  assert.equal(checks.testPathMatcher(['a?c.mjs'])('abc.mjs'), false);
  assert.deepEqual(await fake.git.untrackedPaths(mainRoot, { include: 'all', within: { globs: ['a?c.mjs'] } }), []);
});

test('a response Check with allOf names each failed condition', () => {
  const response = {
    definitionOfDoneMet: false,
    redGreenEvidenceOk: true,
    findings: [
      { severity: 'blocker', file: 'lib/a.mjs', issue: 'Throws', fix: '' },
      { severity: 'minor', file: 'lib/b.mjs', issue: 'Naming', fix: '' },
      { severity: 'major', file: 'lib/c.mjs', issue: 'Off by one', fix: '' },
    ],
  };
  const result = checks.responseCheck(response, {
    allOf: [
      { field: 'definitionOfDoneMet', is: true },
      { field: 'redGreenEvidenceOk', is: true },
      { none: 'findings', where: { severity: ['blocker', 'major'] } },
    ],
  });
  assert.deepEqual(result, {
    passed: false,
    reasons: [
      'definitionOfDoneMet is false, expected true',
      'findings has 2 of 3 items where severity is blocker or major; expected none',
    ],
  });
});

test('a response condition without where names its list alone', () => {
  const result = checks.responseCheck({ findings: [] }, { any: 'findings' });
  assert.deepEqual(result, { passed: false, reasons: ['findings has 0 of 0 items; expected at least one'] });
});

test('a count condition without a comparison fails, naming it', () => {
  const result = checks.responseCheck({ findings: [] }, { count: 'findings', where: {} });
  assert.deepEqual(result, { passed: false, reasons: ['the count of findings names no comparison'] });
});

test('an all condition fails when only some items match where', () => {
  const findings = [
    { severity: 'major', file: 'b', issue: 'bug', fix: '' },
    { severity: 'minor', file: 'a', issue: 'nit', fix: '' },
  ];
  const result = checks.responseCheck({ findings }, { all: 'findings', where: { severity: 'minor' } });
  assert.deepEqual(result, {
    passed: false,
    reasons: ['findings has 1 of 2 items where severity is minor; expected all'],
  });
});
