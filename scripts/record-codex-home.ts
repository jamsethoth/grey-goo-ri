// What a scripts/record-codex.ts call may change in the CODEX_HOME it runs under (#479): the hooks.json a hook
// scenario puts there, and any config.toml the call writes (hook trust, say), each put back as it was after the call,
// with what changed kept as evidence. Nothing else in CODEX_HOME is read, so its login never reaches a fixture.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function guard(home: string, hooks: object | null) {
  const config = join(home, 'config.toml');
  const hooksFile = join(home, 'hooks.json');
  const configBefore = existsSync(config) ? readFileSync(config, 'utf8') : null;
  if (hooks !== null) {
    if (existsSync(hooksFile)) throw new Error(`${hooksFile} exists: the recorder will not replace it`);
    writeFileSync(hooksFile, `${JSON.stringify({ hooks }, null, 2)}\n`);
  }
  return {
    restore() {
      if (hooks !== null) rmSync(hooksFile);
      const configAfter = existsSync(config) ? readFileSync(config, 'utf8') : null;
      if (configAfter === configBefore) return null;
      if (configBefore === null) rmSync(config);
      else writeFileSync(config, configBefore);
      return { configBefore, configAfter };
    },
  };
}

// The end of the newest log under CODEX_HOME/log, which request 3.2 tails on a non-zero exit.
export function logTail(home: string) {
  const logs = join(home, 'log');
  if (!existsSync(logs)) return null;
  const newest = readdirSync(logs)
    .map((name) => join(logs, name))
    .filter((path) => statSync(path).isFile())
    .toSorted((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  return newest === undefined ? null : readFileSync(newest, 'utf8').split('\n').slice(-40).join('\n');
}
