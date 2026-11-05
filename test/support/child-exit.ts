import type { ChildProcess } from 'node:child_process';

export interface ChildExit {
  code: number | null;
  err: string;
}

// A spawned process's exit code and everything it wrote to stderr, once it has closed. Call it right after the spawn,
// with stderr piped, so no output is missed.
export function exitOf(child: ChildProcess): Promise<ChildExit> {
  let err = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk;
  });
  return new Promise((resolve) => child.on('close', (code: number | null) => resolve({ code, err })));
}
