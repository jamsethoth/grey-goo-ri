// What every recorder of an Agent CLI shares (#480): the names it records, the text it fills, the environment a nested
// CLI starts with, the redaction of what it commits and a call's saved files, over stand-in scenarios and paths that
// are neither Claude's nor Codex's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cliRecording from '../../scripts/cli-recording.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const USAGE = 'usage: stand-in recorder [name ...]';
interface StandInScenario {
  name: string;
  continues?: string;
}
const RECORDABLE = {
  scenarios: [{ name: 'first' }, { name: 'second', continues: 'first' }, { name: 'alone' }] as StandInScenario[],
  commands: [{ name: 'version' }, { name: 'help' }],
  continuesOf: (scenario: StandInScenario) => scenario.continues,
  usage: USAGE,
};
const chosen = (names: string[]) => {
  const picked = cliRecording.chosenOf(names, RECORDABLE);
  return 'error' in picked
    ? picked
    : { scenarios: picked.scenarios.map(({ name }) => name), commands: picked.commands.map(({ name }) => name) };
};

test('no name chooses every scenario and command, in order', () => {
  assert.deepEqual(chosen([]), { scenarios: ['first', 'second', 'alone'], commands: ['version', 'help'] });
});

test('the names chosen keep the order the recorder declares', () => {
  assert.deepEqual(chosen(['help', 'second', 'first']), { scenarios: ['first', 'second'], commands: ['help'] });
});

test('a name the recorder does not know is an error with the usage', () => {
  assert.deepEqual(chosen(['first', 'nope']), { error: `unknown name: nope\n${USAGE}` });
});

test('--help gives the usage', () => {
  assert.deepEqual(chosen(['--help']), { error: USAGE });
});

test('a scenario chosen without the one it continues is an error naming both', () => {
  assert.deepEqual(chosen(['second', 'alone']), { error: `second continues first\n${USAGE}` });
});

test('fill replaces each key it holds and keeps an unknown one', () => {
  assert.equal(cliRecording.fill('{base}/out {stub} {missing}', { base: 'B', stub: 'S' }), 'B/out S {missing}');
});

test("the nested CLI's environment drops the session's own variables and takes the call's", (t) => {
  process.env.STAND_IN_SESSION = 'the session';
  process.env.STAND_IN_KEPT = 'kept';
  t.after(() => {
    delete process.env.STAND_IN_SESSION;
    delete process.env.STAND_IN_KEPT;
  });
  const env = cliRecording.environmentOf(/^STAND_IN_SESSION/, { STAND_IN_HOME: 'home' });
  assert.deepEqual(
    { session: env.STAND_IN_SESSION, kept: env.STAND_IN_KEPT, home: env.STAND_IN_HOME },
    { session: undefined, kept: 'kept', home: 'home' },
  );
});

const redact = cliRecording.redactorOf({
  paths: [[String.raw`C:\rec\stand in`, '<recording>']],
  username: 'standin',
  patterns: [[/tok-\w+/g, 'tok-<redacted>']],
});

test('a path is redacted as written, slashed, JSON-escaped, as Git Bash writes it and as a directory name', () => {
  const written = [
    String.raw`C:\rec\stand in\x.txt`,
    'c:/rec/stand in/x.txt',
    String.raw`"C:\\\\rec\\\\stand in"`,
    '/c/rec/stand in/x.txt',
    'projects/C--rec-stand-in/s.jsonl',
  ];
  assert.deepEqual(written.map(redact), [
    String.raw`<recording>\x.txt`,
    '<recording>/x.txt',
    '"<recording>"',
    '<recording>/x.txt',
    'projects/<recording>/s.jsonl',
  ]);
});

test("the user's name is redacted wherever it appears, inside a longer name too, in any case", () => {
  assert.deepEqual(['by standin.', 'StandIn ran', 'standin-runner.exe', 'xstandin'].map(redact), [
    'by <user>.',
    '<user> ran',
    '<user>-runner.exe',
    'x<user>',
  ]);
});

test('a username equal to a label or a part of a key leaves no name or key readable and no label broken', () => {
  const key = [/sk-ant-[\w-]+/g, 'sk-ant-<redacted>'] as [RegExp, string];
  const labels = ['<recording>', '<home>', '<user>', '<email>', '<redacted>'];
  // Each label's text and each part of the key's prefix, as a username.
  const usernames = [...labels.map((label) => label.slice(1, -1)), ...'sk-ant'.split('-')];
  const broken = usernames.flatMap((username) => {
    const redactName = cliRecording.redactorOf({
      paths: [
        [String.raw`C:\rec\stand in`, '<recording>'],
        [`C:/Users/${username}`, '<home>'],
      ],
      username,
      patterns: [key],
    });
    const samples = [
      `hello ${username}`,
      `${username.toUpperCase()} ran`,
      `x_${username}_y and ${username}123`,
      `in C:/rec/stand in/${username}`,
      `at C:/Users/${username}/b.txt`,
      'key sk-ant-abc123',
      `mail ${username}.b@example.com`,
    ];
    return samples.flatMap((sample) => {
      const redacted = redactName(sample);
      const outsideLabels = labels.reduce((text, label) => text.replaceAll(label, ' '), redacted).toLowerCase();
      const readable = [username, 'abc123', '<', '>'].filter((part) => outsideLabels.includes(part));
      return readable.length ? [`${username}: ${sample} -> ${redacted}`] : [];
    });
  });
  assert.deepEqual(broken, []);
});

test("email addresses and the recorder's own patterns are redacted", () => {
  assert.equal(redact('mail a.b+c@example.co.uk with tok-abc123'), 'mail <email> with tok-<redacted>');
});

test('a call is saved as its redacted lines and its redacted meta', (t) => {
  const output = tempDirectory.tempDirectory(t, 'gg cli-recording-');
  cliRecording.save(output, 'said', {
    redact: (text) => text.replaceAll('secret', '<redacted>'),
    lines: ['{"type":"said","text":"secret"}', '{"type":"done"}'],
    meta: { exitCode: 0, stdin: 'a secret prompt' },
  });
  // A file the save did not write reads as null.
  const saved = (file: string) => (existsSync(join(output, file)) ? readFileSync(join(output, file), 'utf8') : null);
  const meta = saved('said.json');
  assert.deepEqual(
    { lines: saved('said.jsonl'), meta: meta === null ? null : (JSON.parse(meta) as unknown) },
    {
      lines: '{"type":"said","text":"<redacted>"}\n{"type":"done"}\n',
      meta: { exitCode: 0, stdin: 'a <redacted> prompt' },
    },
  );
});
