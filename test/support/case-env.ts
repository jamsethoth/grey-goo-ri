import type { TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Sets environment variables for every process the case starts until the case ends, at its timeout too, when the
// case's own code may still be running. A script runShell starts takes no arguments from the case, so it reads its
// inputs here and none of them becomes code.
export function caseEnv(t: TestContext, vars: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}

// Puts a stand-in ps running the sh body first on PATH until the case ends, from a directory named for it under
// directory. In the body, PATH="${PATH#*:}" finds the real ps.
export function psStandIn(t: TestContext, directory: string, name: string, body: string) {
  const bin = join(directory, `${name}-bin`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  caseEnv(t, { PATH: `${bin}:${process.env.PATH}` });
}
