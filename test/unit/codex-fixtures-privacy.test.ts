import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as redaction from '../../scripts/record-codex-redaction.ts';

// The scan's redactor. It reads the name only standing whole: Ubuntu CI runs as `runner`, a word inside Codex's own
// executable names in cli-doctor.json (CI run 45056354195), which the recorder itself would redact. Under CI it reads
// no name at all (owner D1 A): the fixtures were recorded on another machine, and the example's own text says
// "runner"; the machine that records them still checks its name.
const scanRedactor = (env: NodeJS.ProcessEnv, username = userInfo().username) =>
  redaction.redactorOf('Z:/no-such-recording-base', { username: env.CI ? null : username, wholeName: true });

// DoD 4 (#479): the recorder's own redaction finds nothing left in a committed Codex fixture: no checkout path, home,
// user name, token or email.
test('no Codex recording holds what the recorder redacts', () => {
  const recordings = new URL('../fixtures/codex/', import.meta.url);
  const redact = scanRedactor(process.env);
  const leaking = readdirSync(recordings).filter((file) => {
    const text = readFileSync(new URL(file, recordings), 'utf8');
    return redact(text) !== text;
  });
  assert.deepEqual(leaking, []);
});

test('the scan checks the user name where recordings are made, and under CI checks only the rest', () => {
  const text = 'as the test runner prints them; D:/runner/x; mail a@example.com';
  assert.equal(scanRedactor({}, 'runner')(text), 'as the test <user> prints them; D:/<user>/x; mail <email>');
  assert.equal(
    scanRedactor({ CI: 'true' }, 'runner')(text),
    'as the test runner prints them; D:/runner/x; mail <email>',
  );
});

// The recorder redacts the name wherever it appears, as scripts/record-claude.ts does (owner Q4 A, D6 A).
test('the recorder redacts the user name inside a longer name too', () => {
  const redact = redaction.redactorOf('Z:/no-such-recording-base', { username: 'runner' });
  assert.equal(
    redact('codex-command-runner.exe; runner_x; Runner said; D:/runner/x'),
    'codex-command-<user>.exe; <user>_x; <user> said; D:/<user>/x',
  );
});

test("the privacy test's check redacts the user name only standing whole", () => {
  const redact = redaction.redactorOf('Z:/no-such-recording-base', { username: 'runner', wholeName: true });
  assert.equal(
    redact('codex-command-runner.exe; runner_x; Runner said; D:/runner/x'),
    'codex-command-runner.exe; runner_x; <user> said; D:/<user>/x',
  );
});

// The recorder redacts the account's ids and the repository URL by key (owner Q4 A), at any depth of any line.
test('no Codex recording holds an account id or repository URL by key', () => {
  const recordings = new URL('../fixtures/codex/', import.meta.url);
  const leaks: string[] = [];
  const walk = (file: string, value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) walk(file, child);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (redaction.ACCOUNT_KEYS.test(key) && typeof child === 'string' && child !== '<redacted>')
        leaks.push(`${file} ${key}`);
      else walk(file, child);
    }
  };
  for (const file of readdirSync(recordings)) {
    const text = readFileSync(new URL(file, recordings), 'utf8');
    for (const line of file.endsWith('.jsonl') ? text.split('\n').filter((each) => each.trim()) : [text])
      walk(file, JSON.parse(line));
  }
  assert.deepEqual(leaks, []);
});

// The case above reads the committed fixtures, so it holds under a weakened ACCOUNT_KEYS: this one runs the rule.
test('the recorder redacts the account ids and repository URL by key, at any depth', () => {
  const keys = ['creator_user_id', 'creator_account_id', 'repository_url', 'installation_id', 'email'];
  const line = { items: [Object.fromEntries(keys.map((key) => [key, 'x']))] };
  assert.deepEqual(redaction.trimmed(line), { items: [Object.fromEntries(keys.map((key) => [key, '<redacted>']))] });
});

// The cases above check the rules against themselves or today's fixtures, so a narrowed rule passes them (owner D22
// D): this one plants each value a recording must never commit, by key and in text, sends it through the recorder's
// own commit step, and finds none of them left, whatever the rules say.
test('no planted account id, token, email, path or user name survives the commit step', () => {
  const checkout = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
  const planted = {
    type: 'session_meta',
    payload: {
      creator_user_id: 'cnry-u1',
      creator_account_id: 'cnry-a1',
      creator_name: 'cnry-n1',
      account_id: 'cnry-a2',
      user_id: 'cnry-u2',
      chatgpt_account_id: 'cnry-a3',
      installation_id: 'cnry-i1',
      email: 'cnry-e1',
      git: { repository_url: 'https://github.com/cnry-r1/private' },
      text: [
        'key sk-cnry0123456789abcdef; jwt eyJcnry.eyJcnry.cnrysig; mail cnry-m1@example.com;',
        `${homedir()}/x; ${checkout}/lib by host canaryuser-PC`,
      ].join(' '),
    },
  };
  const committed = redaction.committedLine(
    JSON.stringify(planted),
    redaction.redactorOf('Z:/no-such-recording-base', { username: 'canaryuser' }),
  );
  // A path as written and as JSON escapes it inside the line.
  const paths = [homedir(), checkout].flatMap((path) => [path, JSON.stringify(path).slice(1, -1)]);
  const left = ['cnry', 'canaryuser', ...paths].filter((value) =>
    committed.toLowerCase().includes(value.toLowerCase()),
  );
  assert.deepEqual(left, [], committed);
});

// The recorder's own calls keep the substring rule: only this test reads the name standing whole (owner D6 A).
test('the recorder never asks for the whole-name rule', () => {
  const scripts = new URL('../../scripts/', import.meta.url);
  const asking = readdirSync(scripts)
    .filter((file) => file.startsWith('record-codex') && file !== 'record-codex-redaction.ts')
    .filter((file) => readFileSync(new URL(file, scripts), 'utf8').includes('wholeName'));
  assert.deepEqual(asking, []);
});
