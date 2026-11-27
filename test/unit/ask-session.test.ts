import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as exec from '../../lib/exec.ts';
import * as askSession from '../../lib/harnesses/ask-session.ts';
import * as claude from '../../lib/harnesses/claude.ts';
import * as codex from '../../lib/harnesses/codex.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database/index.ts';
import * as caseEnv from '../support/case-env.ts';
import * as recordedCli from '../support/recorded-cli.ts';
import * as recordedCodexCli from '../support/recorded-codex-cli.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// gg ask-session (#430, Q1 A): a question to a Session an agent handed off, asked through a read-only copy of it.

const HANDED_OFF = 'session-handed-off';
const CURRENT = 'session-current';
const ANSWER = 'lib/add.mjs is half written: the sum is there, the tests are not run.';

// A State Database holding Ticket 8's Execution Record, whose green Action handed HANDED_OFF off to CURRENT.
function handedOffRecord(t: TestContext) {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-ask-session-');
  const executionRecord = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 8,
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/8',
    base: 'main',
  });
  const cumulativeUsage = contract.emptyUsage(claude.capabilities);
  executionRecord.sessions['green/1/green'] = {
    sessionId: CURRENT,
    harness: 'claude',
    personaHash: 'a'.repeat(64),
    transcriptPath: null,
    cumulativeUsage,
    vertex: 'green',
    model: 'opus',
    effort: 'high',
    personaName: 'implementer.md',
    handedOff: [{ sessionId: HANDED_OFF, transcriptPath: null, cumulativeUsage, attempt: 1 }],
  };
  stateDatabase.save(executionRecord);
  return { commonDir, worktree: executionRecord.worktree };
}

// The recorded CLI, its copy of a Session answering with the structured answer a question gets.
const answering = () =>
  recordedCli.recordedCli({
    fork: (stream) =>
      stream
        .split('\n')
        .filter(Boolean)
        .map((text) => {
          const line = JSON.parse(text) as Record<string, unknown>;
          return JSON.stringify(line.type === 'result' ? { ...line, structured_output: { answer: ANSWER } } : line);
        })
        .join('\n'),
  });

const flagValue = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

test("gg ask-session gives the handed-off Session's answer to the question", async (t) => {
  const { commonDir } = handedOffRecord(t);
  const cli = answering();
  const question = 'Which file did you leave half written?';
  const answer = await askSession.askSession({ runner: cli, commonDir, sessionId: HANDED_OFF, question });
  assert.equal(answer, ANSWER);
  assert.equal(cli.launches.length, 1);
  assert.equal(cli.launches[0]!.input, question, 'the question is the brief');
});

// The copy is resumed in the worktree the Session ran in, where Claude Code keeps its transcript.
test('gg ask-session asks a read-only copy of the Session, so the kept Session never changes', async (t) => {
  const { commonDir, worktree } = handedOffRecord(t);
  const cli = answering();
  await askSession.askSession({ runner: cli, commonDir, sessionId: HANDED_OFF, question: 'What remains?' });
  const [launch] = cli.launches;
  assert.ok(launch !== undefined, 'the question launched the CLI');
  assert.equal(flagValue(launch.args, '--resume'), HANDED_OFF);
  assert.ok(launch.args.includes('--fork-session'), JSON.stringify(launch.args));
  assert.ok(launch.args.includes('--restricted'), 'read-only, as the launch profile runs a reader');
  assert.equal(flagValue(launch.args, '--setting-sources'), '', 'under the launch profile');
  assert.equal(launch.cwd, worktree);
});

// The recorded parent of #479's read-only fork (`fork-kept-read-only`), the thread a Codex Agent handed off, and the
// thread that fork started.
const CODEX_HANDED_OFF = '01a20433-8960-76d2-bde3-f22e60ac0bf6';
const CODEX_FORK = '01a20551-86fe-7930-881d-6dafb458c91b';
const CODEX_FIXTURES = new URL('../fixtures/codex/', import.meta.url);

// Ticket 9's Execution Record, whose review Action on Codex handed CODEX_HANDED_OFF off, with that thread's recorded
// rollout in gg's Codex home, which GG_HOME holds for the case.
function codexHandedOffRecord(t: TestContext) {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-ask-session-');
  caseEnv.caseEnv(t, { GG_HOME: join(commonDir, 'gg-home') });
  const sessions = join(codex.codexHome(), 'sessions', '2026', '11', '22');
  mkdirSync(sessions, { recursive: true });
  const keptRollout = join(sessions, `rollout-2026-11-22T12-00-16-${CODEX_HANDED_OFF}.jsonl`);
  copyFileSync(new URL('fork-unflagged-parent.rollout.jsonl', CODEX_FIXTURES), keptRollout);
  const executionRecord = record.createExecutionRecord({
    commonDir,
    repository: 'o/r',
    ticket: 9,
    epic: 1,
    flow: { name: 'default', entry: 'implement' },
    configHash: 'abc123',
    run: 'run-1',
    worktree: join(commonDir, 'wt'),
    branch: 'ticket/9',
    base: 'main',
  });
  const cumulativeUsage = contract.emptyUsage(codex.capabilities);
  executionRecord.sessions['review/1/review'] = {
    sessionId: 'thread-current',
    harness: 'codex',
    personaHash: 'b'.repeat(64),
    transcriptPath: null,
    cumulativeUsage,
    vertex: 'review',
    model: 'gpt-6-luna',
    effort: 'low',
    personaName: 'reviewer.md',
    handedOff: [{ sessionId: CODEX_HANDED_OFF, transcriptPath: keptRollout, cumulativeUsage, attempt: 1 }],
  };
  stateDatabase.save(executionRecord);
  return { commonDir, worktree: executionRecord.worktree, keptRollout };
}

// The recorded Codex CLI, its model call answering as #479's read-only fork did, with the structured answer a question
// gets in its -o file; and, as Codex does, a resume appending to its thread's rollout and a fork writing a rollout of
// its own beside it, leaving its parent's unchanged (`fork.json` evidence.forkedRollout).
function codexAnswering() {
  const cli = recordedCodexCli.recordedCodexCli();
  const launch = async (options: exec.LaunchOptions) => {
    const ended = await cli.launch(options);
    const { args } = options;
    if (args[0] !== 'exec') return ended;
    writeFileSync(args[args.indexOf('-o') + 1]!, JSON.stringify({ answer: ANSWER }));
    const sessions = join(codex.codexHome(), 'sessions', '2026', '11', '22');
    if (args.includes('resume'))
      appendFileSync(join(sessions, `rollout-2026-11-22T12-00-16-${args[args.indexOf('resume') + 1]}.jsonl`), '{}\n');
    if (args.includes('fork'))
      copyFileSync(
        new URL('fork-kept-read-only.rollout.jsonl', CODEX_FIXTURES),
        join(sessions, `rollout-2026-11-22T17-12-39-${CODEX_FORK}.jsonl`),
      );
    return ended;
  };
  return { launch, childInJob: cli.childInJob, launches: cli.launches };
}

// DoD (#485 branch 1), ADR 0029 point 6 and #479 D18 A: each question forks the kept thread read-only in the worktree
// it ran in, so neither question sees the other and the kept thread's rollout never changes. Every model call gg
// ask-session starts is such a fork: `-s read-only` and `-C <worktree>` before `fork <thread>`, and no resume.
test('two questions to a handed-off Codex thread leave it unchanged', async (t) => {
  const { commonDir, worktree, keptRollout } = codexHandedOffRecord(t);
  const kept = readFileSync(keptRollout, 'utf8');
  const cli = codexAnswering();
  const questions = ['Which file did you leave half written?', 'Which test did you not run?'];
  for (const question of questions)
    assert.equal(
      await askSession
        .askSession({ runner: cli, commonDir, sessionId: CODEX_HANDED_OFF, question })
        .catch((err: unknown) => (err as Error).message),
      ANSWER,
    );
  const calls = cli.launches.filter(({ args }) => args[0] === 'exec');
  assert.equal(calls.length, 2, JSON.stringify(cli.launches.map(({ args }) => args)));
  for (const [index, { args, input, env }] of calls.entries()) {
    const fork = args.indexOf('fork');
    assert.ok(fork > 0, `question ${index + 1} forks: ${JSON.stringify(args)}`);
    assert.equal(args[fork + 1], CODEX_HANDED_OFF, `question ${index + 1} forks the kept thread, not an earlier fork`);
    assert.ok(!args.includes('resume'), `question ${index + 1} resumes no thread: ${JSON.stringify(args)}`);
    const before = args.slice(0, fork);
    assert.equal(flagValue(before, '-s'), 'read-only', `-s read-only before fork: ${JSON.stringify(args)}`);
    assert.equal(flagValue(before, '-C'), worktree, `-C <worktree> before fork: ${JSON.stringify(args)}`);
    assert.equal(env?.CODEX_HOME, codex.codexHome(), "in gg's Codex home");
    assert.ok(input?.includes(questions[index]!), `question ${index + 1} is the brief`);
    assert.ok(!input?.includes(questions[1 - index]!), `question ${index + 1} does not see the other`);
  }
  assert.equal(readFileSync(keptRollout, 'utf8'), kept, "the kept thread's rollout is unchanged");
});

test('gg ask-session refuses a Session no agent handed off, starting nothing', async (t) => {
  const { commonDir } = handedOffRecord(t);
  const cli = answering();
  for (const sessionId of [CURRENT, 'session-unknown'])
    await assert.rejects(
      askSession.askSession({ runner: cli, commonDir, sessionId, question: 'What remains?' }),
      new RegExp(`${sessionId} is not a Session an agent handed off`),
    );
  assert.deepEqual(cli.launches, []);
});
