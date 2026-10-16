// The one command Codex may run outside its sandbox (ADR 0010): it ignores its arguments and every
// environment variable that could make node load other code.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function suiteCommand(env) {
  const kept = Object.entries(env).filter(([key]) => {
    const k = key.toUpperCase(); // Windows environment keys are case-insensitive
    return k !== 'NODE_OPTIONS' && k !== 'NODE_PATH' && !k.startsWith('NPM_CONFIG_');
  });
  return { command: process.execPath, args: ['--test'], cwd: root, env: Object.fromEntries(kept) };
}

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] && resolve(process.argv[1]);
if (entry && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self)) {
  const { command, args, cwd, env } = suiteCommand(process.env);
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
  child.on('error', (err) => { console.error(err.message); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
}
