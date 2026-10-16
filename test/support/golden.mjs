// Golden-trace fixture: a temp bare origin and clone with a ticket worktree, a fake gh at lib/github.mjs's seam,
// a fake test runner, the fake harness, and every process call tagged with the activity it observed.
import childProcess, { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as gitModule from '../../lib/git.mjs';
import * as github from '../../lib/github.mjs';
import * as record from '../../lib/record.mjs';
import * as events from '../../lib/events.mjs';
import { fakeHarness } from './fake-harness.mjs';

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
        node: {
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

export async function setup(t, { responses = firstVisitResponses } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gg-golden-'));
  if (process.env.GG_KEEP_TEMP) t.diagnostic(`golden temp repo: ${root}`);
  else t.after(() => {
    record.close(join(root, 'main', '.git'));
    rmSync(root, { recursive: true, force: true });
  });

  sh(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  sh(root, 'clone', '-q', 'origin.git', 'main');
  const mainRoot = join(root, 'main');
  sh(mainRoot, 'config', 'user.name', 't'); sh(mainRoot, 'config', 'user.email', 't@t');
  writeFileSync(join(mainRoot, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
  sh(mainRoot, 'add', '-A');
  sh(mainRoot, 'commit', '-q', '-m', 'init');
  sh(mainRoot, 'push', '-q', 'origin', 'main');
  const worktree = join(root, 'wt', 'ticket-15');
  sh(mainRoot, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main');
  const base = sh(mainRoot, 'rev-parse', 'main');
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

  // Every real process spawn is observed, including the ones lib modules launch on their own (integrity snapshots).
  const spawn = childProcess.spawn;
  childProcess.spawn = (cmd, args, ...rest) => { observe(`${basename(cmd).replace(/\.exe$/i, '')} ${args?.[0]}`); return spawn(cmd, args, ...rest); };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = spawn; syncBuiltinESMExports(); });

  const gh = fakeGh({ branch: BRANCH, observe });
  github.setGh(gh.gh);

  const logs = [];
  const ev = events.eventLog(commonDir);
  let now = Date.parse('2026-10-15T00:00:00Z');
  const clock = { now: () => now, sleep: async (ms) => { now += ms; } };

  const options = {
    flow, record: rec, harness, gh: github, git: gitModule, exec, events: ev, log: (m) => logs.push(m), cwd: mainRoot,
    commands: { test: 'npm test' }, ticket: { number: TICKET, title: 'Add two numbers', body: 'Add `add(a, b)`.', branch: BRANCH },
    base: 'main', labelPrefix: 'gg', others: [], clock,
  };
  return {
    root, mainRoot, worktree, commonDir, base, flow, rec, harness, gh, shells, activity, logs, options, personaPath,
    readEvents: () => events.readEvents(commonDir),
  };
}

// A stand-in for the gh executable: records every argv and answers with canned JSON.
export function fakeGh({ branch, observe = () => {} }) {
  const calls = [];
  const comments = [];
  let pr = null;
  const gh = async (args, cwd, input) => {
    observe(`gh ${args[0]} ${args[1]}`);
    calls.push({ args, cwd, input });
    const [noun, verb] = args;
    if (noun === 'pr' && verb === 'list') return JSON.stringify(pr && args.includes(branch) ? [pr] : []);
    if (noun === 'pr' && verb === 'create') {
      pr = { number: 7, state: 'OPEN', isDraft: true, url: 'https://github.com/o/r/pull/7', body: input, headRefName: branch };
      return `${pr.url}\n`;
    }
    if (noun === 'pr' && verb === 'edit') { pr.body = input; return ''; }
    if (noun === 'pr' && verb === 'view') return JSON.stringify(pr);
    if (noun === 'pr' && verb === 'ready') { pr.isDraft = false; return ''; }
    if ((noun === 'pr' || noun === 'issue') && verb === 'comment') {
      const id = 1000 + comments.length;
      comments.push({ id, body: input, created_at: '2026-10-15T00:00:00Z', target: noun, number: Number(args[2]) });
      return `https://github.com/o/r/issues/${args[2]}#issuecomment-${id}\n`;
    }
    if (noun === 'api') {
      const n = Number(args.join(' ').match(/issues\/(\d+)\/comments/)?.[1]);
      return JSON.stringify([comments.filter((c) => c.number === n)]);
    }
    if ((noun === 'issue' && verb === 'edit') || (noun === 'label' && verb === 'create')) return '';
    throw new Error(`fake gh has no answer for ${args.join(' ')}`);
  };
  return { gh, calls, comments, pr: () => pr };
}
