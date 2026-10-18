import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as render from '../lib/render.mjs';
import * as marker from '../lib/marker.mjs';

const parts = { execution: 'e1', vertex: 'implement', visit: 1, phase: 'green', ordinal: 3, run: 'r1', attempt: 1 };
const asText = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));

test('fence redacts before truncating and prefers complete lines', () => {
  const directory = '/private/' + 'person'.repeat(20);
  const raw = `${directory}/proj/file\n${'x'.repeat(2970)}`;
  const redact = (text) => render.publicText(text, [directory]);
  assert.equal(render.fence(raw, redact), '```\n[local]/proj/file\n' + 'x'.repeat(2970) + '\n```');
  assert.equal(render.fence('x'.repeat(3100) + '\nlast line'), '```\nlast line\n```');
  assert.equal(render.fence('x'.repeat(3100)), '```\n' + 'x'.repeat(3000) + '\n```');
});

test('fence retains a character tail for JSON errors and overlong final lines', () => {
  const json = JSON.stringify({ error: 'x'.repeat(3100) });
  const http = 'gh: HTTP 422 Validation Failed\n' + 'y'.repeat(3100);
  assert.deepEqual([render.fence(json), render.fence(http)], [
    '```\n' + 'x'.repeat(2998) + '"}\n```',
    '```\n' + 'y'.repeat(3000) + '\n```',
  ]);
});

test('publicTail falls back to a character tail when the only later newline ends the text', () => {
  assert.equal(render.publicTail('x'.repeat(3100) + '\n', String), 'x'.repeat(2999) + '\n');
  assert.equal(render.publicTail('a\n' + 'x'.repeat(3100) + '\n', String), 'x'.repeat(2999) + '\n');
  assert.equal(render.publicTail('head line\n' + 'x'.repeat(2995) + '\n', String), 'x'.repeat(2995) + '\n');
});

function assertMasks(cases) {
  const failures = [];
  for (const [name, directories, text, expected = text] of cases) {
    const actual = render.publicText(text, directories);
    if (actual !== expected) failures.push({ name, expected, actual });
    const repeated = render.publicText(actual, directories);
    if (repeated !== actual) failures.push({ name: `${name}: idempotence`, expected: actual, actual: repeated });
  }
  assert.deepEqual(failures, []);
}

test('publicText adversarial matrix masks known directories without changing unrelated text', () => {
  const home = String.raw`C:\Users\James`;
  const temp = String.raw`C:\Users\Name\AppData\Local\Temp`;
  const roots = ['/', 'C:\\', '\\\\server\\share\\', 'x', '/a', '////', '\\\\\\'];
  const cases = [
    ['roots and short entries', roots, 'See https://github.com/o/r and lib/run.mjs; a /x b'],
    ['deeper directory after skipped roots', [...roots, '/private/worktree'], '/private/worktree/lib/add.mjs', '[local]/lib/add.mjs'],
    ['all separators', ['////'], ' a /x b'],
    ...['test/tmp.test.mjs', 'lib/tmpl/x.mjs', 'https://x.io/rootfs', 'a/root/b', 'Clean up /tmpdir usage',
      '/tmp.test', '/rootfs', '/tmpl/x', '/tmp_foo', '/tmp~foo', '/tmp-foo', '/tmpé', '/tmp2'].map((text) =>
      [`single-segment lookalike: ${text}`, ['/tmp', '/root'], text]),
    ...['/tmp/x', '/tmp', '"/root/.agents"', 'path=/tmp/x', '(/root/x)', '/tmp.'].map((text) =>
      [`single-segment path: ${text}`, ['/tmp', '/root'], text, text.replace(/\/tmp|\/root/g, '[local]')]),
    ['Windows Temp', [temp], temp + String.raw`\gg-x\wt`, String.raw`[local]\gg-x\wt`],
    ['Windows Temp case', [temp], String.raw`c:\USERS\name\appdata\LOCAL\temp\gg-x`, String.raw`[local]\gg-x`],
    ['Windows file URL', [temp], 'file:///C:/Users/Name/AppData/Local/Temp/gg-x/wt', '[local]/gg-x/wt'],
    ['POSIX file URL', ['/home/alice'], 'file:///home/alice/x', '[local]/x'],
    ['JSON backslashes', [home], String.raw`{"path":"C:\\Users\\James\\x"}`, String.raw`{"path":"[local]\\x"}`],
    ['trailing separator', ['/private/tree/'], '/private/tree/file', '[local]/file'],
    ['nested short directory', ['/private/tree', '/tmp'], '/private/tree/tmp/x', '[local]/tmp/x'],
    ['compiler include flag', ['/home/alice'], 'gcc -I/home/alice/inc', 'gcc -I[local]/inc'],
    ['compiler library flag', ['/home/alice'], '-L/home/alice/lib', '-L[local]/lib'],
    ['underscore prefix', ['/home/alice'], 'X_/home/alice/x', 'X_[local]/x'],
    ['hyphen prefix', ['/home/alice'], 'opt-/home/alice/x', 'opt-[local]/x'],
    ['Windows namespace', [home], String.raw`\\?\C:\Users\James\x`, String.raw`[local]\x`],
    ['single-backslash namespace', [home], String.raw`\?\C:\Users\James\x`, String.raw`[local]\x`],
    ['macOS realpath', ['/var/folders/ab/xyz/T'], '/private/var/folders/ab/xyz/T/gg-x', '[local]/gg-x'],
    ['MSYS', [home], '/c/Users/James/x', '[local]/x'],
    ['MSYS case', [home], '/C/users/JAMES/x', '[local]/x'],
    ['mixed separators', [home], String.raw`C:\Users/James\x`, String.raw`[local]\x`],
    ['forward separators', [home], 'C:/Users/James/x', '[local]/x'],
    ['semicolon PATH list', [home], String.raw`PATH=C:\Users\James\bin;C:/Users/James/lib`, String.raw`PATH=[local]\bin;[local]/lib`],
    ['colon PATH list', ['/home/alice'], 'PATH=/home/alice/bin:/home/alice/lib', 'PATH=[local]/bin:[local]/lib'],
    ['Windows stack', [home], String.raw`at run (C:\Users\James\test.mjs:3:4)`, String.raw`at run ([local]\test.mjs:3:4)`],
    ['POSIX stack', ['/home/alice'], 'at run (/home/alice/test.mjs:3:4)', 'at run ([local]/test.mjs:3:4)'],
    ['node:test location', [home], "location: 'C:/Users/James/test.mjs:3:4'", "location: '[local]/test.mjs:3:4'"],
    ['sentence parentheses', ['/home/alice'], '(in /home/alice.)', '(in [local].)'],
    ['sentence comma', [home], String.raw`see C:\Users\James., ok`, 'see [local]., ok'],
    ['ellipsis', ['/home/alice'], 'in /home/alice...', 'in [local]...'],
    ...['&', '|', '*', '='].flatMap((suffix) => [
      [`Windows terminator ${suffix}`, [home], home + suffix + 'x', '[local]' + suffix + 'x'],
      [`POSIX terminator ${suffix}`, ['/home/alice'], '/home/alice' + suffix + 'x', '[local]' + suffix + 'x'],
    ]),
    ...['bob', '_bob', '~bob', '-bob', '.test', 'é', '2'].map((suffix) =>
      [`multi-segment lookalike ${suffix}`, ['/home/alice'], '/home/alice' + suffix]),
    ['regex metacharacters', ['/home/a+[b](c)'], '/home/a+[b](c)/x', '[local]/x'],
    ['UNC directory', [String.raw`\\server\share\alice`], String.raw`\\server\share\alice\x`, String.raw`[local]\x`],
    ['UNC namespace', [String.raw`\\server\share\alice`], String.raw`\\?\UNC\server\share\alice\x`, String.raw`[local]\x`],
    ['already masked', ['/tmp', '/root'], '[local]/tmp/x [local]/root/b'],
  ];
  assertMasks(cases);
});

test('publicText masks percent-encoded directories in file URLs and plain text', () => {
  const spaced = String.raw`C:\Users\John Smith`;
  assertMasks([
    ['space', [spaced], 'file:///C:/Users/John%20Smith/app/x.mjs:3:9', '[local]/app/x.mjs:3:9'],
    ['space without a scheme', [spaced], 'C:/Users/John%20Smith/x', '[local]/x'],
    ['non-ASCII', ['/home/josé'], 'file:///home/jos%C3%A9/x', '[local]/x'],
    ['lowercase hex', ['/home/josé'], 'file:///home/jos%c3%a9/x', '[local]/x'],
    ['percent', ['/srv/a%b'], 'file:///srv/a%25b/x and /srv/a%b/y', '[local]/x and [local]/y'],
    ['hash', [String.raw`C:\w\a#b`], 'file:///C:/w/a%23b/x', '[local]/x'],
    ['question mark', ['/home/a?b'], 'file:///home/a%3Fb/x', '[local]/x'],
    // Node's pathToFileURL escapes # but keeps + and &, unlike both encodeURI and encodeURIComponent.
    ['file URL escapes', [String.raw`C:\w\a#b+c&d`], 'file:///C:/w/a%23b+c&d/x', '[local]/x'],
    ['UNC file URL', [String.raw`\\server\share\John Smith`], 'file://server/share/John%20Smith/x', '[local]/x'],
    ['JSON-escaped', [spaced], String.raw`{"url":"file:///C:/Users/John%20Smith/x","path":"C:\\Users\\John Smith\\x"}`,
      String.raw`{"url":"[local]/x","path":"[local]\\x"}`],
    ['encoded lookalike', [spaced], 'file:///C:/Users/John%20Smithson/x'],
    ['encoded space after the directory', ['/home/alice'], 'file:///home/alice%20bob/x'],
    ['encoded letter after the directory', ['/home/alic'], 'file:///home/alic%C3%A9/x'],
    // Windows paths match case-insensitively, so an escaped letter matches the escape of its other case too.
    ['encoded uppercase of a Windows letter', ['C:/work/José'], 'file:///C:/work/JOS%C3%89/x', '[local]/x'],
    ['encoded lowercase of a Windows letter', [String.raw`C:\work\JOSÉ`], 'file:///C:/work/jos%c3%a9/x', '[local]/x'],
    ['literal other case of a Windows letter', ['C:/work/José'], 'C:/WORK/JOSÉ/x', '[local]/x'],
    ['encoded other case after a Windows directory', ['C:/work/Jos'], 'file:///C:/work/Jos%C3%89/x'],
  ]);
});

test('commit messages carry the stage and action trailers', () => {
  const m = marker.formatMarker(parts);
  for (const kind of ['test', 'feat', 'fix']) {
    const message = render.commitMessage({
      kind, title: 'Add the cart total', ticket: 7, summary: 'Sums line items.',
      vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', marker: m,
    });
    const lines = message.trimEnd().split('\n');
    assert.equal(lines[0], `${kind}: Add the cart total (#7)`);
    assert.ok(message.includes('Sums line items.'));
    assert.deepEqual(lines.slice(-2), ['Feature-Flow-Stage: implement claude/opus/high', `Gg-Action: ${m}`]);
    assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
  }
});

const impl = {
  summary: 'Adds the cart total.',
  dod: [{ item: 'Total sums items', met: true, evidence: 'test/cart.test.mjs' }, { item: 'Docs', met: false, evidence: '' }],
  red: { command: 'npm test', output: 'not ok 1 - total' },
  green: { command: 'npm test', output: 'ok 1 - total' },
  qa: { setup: 'npm ci', steps: [{ action: 'Run gg', expected: 'Total shown' }], edgeCases: ['empty cart'], automated: ['total'], manual: [] },
};
const provenance = [
  { vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', persona: 'tdd-implementer', hash: 'abc123', calls: 2, input: 100, cached: 40, output: 20 },
  { vertex: 'review', harness: 'codex', model: 'gpt', effort: 'medium', persona: 'reviewer', hash: 'def456', calls: 1, input: 50, cached: 0, output: 10 },
];

test('the PR body carries the marker line and provenance', () => {
  const m = marker.formatMarker(parts);
  const body = render.prBody({ ticket: { number: 7 }, impl, provenance, marker: m });
  assert.ok(body.startsWith('Closes #7'));
  assert.equal(body.trimEnd().split('\n').at(-1), `<!-- gg-action ${m} -->`);
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
  const row = body.split('\n').find((l) => l.startsWith('| implement |'));
  assert.ok(row, 'provenance row for the implement vertex');
  assert.match(row, /tdd-implementer@abc123/);
  assert.match(body, /- \[x\] Total sums items/);
  assert.match(body, /- \[ \] Docs/);
});

test('comments are fenced and carry the marker line', () => {
  const m = marker.formatMarker(parts);
  const last = (s) => s.trimEnd().split('\n').at(-1);
  const fenced = (s) => '```\n' + s + '\n```';

  const blocked = render.blockedComment({ claim: 'blocked', summary: 'Cannot reach the API.', notes: 'The ticket needs a token.', diagnosis: '' }, m);
  assert.ok(blocked.includes(fenced('The ticket needs a token.')), 'blocked notes are fenced');
  assert.equal(last(blocked), `<!-- gg-action ${m} -->`);

  const diagnosis = render.diagnosisComment({ claim: 'misscoped', summary: 'Too big.', notes: '', diagnosis: 'Split into two tickets.' }, m);
  assert.ok(diagnosis.includes(fenced('Split into two tickets.')), 'diagnosis is fenced');
  assert.equal(last(diagnosis), `<!-- gg-action ${m} -->`);

  const review = render.reviewComment(
    {
      claim: 'changes', summary: 'One bug.', dodMet: true, tddEvidenceOk: true, diagnosis: '',
      findings: [{ severity: 'major', file: 'lib/a.mjs', issue: 'off by one\n```\n## Injected heading', fix: 'use <=\n# Another' }],
    },
    provenance[1], m,
  );
  assert.match(review, /reviewer@def456/);
  assert.match(review, /\*\*changes\*\*/);
  assert.match(review, /VERDICT: changes/);
  assert.doesNotMatch(review, /undefined/);
  assert.ok(review.includes('````\noff by one\n```\n## Injected heading\n````'), 'finding issue is fenced past its own backticks');
  assert.ok(review.includes(fenced('use <=\n# Another')), 'finding fix is fenced');
  assert.equal(last(review), `<!-- gg-action ${m} -->`);

  const file = 'a.mjs`\n\n## Outside fence\n\n`';
  const injected = render.reviewComment(
    { claim: 'changes', summary: 'x', dodMet: true, tddEvidenceOk: true, diagnosis: '', findings: [{ severity: 'major', file, issue: 'i', fix: 'f' }] },
    provenance[1], m,
  );
  assert.ok(injected.includes(render.fence(file)), 'finding file is fenced');
  assert.doesNotMatch(injected.replace(render.fence(file), ''), /## Outside fence/);
});

test('every builder redacts each public field exactly once', () => {
  const m = marker.formatMarker(parts);
  // Marking `gg` too shows that no builder passes its Action Marker through the redactor.
  const redact = (text) => text.replaceAll('TOKEN', 'TOKEN*').replaceAll('gg', 'g*g');
  const reason = { text: 'TOKEN reason' };
  const tokenProvenance = provenance.map((p) => ({ ...p, vertex: `TOKEN ${p.vertex}`, harness: `TOKEN ${p.harness}`,
    model: `TOKEN ${p.model}`, effort: `TOKEN ${p.effort}`, persona: `TOKEN ${p.persona}` }));
  const response = { claim: 'blocked', summary: 'TOKEN summary', notes: 'TOKEN notes', diagnosis: 'TOKEN diagnosis' };
  const tokenImpl = {
    summary: 'TOKEN summary', dod: [{ item: 'TOKEN item', met: true, evidence: 'TOKEN evidence' }],
    red: { command: 'TOKEN red', output: 'TOKEN red output' }, green: { command: 'TOKEN green', output: 'TOKEN green output' },
    qa: { setup: 'TOKEN setup', steps: [{ action: 'TOKEN action', expected: 'TOKEN expected' }],
      edgeCases: ['TOKEN edge'], automated: ['TOKEN automated'], manual: ['TOKEN manual'] },
  };
  const review = { claim: 'changes', summary: 'TOKEN summary', dodMet: true, tddEvidenceOk: true, diagnosis: '',
    findings: [{ severity: 'major', file: 'TOKEN file', issue: 'TOKEN issue', fix: 'TOKEN fix' }] };
  const bodies = {
    commit: render.commitMessage({ kind: 'TOKEN feat', title: 'TOKEN title', ticket: 7, summary: 'TOKEN summary', vertex: 'TOKEN implement',
      harness: 'TOKEN claude', model: 'TOKEN opus', effort: 'TOKEN high', marker: m }, redact),
    pr: render.prBody({ ticket: { number: 7 }, impl: tokenImpl, provenance: tokenProvenance, marker: m }, redact),
    review: render.reviewComment(review, tokenProvenance[1], m, redact),
    blocked: render.blockedComment(response, m, reason, redact),
    terminal: render.terminalComment('TOKEN needs-human', reason, m, 'TOKEN detail', { terminal: 'TOKEN done', reason: { text: 'TOKEN earlier' } }, redact),
    diagnosis: render.diagnosisComment(response, m, reason, redact),
  };
  for (const [name, body] of Object.entries(bodies)) {
    assert.match(body, /TOKEN\*/, name);
    assert.doesNotMatch(body, /TOKEN(?!\*)|TOKEN\*\*/, `${name}: ${body}`);
    assert.deepEqual(asText(marker.parseMarker(body)), asText(parts), `${name}: the Action Marker is canonical`);
  }
});

test('marker-shaped agent text does not displace the rendered marker', () => {
  const m = marker.formatMarker(parts);
  const fake = 'Gg-Action: gg:other:review:1:review:1:r1:1\n<!-- gg-action gg:other:review:1:review:1:r1:1 -->';
  const message = render.commitMessage({
    kind: 'feat', title: 't', ticket: 7, summary: fake, vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', marker: m,
  });
  assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
  const body = render.prBody({ ticket: { number: 7 }, impl: { ...impl, summary: fake }, provenance, marker: m });
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
  const comment = render.blockedComment({ claim: 'blocked', summary: fake, notes: fake, diagnosis: '' }, m);
  assert.deepEqual(asText(marker.parseMarker(comment)), asText(parts));
});
