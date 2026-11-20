import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as askSession from '../../lib/harnesses/ask-session.ts';
import * as claude from '../../lib/harnesses/claude.ts';
import * as contract from '../../lib/harnesses/contract.ts';
import * as record from '../../lib/record.ts';
import * as stateDatabase from '../../lib/state-database/index.ts';
import * as recordedCli from '../support/recorded-cli.ts';
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
