// Golden-trace fixture: a temp bare origin and clone with a ticket worktree, a fake gh at lib/github.mjs's seam,
// a fake test runner, the fake harness, and every harness, test, git and gh call tagged with the activity it observed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as checks from '../../lib/checks.mjs';
import * as gitModule from '../../lib/git.mjs';
import * as github from '../../lib/github.mjs';
import * as shipped from '../../lib/harnesses/shipped.mjs';
import * as record from '../../lib/record.mjs';
import * as events from '../../lib/events.mjs';
import * as interpreter from '../../lib/interpreter.mjs';
import * as labelModule from '../../lib/labels.mjs';
import { fakeHarness } from './fake-harness.mjs';
import * as fakeIntegrityModule from './fake-integrity.mjs';
import * as fakeGitModule from './fake-git.mjs';
import * as templateRepos from './template-repos.mjs';

export { seedRepos } from './template-repos.mjs';

export const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export const TICKET = 15;
export const BRANCH = 'ticket/15-add-two-numbers';
export const TEST_NAME = 'adds two numbers';
export const RED_OUTPUT = `✖ ${TEST_NAME} (1.2ms)\n  Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'lib/add.mjs'\nℹ fail 1`;
export const GREEN_OUTPUT = `✔ ${TEST_NAME} (0.8ms)\nℹ pass 1`;
export const PERSONA = '# implementer\nWrite the smallest change.\n';

export const redResponse = {
  claim: 'ok', summary: 'Failing test for add.', tests: [TEST_NAME], notes: 'add does not exist yet', diagnosis: '',
};

export const greenResponse = {
  claim: 'ok',
  summary: 'Add two numbers.',
  dod: [{ item: 'add returns the sum', met: true, evidence: 'test/add.test.mjs' }],
  qa: { setup: 'npm test', steps: [{ action: 'run npm test', expected: 'it passes' }], edgeCases: ['negative numbers'], automated: ['adds two numbers'], manual: [] },
  diagnosis: '',
  notes: '',
};

export const firstVisitResponses = {
  'implementer/1/red/1': {
    files: { 'test/add.test.mjs': "import { add } from '../lib/add.mjs';\n" },
    response: redResponse,
    result: { usage: { delta: { input: 100, output: 20 } } },
  },
  'implementer/1/green/1': {
    files: { 'lib/add.mjs': 'export const add = (a, b) => a + b;\n' },
    response: greenResponse,
    result: { usage: { delta: { input: 200, output: 40 } } },
  },
};

// A one-Vertex Resolved Flow: the tdd implementer goes straight to done.
export const oneVertexFlow = (persona) => ({
  name: 'golden',
  plan: null,
  ticket: {
    entry: 'implementer',
    vertices: {
      implementer: {
        agent: {
          harness: 'fake', model: 'model-x', effort: 'high', persona, skills: [], mcp: [], plugins: [],
          access: 'workspace-write', network: false,
        },
        procedure: 'tdd',
        options: {},
        then: 'done',
      },
    },
  },
});

// Reduces Action Events to what a golden trace asserts.
export const trace = (evs) => evs.filter((e) => e.type === 'action')
  .map(({ phase, ordinal, attempt, outcome }) => ({ phase, ordinal, attempt, outcome }));

// The Protected Files gg run passes: gg's own paths and every shipped Harness's.
export const PROTECTED_PATHS = interpreter.protectedFiles(Object.values(shipped.HARNESSES));

// The fake integrity, or null for the real one, and the options that inject it into runExecution or gg run.
export const fakeOf = (integrity, head) => (integrity === 'real' ? null : fakeIntegrityModule.fakeIntegrity({ head }));
export const injected = (fake) => (fake ? { integrity: fake.integrity, testImmutability: fake.testImmutability } : {});

// The template's repos, in real git or in a fake git, and the git module to inject. Returns main's SHA.
export function seedGit(root, which) {
  if (which === 'real') return { base: templateRepos.seedRepos(root), git: gitModule, fakeGit: null };
  const fake = fakeGitModule.fakeGit();
  return { base: fake.init(root, { files: { 'package.json': templateRepos.TEMPLATE_PACKAGE } }).base, git: fake.git, fakeGit: fake };
}

// git and integrity are fakes unless `git` or `integrity` is 'real', for a test whose subject is git behaviour; real
// integrity runs over real git unless `git` says otherwise.
export async function setup(t, { responses = firstVisitResponses, integrity = 'fake', git: which = integrity === 'real' ? 'real' : 'fake' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gg-golden-'));
  if (process.env.GG_KEEP_TEMP) t.diagnostic(`golden temp repo: ${root}`);
  else t.after(() => {
    record.close(join(root, 'main', '.git'));
    rmSync(root, { recursive: true, force: true });
  });

  const { base, git, fakeGit } = seedGit(root, which);
  const fake = fakeOf(integrity, base);
  const mainRoot = join(root, 'main');
  const worktree = join(root, 'wt', 'ticket-15');
  if (which === 'real') sh(mainRoot, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main');
  else await git.ensureWorktree({ mainRoot, path: worktree, branch: BRANCH, base: 'main' });
  const commonDir = join(mainRoot, '.git');

  mkdirSync(join(root, 'personas'));
  const personaPath = join(root, 'personas', 'implementer.md');
  writeFileSync(personaPath, PERSONA);
  const flow = oneVertexFlow(personaPath);

  const rec = record.createExecution({
    commonDir, ticket: TICKET, epic: 1, flow: { name: flow.name, entry: flow.ticket.entry }, configHash: 'cfg-hash',
    run: '20261015T000000Z-abc123', worktree, branch: BRANCH, base: 'main',
  });
  await record.save(rec);

  // What every launched process saw of the worktree's activity, read from the saved row as another process would.
  const read = record.openDb(commonDir).prepare("SELECT json FROM records WHERE kind = 'ticket' AND n = ?");
  const activity = [];
  const observe = (what) => activity.push({ what, ...JSON.parse(read.get(TICKET).json).activity });

  const harness = fakeHarness({ transcriptDir: join(root, 'transcripts'), responses, capabilities: { cost: false, reasoningTokens: false } });
  const run = harness.run;
  harness.run = (call) => { observe('harness'); return run(call); };

  const shells = [];
  const exec = {
    runShell: async (command, opts) => {
      observe('test');
      shells.push({ command, cwd: opts?.cwd });
      const passes = existsSync(join(opts?.cwd ?? worktree, 'lib', 'add.mjs'));
      return { code: passes ? 0 : 1, output: passes ? GREEN_OUTPUT : RED_OUTPUT, timedOut: false };
    },
  };

  // Every git verb is observed, including the ones lib modules call on their own (integrity snapshots).
  const observedGit = Object.fromEntries(Object.entries(git).map(([verb, fn]) =>
    [verb, typeof fn === 'function' ? (...args) => { observe(`git ${verb}`); return fn(...args); } : fn]));

  const gh = fakeGh({ branch: BRANCH, observe });
  const previousGh = github.setGh(gh.gh);
  t.after(() => github.setGh(previousGh));

  const logs = [];
  const ev = events.eventLog(commonDir);
  let now = Date.parse('2026-10-15T00:00:00Z');
  // Every sleep is recorded; `onSleep`, when a test sets it, runs before the clock moves on.
  const sleeps = [];
  // `beat()` runs what is due on `every`, as a heartbeat timer firing.
  const beats = new Set();
  const clock = {
    now: () => now, sleep: async (ms) => { sleeps.push(ms); await clock.onSleep?.(ms); now += ms; },
    every: (ms, fn) => { beats.add(fn); return () => beats.delete(fn); },
    beat: () => { for (const fn of beats) fn(); },
  };

  const options = {
    flow, record: rec, harness, gh: github, git: observedGit, exec, events: ev, log: (m) => logs.push(m), cwd: mainRoot,
    commands: { test: 'npm test' }, testPaths: [...checks.DEFAULT_TEST_GLOBS], ticket: { number: TICKET, title: 'Add two numbers', body: 'Add `add(a, b)`.', branch: BRANCH },
    base: 'main', labelPrefix: 'gg', others: [], clock, protectedPaths: PROTECTED_PATHS, ...injected(fake),
  };
  return {
    root, mainRoot, worktree, commonDir, base, flow, rec, harness, gh, shells, activity, logs, options, personaPath, clock, sleeps, fake, fakeGit,
    readEvents: () => events.readEvents(commonDir),
  };
}

// A comment POST through `gh api`, on issue or PR `n` when given.
export const isCommentPost = (args, n) => args[0] === 'api' && args.includes('POST')
  && args.some((a) => (n === undefined ? /issues\/\d+\/comments$/ : new RegExp(`issues/${n}/comments$`)).test(a));
export const isCommentRead = (args, n) => args[0] === 'api' && !args.includes('POST')
  && args.some((a) => (n === undefined ? /issues\/\d+\/comments$/ : new RegExp(`issues/${n}/comments$`)).test(a));

// `gh api --include` stdout: the status line and headers, a blank line, then the body.
export const included = (status, headers, body) =>
  `HTTP/2.0 ${status} ${STATUS_TEXT[status] ?? ''}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${JSON.stringify(body)}`;
const STATUS_TEXT = { 201: 'Created', 401: 'Unauthorized', 403: 'Forbidden', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 502: 'Bad Gateway' };

// A failed gh call as exec.run rejects it: the message and stderr carry gh's reason, stdout what `--include` printed.
export function ghError(args, { status, headers = {}, body, stderr }) {
  const message = body?.message ?? STATUS_TEXT[status];
  const err = stderr ?? `gh: ${message} (HTTP ${status})`;
  const stdout = args.includes('--include') && status ? included(status, headers, body ?? { message }) : '';
  return Object.assign(new Error(`${err}\ngh ${args.join(' ')}`), { code: 1, stdout, stderr: err });
}

// A stand-in for the gh executable: records every argv and answers with canned JSON. `fail(f)` queues a failure: the
// first unspent one whose `matches(args)` holds fails that call, after its effect when `afterEffect` is set.
export function fakeGh({ branch, ticket = TICKET, observe = () => {}, repoLabels = labelModule.STATE_LABELS.map(labelModule.labels().state) }) {
  const calls = [];
  const comments = [];
  const failures = [];
  // Each issue's labels on GitHub, as issue edits leave them and issue view reports them.
  const issueLabels = new Map();
  const labelsOf = (n) => issueLabels.get(n) ?? issueLabels.set(n, new Set()).get(n);
  const available = new Set(repoLabels);
  // Pull requests by head branch, so each Ticket of an epic gets its own.
  const prs = new Map();
  const prOf = (n) => [...prs.values()].find((p) => p.number === n) ?? null;
  const named = (set, name) => [...set].find((l) => l.toLowerCase() === name.toLowerCase());
  const gh = async (args, cwd, input) => {
    observe(`gh ${args[0]} ${args[1]}`);
    calls.push({ args, cwd, input });
    const failure = failures.find((f) => !f.spent && f.matches(args));
    if (!failure) return answer(args, input);
    failure.spent = true;
    if (failure.afterEffect) await answer(args, input);
    throw ghError(args, failure);
  };
  const post = (n, body) => {
    const id = 1000 + comments.length;
    comments.push({ id, body, created_at: '2026-10-15T00:00:00Z', target: prOf(n) ? 'pr' : 'issue', number: n });
    return id;
  };
  const answer = async (args, input) => {
    const [noun, verb] = args;
    const head = args[args.indexOf('--head') + 1];
    if (noun === 'pr' && verb === 'list') return JSON.stringify(prs.has(head) ? [prs.get(head)] : []);
    if (noun === 'pr' && verb === 'create') {
      const number = 7 + prs.size;
      prs.set(head, { number, state: 'OPEN', isDraft: args.includes('--draft'), url: `https://github.com/o/r/pull/${number}`, body: input, headRefName: head });
      return `${prs.get(head).url}\n`;
    }
    if (noun === 'pr' && verb === 'edit') { prOf(Number(args[2])).body = input; return ''; }
    if (noun === 'pr' && verb === 'view') return JSON.stringify(prOf(Number(args[2])));
    if (noun === 'pr' && verb === 'ready') { prOf(Number(args[2])).isDraft = false; return ''; }
    if (isCommentPost(args)) {
      const n = Number(args.join(' ').match(/issues\/(\d+)\/comments/)[1]);
      const id = post(n, JSON.parse(input).body);
      return included(201, { 'Content-Type': 'application/json; charset=utf-8' },
        { id, html_url: `https://github.com/o/r/issues/${n}#issuecomment-${id}` });
    }
    if (noun === 'api') {
      if (args.at(-1).includes('/labels')) return JSON.stringify([[...available].map((name) => ({ name }))]);
      const n = Number(args.join(' ').match(/issues\/(\d+)\/comments/)?.[1]);
      return JSON.stringify([comments.filter((c) => c.number === n)]);
    }
    if (noun === 'issue' && verb === 'view') {
      return JSON.stringify({ number: Number(args[2]), title: '', body: '', state: 'OPEN',
        labels: [...labelsOf(Number(args[2]))].map((name) => ({ name })), blockedBy: [], subIssues: [] });
    }
    // GitHub resolves label names case-insensitively and keeps the repository's spelling.
    if (noun === 'issue' && verb === 'edit') {
      const labels = labelsOf(Number(args[2]));
      args.forEach((a, i) => {
        if (a === '--add-label') labels.add(named(available, args[i + 1]) ?? args[i + 1]);
        if (a === '--remove-label') labels.delete(named(labels, args[i + 1]));
      });
      return '';
    }
    if (noun === 'label' && verb === 'create') {
      if (named(available, args[2])) throw new Error(`label with name "${args[2]}" already exists; use --force to update its color and description`);
      available.add(args[2]);
      return '';
    }
    throw new Error(`fake gh has no answer for ${args.join(' ')}`);
  };
  // `labels` are the fixture Ticket's.
  return { gh, calls, comments, labels: labelsOf(ticket), labelsOf, repoLabels: available, pr: () => prs.get(branch) ?? null, fail: (f) => failures.push({ ...f }) };
}

// The fs a restore uses (integrity.withGit's), crashing the `n`th `op` (rm or writeFile) on a path under `root` once
// `active()` holds, after the call has run when `after` is set.
export function crashFs(root, active, { op, n, after = false }) {
  let calls = 0;
  return { ...fsPromises, [op]: async (path, ...rest) => {
    if (!active() || !String(path).startsWith(root) || ++calls !== n) return fsPromises[op](path, ...rest);
    if (after) await fsPromises[op](path, ...rest);
    throw new interpreter.CrashError(`crash at ${op} ${n}`);
  } };
}

// Fails each save whose record, and the row saved for it so far (or undefined), match `when(saved, next)`, as a disk
// error would. Undone by the returned function or when the test ends.
export function failSaves(t, when) {
  const previous = record.setSaveHook((next) => {
    const [kind, n] = 'execution' in next ? ['ticket', next.ticket] : ['epic', next.epic];
    const row = record.openDb(next.commonDir).prepare('SELECT json FROM records WHERE kind = ? AND n = ?').get(kind, n);
    if (when(row && JSON.parse(row.json), next)) throw new Error('disk I/O error');
  });
  const restore = () => record.setSaveHook(previous);
  t.after(restore);
  return restore;
}

// Fails each Event insert that matches `when(event)`, as a disk error would. Undone by the returned function or when
// the test ends.
export function failAppends(t, when) {
  const previous = events.setAppendHook((event) => { if (when(event)) throw new Error('disk I/O error'); });
  const restore = () => events.setAppendHook(previous);
  t.after(restore);
  return restore;
}
