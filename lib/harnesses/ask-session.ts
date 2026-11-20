// gg ask-session (#430, Q1 A): a question to a Session an agent handed off past its contextBudget, found on its
// Execution Record and asked through a copy of it, read-only under the launch profile, so the kept Session never
// changes.
import type * as exec from '../exec.ts';

export interface AskSessionOptions {
  // What starts the CLI, which bin/gg.ts builds (ADR 0019).
  runner: Pick<exec.Exec, 'launch'>;
  // The repository's git common directory, which holds the State Database.
  commonDir: string;
  sessionId: string;
  question: string;
  // Claude Code's configuration directory, where it keeps the Session's transcript.
  configDirectory?: string;
}

// The handed-off Session's answer to the question. Stub until #430's Green.
export async function askSession(options: AskSessionOptions): Promise<string> {
  void options;
  return Promise.resolve('');
}
