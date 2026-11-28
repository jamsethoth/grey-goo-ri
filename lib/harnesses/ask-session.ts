// gg ask-session (#430, Q1 A): a question to a Session an agent handed off past its contextBudget, found on its
// Execution Record and asked through a copy of it, read-only under the launch profile, so the kept Session never
// changes.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as exec from '../exec.ts';
import * as referencePaths from '../reference-paths.ts';
import * as stateDatabase from '../state-database/index.ts';
import * as shipped from './shipped.ts';

export interface AskSessionOptions {
  // What starts the CLI, which bin/gg.ts builds (ADR 0019).
  runner: Pick<exec.Exec, 'launch' | 'childInJob'>;
  // The repository's git common directory, which holds the State Database.
  commonDir: string;
  sessionId: string;
  question: string;
  // Claude Code's configuration directory, where it keeps the Session's transcript.
  configDirectory?: string;
}

const ACCESS = 'read-only';
const PERSONA = 'You answer a question about the work of this Session, from what it did, and change nothing.\n';
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

// The worktree a handed-off Session ran in, and the Agent's Harness, model and effort, from the Execution Record that
// keeps it.
function handedOff(commonDir: string, sessionId: string) {
  for (const executionRecord of stateDatabase.loadAll(commonDir, 'ticket'))
    for (const session of Object.values(executionRecord.sessions))
      if (session.handedOff?.some((kept) => kept.sessionId === sessionId))
        return { worktree: executionRecord.worktree, session };
  throw new Error(`${sessionId} is not a Session an agent handed off`);
}

// The handed-off Session's answer to the question.
export async function askSession(options: AskSessionOptions): Promise<string> {
  const { worktree, session } = handedOff(options.commonDir, options.sessionId);
  const { model, effort } = session;
  // The copy runs on the Harness the Session ran on (#485).
  const harness = Object.entries(shipped.HARNESSES).find(([name]) => name === session.harness)?.[1];
  if (harness === undefined) throw new Error(`${options.sessionId} ran on ${session.harness}, which gg does not ship`);
  const agent = { harness: harness.name, persona: 'ask-session.md', model, effort, access: ACCESS };
  const runDirectory = mkdtempSync(join(tmpdir(), 'gg-ask-session-'));
  try {
    const tools = harness.resolveTools(agent, { commands: {}, platform: process.platform });
    const cli = harness.createCli(options.runner, options.configDirectory === undefined ? {} : options);
    const call = {
      marker: 'ask-session',
      agent,
      persona: { name: agent.persona, bytes: PERSONA, hash: createHash('sha256').update(PERSONA).digest('hex') },
      schema: SCHEMA,
      resume: options.sessionId,
      fork: true,
      runDirectory,
      access: ACCESS,
      brief: options.question,
      cwd: worktree,
      previousUsage: null,
      tools,
      timeouts: {},
      env: {},
    };
    const hooks = { started: () => {}, signal: new AbortController().signal };
    const { response, failure } = await cli.run(call, hooks);
    const answer = referencePaths.isRecord(response) ? response.answer : undefined;
    if (typeof answer !== 'string') throw new Error(`${options.sessionId} gave no answer: ${failure?.message ?? ''}`);
    return answer;
  } finally {
    rmSync(runDirectory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
}
