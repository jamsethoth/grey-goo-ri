import type { TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Sets environment variables for every process the case starts until the case ends, at its timeout too, when the
// case's own code may still be running. A script runShell starts takes no arguments from the case, so it reads its
// inputs here and none of them becomes code. One after-hook per case restores each variable to its value before the
// case's first call: node runs a case's after-hooks first in, first out, so a hook per call would leave the first
// call's value.
const beforeCase = new WeakMap<TestContext, Record<string, string | undefined>>();

export function caseEnv(t: TestContext, vars: Record<string, string>) {
  let saved = beforeCase.get(t);
  if (saved === undefined) {
    const values: Record<string, string | undefined> = {};
    beforeCase.set(t, (saved = values));
    t.after(() => {
      for (const [key, value] of Object.entries(values))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
  }
  for (const key of Object.keys(vars)) if (!Object.hasOwn(saved, key)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
}

// Puts a stand-in ps running the sh body first on PATH until the case ends, from a directory named for it under
// directory. In the body, PATH="${PATH#*:}" finds the real ps.
export function psStandIn(t: TestContext, directory: string, name: string, body: string) {
  const bin = join(directory, `${name}-bin`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  caseEnv(t, { PATH: `${bin}:${process.env.PATH}` });
}
