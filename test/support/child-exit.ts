import type { ChildProcess } from 'node:child_process';

export interface ChildExit {
  code: number | null;
  err: string;
  // Present only when the process's stdout is piped.
  stdout?: string;
}

// A spawned process's exit code and what it wrote to stderr, and to stdout when that is piped too, once it has closed.
// Both are read as UTF-8 text, so a character split across two chunks stays whole. Call it right after the spawn, with
// stderr piped, so no output is missed.
export function exitOf(child: ChildProcess): Promise<ChildExit> {
  const output = { err: '', stdout: '' };
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output.err += chunk;
  });
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  return new Promise((resolve) =>
    child.on('close', (code: number | null) =>
      resolve({ code, err: output.err, ...(child.stdout && { stdout: output.stdout }) }),
    ),
  );
}
