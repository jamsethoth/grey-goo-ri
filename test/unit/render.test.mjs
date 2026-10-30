import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as render from '../../lib/render.mjs';
import * as marker from '../../lib/marker.mjs';

const parts = { execution: 'e1', vertex: 'implement', visit: 1, action: 'commit', recovery: 0, run: 'r1', attempt: 1 };
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

// [name, known directories, text, the text published]
const MASKS = [
  ['roots and short entries', ['/', 'C:\\', '\\\\server\\share\\', 'x', '/a', '////', '\\\\\\'], 'See https://github.com/o/r and lib/run.mjs; a /x b', 'See https://github.com/o/r and lib/run.mjs; a /x b'],
  ['deeper directory after skipped roots', ['/', 'C:\\', '\\\\server\\share\\', 'x', '/a', '////', '\\\\\\', '/private/worktree'], '/private/worktree/lib/add.mjs', '[local]/lib/add.mjs'],
  ['all separators', ['////'], ' a /x b', ' a /x b'],
  ['single-segment lookalike: test/tmp.test.mjs', ['/tmp', '/root'], 'test/tmp.test.mjs', 'test/tmp.test.mjs'],
  ['single-segment lookalike: lib/tmpl/x.mjs', ['/tmp', '/root'], 'lib/tmpl/x.mjs', 'lib/tmpl/x.mjs'],
  ['single-segment lookalike: https://x.io/rootfs', ['/tmp', '/root'], 'https://x.io/rootfs', 'https://x.io/rootfs'],
  ['single-segment lookalike: a/root/b', ['/tmp', '/root'], 'a/root/b', 'a/root/b'],
  ['single-segment lookalike: Clean up /tmpdir usage', ['/tmp', '/root'], 'Clean up /tmpdir usage', 'Clean up /tmpdir usage'],
  ['single-segment lookalike: /tmp.test', ['/tmp', '/root'], '/tmp.test', '/tmp.test'],
  ['single-segment lookalike: /rootfs', ['/tmp', '/root'], '/rootfs', '/rootfs'],
  ['single-segment lookalike: /tmpl/x', ['/tmp', '/root'], '/tmpl/x', '/tmpl/x'],
  ['single-segment lookalike: /tmp_foo', ['/tmp', '/root'], '/tmp_foo', '/tmp_foo'],
  ['single-segment lookalike: /tmp~foo', ['/tmp', '/root'], '/tmp~foo', '/tmp~foo'],
  ['single-segment lookalike: /tmp-foo', ['/tmp', '/root'], '/tmp-foo', '/tmp-foo'],
  ['single-segment lookalike: /tmpé', ['/tmp', '/root'], '/tmpé', '/tmpé'],
  ['single-segment lookalike: /tmp2', ['/tmp', '/root'], '/tmp2', '/tmp2'],
  ['single-segment path: /tmp/x', ['/tmp', '/root'], '/tmp/x', '[local]/x'],
  ['single-segment path: /tmp', ['/tmp', '/root'], '/tmp', '[local]'],
  ['single-segment path: "/root/.agents"', ['/tmp', '/root'], '"/root/.agents"', '"[local]/.agents"'],
  ['single-segment path: path=/tmp/x', ['/tmp', '/root'], 'path=/tmp/x', 'path=[local]/x'],
  ['single-segment path: (/root/x)', ['/tmp', '/root'], '(/root/x)', '([local]/x)'],
  ['single-segment path: /tmp.', ['/tmp', '/root'], '/tmp.', '[local].'],
  ['Windows Temp', [String.raw`C:\Users\Name\AppData\Local\Temp`], String.raw`C:\Users\Name\AppData\Local\Temp\gg-x\wt`, String.raw`[local]\gg-x\wt`],
  ['Windows Temp case', [String.raw`C:\Users\Name\AppData\Local\Temp`], String.raw`c:\USERS\name\appdata\LOCAL\temp\gg-x`, String.raw`[local]\gg-x`],
  ['Windows file URL', [String.raw`C:\Users\Name\AppData\Local\Temp`], 'file:///C:/Users/Name/AppData/Local/Temp/gg-x/wt', '[local]/gg-x/wt'],
  ['POSIX file URL', ['/home/alice'], 'file:///home/alice/x', '[local]/x'],
  ['JSON backslashes', [String.raw`C:\Users\James`], String.raw`{"path":"C:\\Users\\James\\x"}`, String.raw`{"path":"[local]\\x"}`],
  ['trailing separator', ['/private/tree/'], '/private/tree/file', '[local]/file'],
  ['nested short directory', ['/private/tree', '/tmp'], '/private/tree/tmp/x', '[local]/tmp/x'],
  ['compiler include flag', ['/home/alice'], 'gcc -I/home/alice/inc', 'gcc -I[local]/inc'],
  ['compiler library flag', ['/home/alice'], '-L/home/alice/lib', '-L[local]/lib'],
  ['underscore prefix', ['/home/alice'], 'X_/home/alice/x', 'X_[local]/x'],
  ['hyphen prefix', ['/home/alice'], 'opt-/home/alice/x', 'opt-[local]/x'],
  ['Windows namespace', [String.raw`C:\Users\James`], String.raw`\\?\C:\Users\James\x`, String.raw`[local]\x`],
  ['single-backslash namespace', [String.raw`C:\Users\James`], String.raw`\?\C:\Users\James\x`, String.raw`[local]\x`],
  ['macOS realpath', ['/var/folders/ab/xyz/T'], '/private/var/folders/ab/xyz/T/gg-x', '[local]/gg-x'],
  ['MSYS', [String.raw`C:\Users\James`], '/c/Users/James/x', '[local]/x'],
  ['MSYS case', [String.raw`C:\Users\James`], '/C/users/JAMES/x', '[local]/x'],
  ['mixed separators', [String.raw`C:\Users\James`], String.raw`C:\Users/James\x`, String.raw`[local]\x`],
  ['forward separators', [String.raw`C:\Users\James`], 'C:/Users/James/x', '[local]/x'],
  ['semicolon PATH list', [String.raw`C:\Users\James`], String.raw`PATH=C:\Users\James\bin;C:/Users/James/lib`, String.raw`PATH=[local]\bin;[local]/lib`],
  ['colon PATH list', ['/home/alice'], 'PATH=/home/alice/bin:/home/alice/lib', 'PATH=[local]/bin:[local]/lib'],
  ['Windows stack', [String.raw`C:\Users\James`], String.raw`at run (C:\Users\James\test.mjs:3:4)`, String.raw`at run ([local]\test.mjs:3:4)`],
  ['POSIX stack', ['/home/alice'], 'at run (/home/alice/test.mjs:3:4)', 'at run ([local]/test.mjs:3:4)'],
  ['node:test location', [String.raw`C:\Users\James`], "location: 'C:/Users/James/test.mjs:3:4'", "location: '[local]/test.mjs:3:4'"],
  ['sentence parentheses', ['/home/alice'], '(in /home/alice.)', '(in [local].)'],
  ['sentence comma', [String.raw`C:\Users\James`], String.raw`see C:\Users\James., ok`, 'see [local]., ok'],
  ['ellipsis', ['/home/alice'], 'in /home/alice...', 'in [local]...'],
  ['Windows terminator &', [String.raw`C:\Users\James`], String.raw`C:\Users\James&x`, '[local]&x'],
  ['POSIX terminator &', ['/home/alice'], '/home/alice&x', '[local]&x'],
  ['Windows terminator |', [String.raw`C:\Users\James`], String.raw`C:\Users\James|x`, '[local]|x'],
  ['POSIX terminator |', ['/home/alice'], '/home/alice|x', '[local]|x'],
  ['Windows terminator *', [String.raw`C:\Users\James`], String.raw`C:\Users\James*x`, '[local]*x'],
  ['POSIX terminator *', ['/home/alice'], '/home/alice*x', '[local]*x'],
  ['Windows terminator =', [String.raw`C:\Users\James`], String.raw`C:\Users\James=x`, '[local]=x'],
  ['POSIX terminator =', ['/home/alice'], '/home/alice=x', '[local]=x'],
  ['multi-segment lookalike bob', ['/home/alice'], '/home/alicebob', '/home/alicebob'],
  ['multi-segment lookalike _bob', ['/home/alice'], '/home/alice_bob', '/home/alice_bob'],
  ['multi-segment lookalike ~bob', ['/home/alice'], '/home/alice~bob', '/home/alice~bob'],
  ['multi-segment lookalike -bob', ['/home/alice'], '/home/alice-bob', '/home/alice-bob'],
  ['multi-segment lookalike .test', ['/home/alice'], '/home/alice.test', '/home/alice.test'],
  ['multi-segment lookalike é', ['/home/alice'], '/home/aliceé', '/home/aliceé'],
  ['multi-segment lookalike 2', ['/home/alice'], '/home/alice2', '/home/alice2'],
  ['regex metacharacters', ['/home/a+[b](c)'], '/home/a+[b](c)/x', '[local]/x'],
  ['UNC directory', [String.raw`\\server\share\alice`], String.raw`\\server\share\alice\x`, String.raw`[local]\x`],
  ['UNC namespace', [String.raw`\\server\share\alice`], String.raw`\\?\UNC\server\share\alice\x`, String.raw`[local]\x`],
  ['already masked', ['/tmp', '/root'], '[local]/tmp/x [local]/root/b', '[local]/tmp/x [local]/root/b'],
];
for (const [name, directories, text, expected] of MASKS) {
  test(`publicText masks known directories without changing unrelated text: ${name}`, () => {
    const actual = render.publicText(text, directories);
    assert.equal(actual, expected);
    assert.equal(render.publicText(actual, directories), actual, 'masking again changes nothing');
  });
}

const PERCENT_ENCODED = [
  ['space', [String.raw`C:\Users\John Smith`], 'file:///C:/Users/John%20Smith/app/x.mjs:3:9', '[local]/app/x.mjs:3:9'],
  ['space without a scheme', [String.raw`C:\Users\John Smith`], 'C:/Users/John%20Smith/x', '[local]/x'],
  ['non-ASCII', ['/home/josé'], 'file:///home/jos%C3%A9/x', '[local]/x'],
  ['lowercase hex', ['/home/josé'], 'file:///home/jos%c3%a9/x', '[local]/x'],
  ['percent', ['/srv/a%b'], 'file:///srv/a%25b/x and /srv/a%b/y', '[local]/x and [local]/y'],
  ['hash', [String.raw`C:\w\a#b`], 'file:///C:/w/a%23b/x', '[local]/x'],
  ['question mark', ['/home/a?b'], 'file:///home/a%3Fb/x', '[local]/x'],
  // Node's pathToFileURL escapes # but keeps + and &, unlike both encodeURI and encodeURIComponent.
  ['file URL escapes', [String.raw`C:\w\a#b+c&d`], 'file:///C:/w/a%23b+c&d/x', '[local]/x'],
  ['UNC file URL', [String.raw`\\server\share\John Smith`], 'file://server/share/John%20Smith/x', '[local]/x'],
  ['JSON-escaped', [String.raw`C:\Users\John Smith`], String.raw`{"url":"file:///C:/Users/John%20Smith/x","path":"C:\\Users\\John Smith\\x"}`, String.raw`{"url":"[local]/x","path":"[local]\\x"}`],
  ['encoded lookalike', [String.raw`C:\Users\John Smith`], 'file:///C:/Users/John%20Smithson/x', 'file:///C:/Users/John%20Smithson/x'],
  ['encoded space after the directory', ['/home/alice'], 'file:///home/alice%20bob/x', 'file:///home/alice%20bob/x'],
  ['encoded letter after the directory', ['/home/alic'], 'file:///home/alic%C3%A9/x', 'file:///home/alic%C3%A9/x'],
  // Windows paths match case-insensitively, so an escaped letter matches the escape of its other case too.
  ['encoded uppercase of a Windows letter', ['C:/work/José'], 'file:///C:/work/JOS%C3%89/x', '[local]/x'],
  ['encoded lowercase of a Windows letter', [String.raw`C:\work\JOSÉ`], 'file:///C:/work/jos%c3%a9/x', '[local]/x'],
  ['literal other case of a Windows letter', ['C:/work/José'], 'C:/WORK/JOSÉ/x', '[local]/x'],
  ['encoded other case after a Windows directory', ['C:/work/Jos'], 'file:///C:/work/Jos%C3%89/x', 'file:///C:/work/Jos%C3%89/x'],
  // pathToFileURL escapes ~, which Windows 8.3 names such as RUNNER~1 contain.
  ['encoded tilde', [String.raw`C:\Users\RUNNER~1\AppData`], 'file:///C:/Users/RUNNER%7E1/AppData/x', '[local]/x'],
];
for (const [name, directories, text, expected] of PERCENT_ENCODED) {
  test(`publicText masks percent-encoded directories in file URLs and plain text: ${name}`, () => {
    const actual = render.publicText(text, directories);
    assert.equal(actual, expected);
    assert.equal(render.publicText(actual, directories), actual, 'masking again changes nothing');
  });
}

// As on a Windows runner, whose TEMP is the 8.3 name C:\Users\RUNNER~1\... while git reports C:\Users\runneradmin\...
test('publicText masks the canonical form of the temp directory and of directories given through a link', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-render-'));
  const saved = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'real', 'tmp'), { recursive: true });
  mkdirSync(join(root, 'real', 'repo'));
  symlinkSync(join(root, 'real'), join(root, 'link'), 'junction');
  const real = realpathSync.native(join(root, 'real'));
  // Only the linked spellings are known: the temp directory and the repository both arrive through the link.
  for (const k of Object.keys(saved)) process.env[k] = join(root, 'link', 'tmp');
  const text = `fatal: ${join(real, 'tmp', 'x')} and ${pathToFileURL(join(real, 'repo', 'y')).href}`;
  assert.equal(render.publicText(text, [join(root, 'link', 'repo')]), `fatal: [local]${sep}x and [local]/y`);
});

for (const [kind, subject] of [
  ['test', 'test: Add the cart total (#7)'],
  ['feat', 'feat: Add the cart total (#7)'],
  ['fix', 'fix: Add the cart total (#7)'],
]) {
  test(`a ${kind} commit message carries the stage and action trailers`, () => {
    const m = marker.formatMarker(parts);
    const message = render.commitMessage({
      kind, title: 'Add the cart total', ticket: 7, summary: 'Sums line items.',
      vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', marker: m,
    });
    const lines = message.trimEnd().split('\n');
    assert.equal(lines[0], subject);
    assert.match(message, /Sums line items\./);
    assert.deepEqual(lines.slice(-2), ['Feature-Flow-Stage: implement claude/opus/high', 'Gg-Action: gg:e1:implement:1:commit:0:r1:1']);
    assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
  });
}

const impl = {
  summary: 'Adds the cart total.',
  dod: [{ item: 'Total sums items', met: true, evidence: 'test/cart.test.mjs' }, { item: 'Docs', met: false, evidence: '' }],
  red: { command: 'npm test', output: 'not ok 1 - total' },
  green: { command: 'npm test', output: 'ok 1 - total' },
  qa: { setup: 'npm ci', steps: [{ action: 'Run gg', expected: 'Total shown' }], edgeCases: ['empty cart'], automated: ['total'], manual: [] },
};
// The shipped PR body, review comment and stop comment over the context their Actions give them.
const prBody = ({ ticket, impl, provenance, marker: m }, redact) => render.publicBody('pr-body.md',
  { ticket, report: impl, red: impl.red, green: impl.green, provenance }, m, redact);
const reviewComment = (response, agent, m, redact) => render.publicBody('review-comment.md', { review: { response }, agent }, m, redact);
const stopComment = (end, outcome, response, m, reason, redact) => render.publicBody('stop.md',
  { end, outcome, response, reason: reason?.text }, m, redact);
const provenance = [
  { vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', persona: 'tdd-implementer', hash: 'abc123', calls: 2, input: 100, cached: 40, output: 20 },
  { vertex: 'review', harness: 'codex', model: 'gpt', effort: 'medium', persona: 'reviewer', hash: 'def456', calls: 1, input: 50, cached: 0, output: 10 },
];

test('the PR body carries the marker line and provenance', async () => {
  const m = marker.formatMarker(parts);
  const body = await prBody({ ticket: { number: 7 }, impl, provenance, marker: m });
  assert.match(body, /^Closes #7/);
  assert.equal(body.trimEnd().split('\n').at(-1), `<!-- gg-action ${m} -->`);
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
  const row = body.split('\n').find((l) => l.startsWith('| implement |'));
  assert.ok(row, 'provenance row for the implement vertex');
  assert.match(row, /tdd-implementer@abc123/);
  assert.match(body, /- \[x\] Total sums items/);
  assert.match(body, /- \[ \] Docs/);
});

test('provenance counts one call per Attempt and a resumed Session once', () => {
  const at = (vertex, action, recovery, attempt) => marker.formatMarker({ execution: 'e1', vertex, visit: 1, action, recovery, run: 'r1', attempt });
  const usage = (input, cached, output) => ({ input, cached, output });
  // Each Attempt's completion saves its own usage.delta; the Session keeps only the last cumulative usage.
  const call = (m, delta) => [{ step: 'intent', marker: m, action: 'call' }, { step: 'evidence', marker: m, action: 'call', evidence: { usage: delta } },
    { step: 'complete', marker: m, action: 'call' }];
  const session = (vertex, cumulative) => ({ vertex, harness: 'claude', model: 'opus', effort: 'high', persona: 'tdd.md',
    personaHash: 'abcdef0123456789', usage: cumulative });
  const rec = {
    sessions: {
      // The recovery pass resumed red's Session, so its cumulative usage holds red's tokens too.
      'red/1/red': session('red', usage(130, 10, 13)),
      'green/1/green': session('green', usage(60, 0, 6)),
    },
    log: [
      ...call(at('red', 'red', 0, 1), usage(100, 10, 10)),
      ...call(at('red', 'red', 1, 1), usage(30, 0, 3)),
      { step: 'intent', marker: at('red', 'commit', 1, 1), action: 'commit' },
      // A parse retry: two Attempts of one Action, each one call.
      ...call(at('green', 'green', 0, 1), usage(50, 0, 5)),
      ...call(at('green', 'green', 0, 2), usage(60, 0, 6)),
    ],
  };
  const row = (vertex, calls, input, cached, output) => ({ vertex, harness: 'claude', model: 'opus', effort: 'high', persona: 'tdd.md',
    hash: 'abcdef012345', calls, input, cached, output });
  assert.deepEqual(render.provenance(rec), [row('red', 2, 130, 10, 13), row('green', 2, 110, 0, 11)]);
});

const last =(s) => s.trimEnd().split('\n').at(-1);
const fenced = (s) => '```\n' + s + '\n```';

test('a section renders once per list item', async () => {
  assert.equal(await render.template('{{#items}}- {{name}}\n{{/items}}', { items: [{ name: 'a' }, { name: 'b' }] }), '- a\n- b\n');
});

test('a section renders once for a present value and not for an empty one', async () => {
  assert.equal(await render.template('[{{#met}}x{{/met}}][{{#none}}y{{/none}}][{{#empty}}z{{/empty}}]', { met: true, none: '', empty: [] }), '[x][][]');
});

test('an inverted section renders for an absent value', async () => {
  assert.equal(await render.template('{{^missing}}none{{/missing}}', {}), 'none');
});

test('an inverted section renders for an empty list and not for a present value', async () => {
  assert.equal(await render.template('{{^items}}none{{/items}}{{^met}}no{{/met}}', { items: [], met: true }), 'none');
});

test('a dotted name reads a nested field, and an absent name renders empty', async () => {
  assert.equal(await render.template('#{{ticket.number}} [{{ticket.missing}}] [{{nothing.here}}]', { ticket: { number: 7 } }), '#7 [] []');
});

test('inside a list section a name reads the item first, then the outer context', async () => {
  const context = { base: 'main', files: ['a.mjs', 'b.mjs'], rows: [{ name: 'r1' }] };
  assert.equal(await render.template('{{#files}}{{.}}@{{base}} {{/files}}{{#rows}}{{name}}@{{base}}{{/rows}}', context), 'a.mjs@main b.mjs@main r1@main');
});

test('a section tag alone on its line leaves no line behind', async () => {
  assert.equal(await render.template('head\n  {{#items}}\n- {{.}}\n  {{/items}}\n{{^items}}\nnone\n{{/items}}\ntail', { items: ['a'] }), 'head\n- a\ntail');
});

test('an unnamed context value is not computed', async () => {
  let named = 0;
  const context = { named: () => { named++; return 'yes'; }, unnamed: () => { throw new Error('the unnamed value was computed'); } };
  assert.equal(await render.template('{{named}} {{#named}}{{named}}{{/named}}', context), 'yes yes');
  assert.equal(named, 1, 'a named value is computed once');
});

test('an async context value is awaited', async () => {
  assert.equal(await render.template('{{#files}}{{.}} {{/files}}', { files: async () => ['a.mjs', 'b.mjs'] }), 'a.mjs b.mjs ');
});

test('a section without its closing tag is refused', async () => {
  await assert.rejects(render.template('{{#items}}x', { items: [1] }), /\{\{#items\}\} is not closed/);
  await assert.rejects(render.template('x{{/items}}', {}), /\{\{\/items\}\} closes no open section/);
});

test("a fence whose opening line names a value fences every value it holds past that value's backticks", async () => {
  assert.equal(await render.template('```{{lang}}\n{{text}}\n```', { lang: 'text', text: 'x\n```\n## Outside' }), '````text\nx\n```\n## Outside\n````');
});

test('a value between two fences is not fenced', async () => {
  assert.equal(await render.template('```\na\n```\n{{v}}\n```\nb\n```', { v: '``` v' }), '```\na\n```\n``` v\n```\nb\n```');
});

test('a tilde fence outruns the tildes it holds, and an info string holding a backtick takes a tilde fence', async () => {
  assert.equal(await render.template('~~~\n{{text}}\n~~~', { text: '~~~\n## Outside' }), '~~~~\n~~~\n## Outside\n~~~~');
  assert.equal(await render.template('```{{lang}}\n{{text}}\n```', { lang: 'a`b', text: 'x' }), '~~~a`b\nx\n~~~');
});

test('a section that crosses a fence, and a fence that is not closed, are refused', async () => {
  await assert.rejects(render.template('{{#a}}\n```\n{{/a}}\n```', { a: 1 }), /\{\{\/a\}\} closes no open section/);
  await assert.rejects(render.template('```\n{{#a}}\n```\n{{/a}}', { a: 1 }), /\{\{#a\}\} must close inside the fence it opens in/);
  await assert.rejects(render.template('```\nx', {}), /a fence is not closed/);
});

const fixture = (name) => readFileSync(new URL(`../fixtures/templates/${name}`, import.meta.url), 'utf8');
const shapes = JSON.parse(fixture('comments.json'));
const fixtureMarker = marker.formatMarker(shapes.parts);

// The fixtures are the builders' output before #105.
test(`the PR body template matches its builder's output`, async () => {
  const body = await prBody({ ticket: { number: 7 }, impl: shapes.prImpl, provenance: shapes.provenance, marker: fixtureMarker });
  assert.equal(body, fixture('pr-body.txt'));
});

test(`the review comment template matches its builder's output`, async () => {
  assert.equal(await reviewComment(shapes.review, shapes.provenance[1], fixtureMarker), fixture('review-comment.txt'));
  assert.equal(await reviewComment({ ...shapes.review, claim: 'ok', findings: [] }, shapes.provenance[1], fixtureMarker),
    fixture('review-comment-no-findings.txt'));
});

test(`the Terminal Reason comment template matches its builder's output`, async () => {
  const interrupted = { terminal: 'ready-for-qa', reason: { text: 'PR #3 is ready.' } };
  assert.equal(await render.terminalComment('needs-human', { text: 'An unexpected fault stopped the Execution at test.' }, fixtureMarker,
    'Error: boom', interrupted), fixture('terminal.txt'));
  assert.equal(await render.terminalComment('ready-for-qa', { text: 'Every Vertex passed. PR #3 is ready for review.' }, fixtureMarker),
    fixture('terminal-plain.txt'));
});

test('the stop comment renders the blocked and needs-replan cases', async () => {
  const m = marker.formatMarker(parts);
  const response = { claim: 'blocked', summary: 'Cannot reach the API.', notes: 'NOTES stay out.', diagnosis: 'The ticket needs a token.' };
  const blocked = await stopComment('needs-human', 'blocked', response, m, { text: 'The agent made a blocked Claim at green.' });
  assert.equal(blocked, `### gg: blocked

${fenced('Cannot reach the API.')}

${fenced('The ticket needs a token.')}

**Terminal Reason:** The agent made a blocked Claim at green.

<!-- gg-action ${m} -->
`);
  const replan = await stopComment('needs-replan', 'misscoped', { ...response, claim: 'misscoped', diagnosis: 'Split into two tickets.' }, m, null);
  assert.equal(replan, `### gg: misscoped

${fenced('Cannot reach the API.')}

${fenced('Split into two tickets.')}

<!-- gg-action ${m} -->
`);
});

test('a review comment fences each finding past its own backticks and carries the marker line', async () => {
  const m = marker.formatMarker(parts);
  const review = await reviewComment(
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
  assert.ok(review.includes('````\noff by one\n```\n## Injected heading\n````'), `finding issue is fenced past its own backticks: ${review}`);
  assert.ok(review.includes(fenced('use <=\n# Another')), `finding fix is fenced: ${review}`);
  assert.equal(last(review), `<!-- gg-action ${m} -->`);
});

test('a review comment fences a finding file so its text cannot leave the fence', async () => {
  const m = marker.formatMarker(parts);
  const file = 'a.mjs`\n\n## Outside fence\n\n`';
  const injected = await reviewComment(
    { claim: 'changes', summary: 'x', dodMet: true, tddEvidenceOk: true, diagnosis: '', findings: [{ severity: 'major', file, issue: 'i', fix: 'f' }] },
    provenance[1], m,
  );
  assert.ok(injected.includes(render.fence(file)), `finding file is fenced: ${injected}`);
  assert.doesNotMatch(injected.replace(render.fence(file), ''), /## Outside fence/);
});

// Marking `gg` too shows that no builder passes its Action Marker through the redactor.
const redact = (text) => text.replaceAll('TOKEN', 'TOKEN*').replaceAll('gg', 'g*g');
const reason = { text: 'TOKEN reason' };
const tokenProvenance = provenance.map((p) => ({ ...p, vertex: `TOKEN ${p.vertex}`, harness: `TOKEN ${p.harness}`,
  model: `TOKEN ${p.model}`, effort: `TOKEN ${p.effort}`, persona: `TOKEN ${p.persona}` }));
const tokenResponse = { claim: 'blocked', summary: 'TOKEN summary', notes: 'TOKEN notes', diagnosis: 'TOKEN diagnosis' };
const tokenImpl = {
  summary: 'TOKEN summary', dod: [{ item: 'TOKEN item', met: true, evidence: 'TOKEN evidence' }],
  red: { command: 'TOKEN red', output: 'TOKEN red output' }, green: { command: 'TOKEN green', output: 'TOKEN green output' },
  qa: { setup: 'TOKEN setup', steps: [{ action: 'TOKEN action', expected: 'TOKEN expected' }],
    edgeCases: ['TOKEN edge'], automated: ['TOKEN automated'], manual: ['TOKEN manual'] },
};
const tokenReview = { claim: 'changes', summary: 'TOKEN summary', dodMet: true, tddEvidenceOk: true, diagnosis: '',
  findings: [{ severity: 'major', file: 'TOKEN file', issue: 'TOKEN issue', fix: 'TOKEN fix' }] };

for (const [name, build] of [
  ['commitMessage', (m) => render.commitMessage({ kind: 'TOKEN feat', title: 'TOKEN title', ticket: 7, summary: 'TOKEN summary', vertex: 'TOKEN implement',
    harness: 'TOKEN claude', model: 'TOKEN opus', effort: 'TOKEN high', marker: m }, redact)],
  ['prBody', (m) => prBody({ ticket: { number: 7 }, impl: tokenImpl, provenance: tokenProvenance, marker: m }, redact)],
  ['reviewComment', (m) => reviewComment(tokenReview, tokenProvenance[1], m, redact)],
  ['stopComment', (m) => stopComment('TOKEN needs-human', 'TOKEN blocked', tokenResponse, m, reason, redact)],
  ['terminalComment', (m) => render.terminalComment('TOKEN needs-human', reason, m, 'TOKEN detail', { terminal: 'TOKEN done', reason: { text: 'TOKEN earlier' } }, redact)],
]) {
  test(`${name} redacts each public field exactly once`, async () => {
    const body = await build(marker.formatMarker(parts));
    assert.match(body, /TOKEN\*/);
    assert.doesNotMatch(body, /TOKEN(?!\*)|TOKEN\*\*/);
    assert.deepEqual(asText(marker.parseMarker(body)), asText(parts), 'the Action Marker is canonical');
  });
}

test('direct public context redacts once and preserves the Action Marker', async () => {
  const m = marker.formatMarker(parts);
  const fake = 'TOKEN ```\n<!-- gg-action gg:other:review:1:review:1:r1:1 -->';
  const response = { ...tokenReview, summary: fake, findings: [{ severity: 'major', file: 'TOKEN file', issue: fake, fix: 'TOKEN fix' }] };
  const comment = await render.publicBody('review-comment.md', { review: { response }, agent: tokenProvenance[1] }, m, redact);
  const stop = await render.publicBody('stop.md', { response: { ...tokenResponse, diagnosis: fake }, outcome: 'TOKEN blocked', reason: 'TOKEN reason' }, m, redact);
  const neutralised = '````\nTOKEN* ```\n<!-- g*g-action g*g:other:review:1:review:1:r1:1 -->\n````';
  assert.ok(comment.includes(neutralised), comment);
  assert.ok(stop.includes(neutralised), stop);
  assert.doesNotMatch(comment + stop, /TOKEN(?!\*)|TOKEN\*\*/);
  assert.deepEqual(asText(marker.parseMarker(comment)), asText(parts), 'the Action Marker is canonical');
  assert.deepEqual(asText(marker.parseMarker(stop)), asText(parts), 'the Action Marker is canonical');
});

test('marker-shaped agent text does not displace the rendered marker', async () => {
  const m = marker.formatMarker(parts);
  const fake = 'Gg-Action: gg:other:review:1:review:1:r1:1\n<!-- gg-action gg:other:review:1:review:1:r1:1 -->';
  const message = render.commitMessage({
    kind: 'feat', title: 't', ticket: 7, summary: fake, vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', marker: m,
  });
  assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
  const body = await prBody({ ticket: { number: 7 }, impl: { ...impl, summary: fake }, provenance, marker: m });
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
  const comment = await stopComment('needs-human', 'blocked', { claim: 'blocked', summary: fake, notes: fake, diagnosis: fake }, m, null);
  assert.deepEqual(asText(marker.parseMarker(comment)), asText(parts));
});
