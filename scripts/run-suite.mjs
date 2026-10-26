// The one command Codex may run outside its sandbox (ADR 0010). It takes a stage from a closed set (ADR 0016) and drops
// every environment variable that could make node load other code.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const USAGE = `usage: node scripts/run-suite.mjs [fast [boundary ...]]
  no arguments: the full suite
  fast: test/unit/, plus test/contract/<boundary>/ for each boundary named`;

export class UsageError extends Error {
  constructor() { super(USAGE); this.name = 'UsageError'; }
}

// No arguments is the full stage. `fast` is test/unit/ plus the named contract suites, whose paths are built from the
// directory names on disk, never from the argument text.
function stage(argv) {
  if (argv.length === 0) return [];
  if (argv[0] !== 'fast') throw new UsageError();
  const boundaries = readdirSync(join(root, 'test', 'contract'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  return ['test/unit/**/*.test.mjs', ...argv.slice(1).map((arg) => {
    const name = boundaries.find((b) => b === arg);
    if (!name) throw new UsageError();
    return `test/contract/${name}/**/*.test.mjs`;
  })];
}

export function suiteCommand(env, argv) {
  const files = stage(argv);
  const kept = Object.entries(env).filter(([key]) => {
    const k = key.toUpperCase(); // Windows environment keys are case-insensitive
    return k !== 'NODE_OPTIONS' && k !== 'NODE_PATH' && !k.startsWith('NPM_CONFIG_');
  });
  // Saturating the machine slows every test: on a 20-core machine the suite took 680 s at 2 files at once, 440 s at 4,
  // 345 s at 8 and 339 s at 12 (grey-goo-ri issue #143), against 652 s at the default 19 (grey-goo-ri PR #141). Small CI
  // runners keep their default of one fewer than their cores.
  const concurrency = Math.min(12, Math.max(1, availableParallelism() - 1));
  return { command: process.execPath, args: ['--test', `--test-concurrency=${concurrency}`, ...files], cwd: root, env: Object.fromEntries(kept) };
}

const self = fileURLToPath(import.meta.url);
const entry = process.argv[1] && resolve(process.argv[1]);
if (entry && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self)) {
  let cmd;
  try {
    cmd = suiteCommand(process.env, process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
  const child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: 'inherit', shell: false });
  child.on('error', (err) => { console.error(err.message); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
}
