import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as publicText from '../../lib/public-text.ts';

test('the line cutter falls back as configured when no line fits', () => {
  const omitted = (text: string) => `[${text.length} omitted]`;
  assert.equal(publicText.lastLines('one\ntwo\nthree', 9, omitted), 'two\nthree');
  assert.equal(publicText.lastLines('short', 9, omitted), 'short');
  assert.equal(publicText.lastLines('x'.repeat(12), 9, omitted), '[12 omitted]');
  assert.equal(publicText.lastLines('x'.repeat(12) + '\n', 9, omitted), '[13 omitted]');
  assert.equal(
    publicText.lastLines('x'.repeat(12), 9, (text) => text.slice(-9)),
    'x'.repeat(9),
  );
});

test('publicTail falls back to a character tail when the only later newline ends the text', () => {
  assert.equal(publicText.publicTail('x'.repeat(3100) + '\n', String), 'x'.repeat(2999) + '\n');
  assert.equal(publicText.publicTail('a\n' + 'x'.repeat(3100) + '\n', String), 'x'.repeat(2999) + '\n');
  assert.equal(publicText.publicTail('head line\n' + 'x'.repeat(2995) + '\n', String), 'x'.repeat(2995) + '\n');
});

// [name, known directories, text, the text published]
const MASKS: [string, string[], string, string][] = [
  [
    'roots and short entries',
    ['/', 'C:\\', '\\\\server\\share\\', 'x', '/a', '////', '\\\\\\'],
    'See https://github.com/o/r and lib/run.mjs; a /x b',
    'See https://github.com/o/r and lib/run.mjs; a /x b',
  ],
  [
    'deeper directory after skipped roots',
    ['/', 'C:\\', '\\\\server\\share\\', 'x', '/a', '////', '\\\\\\', '/private/worktree'],
    '/private/worktree/lib/add.mjs',
    '[local]/lib/add.mjs',
  ],
  ['all separators', ['////'], ' a /x b', ' a /x b'],
  ['single-segment lookalike: test/tmp.test.mjs', ['/tmp', '/root'], 'test/tmp.test.mjs', 'test/tmp.test.mjs'],
  ['single-segment lookalike: lib/tmpl/x.mjs', ['/tmp', '/root'], 'lib/tmpl/x.mjs', 'lib/tmpl/x.mjs'],
  ['single-segment lookalike: https://x.io/rootfs', ['/tmp', '/root'], 'https://x.io/rootfs', 'https://x.io/rootfs'],
  ['single-segment lookalike: a/root/b', ['/tmp', '/root'], 'a/root/b', 'a/root/b'],
  [
    'single-segment lookalike: Clean up /tmpdir usage',
    ['/tmp', '/root'],
    'Clean up /tmpdir usage',
    'Clean up /tmpdir usage',
  ],
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
  [
    'Windows Temp',
    [String.raw`C:\Users\Name\AppData\Local\Temp`],
    String.raw`C:\Users\Name\AppData\Local\Temp\gg-x\wt`,
    String.raw`[local]\gg-x\wt`,
  ],
  [
    'Windows Temp case',
    [String.raw`C:\Users\Name\AppData\Local\Temp`],
    String.raw`c:\USERS\name\appdata\LOCAL\temp\gg-x`,
    String.raw`[local]\gg-x`,
  ],
  [
    'Windows file URL',
    [String.raw`C:\Users\Name\AppData\Local\Temp`],
    'file:///C:/Users/Name/AppData/Local/Temp/gg-x/wt',
    '[local]/gg-x/wt',
  ],
  ['POSIX file URL', ['/home/alice'], 'file:///home/alice/x', '[local]/x'],
  [
    'JSON backslashes',
    [String.raw`C:\Users\James`],
    String.raw`{"path":"C:\\Users\\James\\x"}`,
    String.raw`{"path":"[local]\\x"}`,
  ],
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
  [
    'semicolon PATH list',
    [String.raw`C:\Users\James`],
    String.raw`PATH=C:\Users\James\bin;C:/Users/James/lib`,
    String.raw`PATH=[local]\bin;[local]/lib`,
  ],
  ['colon PATH list', ['/home/alice'], 'PATH=/home/alice/bin:/home/alice/lib', 'PATH=[local]/bin:[local]/lib'],
  [
    'Windows stack',
    [String.raw`C:\Users\James`],
    String.raw`at run (C:\Users\James\test.mjs:3:4)`,
    String.raw`at run ([local]\test.mjs:3:4)`,
  ],
  ['POSIX stack', ['/home/alice'], 'at run (/home/alice/test.mjs:3:4)', 'at run ([local]/test.mjs:3:4)'],
  [
    'node:test location',
    [String.raw`C:\Users\James`],
    "location: 'C:/Users/James/test.mjs:3:4'",
    "location: '[local]/test.mjs:3:4'",
  ],
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
  [
    'UNC namespace',
    [String.raw`\\server\share\alice`],
    String.raw`\\?\UNC\server\share\alice\x`,
    String.raw`[local]\x`,
  ],
  ['already masked', ['/tmp', '/root'], '[local]/tmp/x [local]/root/b', '[local]/tmp/x [local]/root/b'],
];
for (const [name, directories, text, expected] of MASKS) {
  test(`publicText masks known directories without changing unrelated text: ${name}`, () => {
    const actual = publicText.publicText(text, directories);
    assert.equal(actual, expected);
    assert.equal(publicText.publicText(actual, directories), actual, 'masking again changes nothing');
  });
}

const PERCENT_ENCODED: [string, string[], string, string][] = [
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
  [
    'JSON-escaped',
    [String.raw`C:\Users\John Smith`],
    String.raw`{"url":"file:///C:/Users/John%20Smith/x","path":"C:\\Users\\John Smith\\x"}`,
    String.raw`{"url":"[local]/x","path":"[local]\\x"}`,
  ],
  [
    'encoded lookalike',
    [String.raw`C:\Users\John Smith`],
    'file:///C:/Users/John%20Smithson/x',
    'file:///C:/Users/John%20Smithson/x',
  ],
  ['encoded space after the directory', ['/home/alice'], 'file:///home/alice%20bob/x', 'file:///home/alice%20bob/x'],
  ['encoded letter after the directory', ['/home/alic'], 'file:///home/alic%C3%A9/x', 'file:///home/alic%C3%A9/x'],
  // Windows paths match case-insensitively, so an escaped letter matches the escape of its other case too.
  ['encoded uppercase of a Windows letter', ['C:/work/José'], 'file:///C:/work/JOS%C3%89/x', '[local]/x'],
  ['encoded lowercase of a Windows letter', [String.raw`C:\work\JOSÉ`], 'file:///C:/work/jos%c3%a9/x', '[local]/x'],
  ['literal other case of a Windows letter', ['C:/work/José'], 'C:/WORK/JOSÉ/x', '[local]/x'],
  [
    'encoded other case after a Windows directory',
    ['C:/work/Jos'],
    'file:///C:/work/Jos%C3%89/x',
    'file:///C:/work/Jos%C3%89/x',
  ],
  // pathToFileURL escapes ~, which Windows 8.3 names such as RUNNER~1 contain.
  ['encoded tilde', [String.raw`C:\Users\RUNNER~1\AppData`], 'file:///C:/Users/RUNNER%7E1/AppData/x', '[local]/x'],
];
for (const [name, directories, text, expected] of PERCENT_ENCODED) {
  test(`publicText masks percent-encoded directories in file URLs and plain text: ${name}`, () => {
    const actual = publicText.publicText(text, directories);
    assert.equal(actual, expected);
    assert.equal(publicText.publicText(actual, directories), actual, 'masking again changes nothing');
  });
}

// As on a Windows runner, whose TEMP is the 8.3 name C:\Users\RUNNER~1\... while git reports C:\Users\runneradmin\...
test('publicText masks the canonical form of the temp directory and of directories given through a link', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gg-render-'));
  const saved = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map((variable) => [variable, process.env[variable]]));
  t.after(() => {
    for (const [variable, value] of Object.entries(saved))
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'real', 'tmp'), { recursive: true });
  mkdirSync(join(root, 'real', 'repo'));
  symlinkSync(join(root, 'real'), join(root, 'link'), 'junction');
  const real = realpathSync.native(join(root, 'real'));
  // Only the linked spellings are known: the temp directory and the repository both arrive through the link.
  for (const variable of Object.keys(saved)) process.env[variable] = join(root, 'link', 'tmp');
  const text = `fatal: ${join(real, 'tmp', 'x')} and ${pathToFileURL(join(real, 'repo', 'y')).href}`;
  assert.equal(publicText.publicText(text, [join(root, 'link', 'repo')]), `fatal: [local]${sep}x and [local]/y`);
});

test('publicText masks the home directory without being given it', (t) => {
  // A home of its own, apart from the temp directory and the checkout, which publicText also masks.
  const home = join(parse(tmpdir()).root, 'gg-synthetic-home');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => {
    for (const [variable, value] of Object.entries(saved))
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(homedir(), home);
  assert.equal(publicText.publicText(`at ${join(home, 'notes', 'x')}`), `at [local]${sep}notes${sep}x`);
});
