// Stress loop for the locks suite, never run by npm test: `node test/support/lock-stress.ts [copies] [rounds]`.
// Runs `copies` parallel copies of the suite `rounds` times and tallies the runs that report `# fail 0`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A run is clean only when it exited 0 by itself and its TAP summary shows passing tests and no failures.
export const passed = (code: number | null, signal: NodeJS.Signals | null, output: string): boolean =>
  code === 0 && signal === null && /^# fail 0$/m.test(output) && /^# pass [1-9]/m.test(output);

const suite = fileURLToPath(new URL('../contract/sqlite/locks.test.mjs', import.meta.url));

function runOnce(): Promise<{ clean: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', suite], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.on('error', (error) => resolve({ clean: false, output: `${output}spawn error: ${error.message}` }));
    child.on('close', (code, signal) =>
      resolve({ clean: passed(code, signal, output), output: `${output}exit ${code}, signal ${signal}` }),
    );
  });
}

// node --test runs support files too; it sets NODE_TEST_CONTEXT, so the loop stays out of npm test.
if (!process.env.NODE_TEST_CONTEXT) {
  const [copies = 4, rounds = 25] = process.argv.slice(2).map(Number);
  let cleanRuns = 0;
  for (let round = 0; round < rounds; round++) {
    const results = await Promise.all(Array.from({ length: copies }, runOnce));
    for (const { clean, output } of results) {
      if (clean) cleanRuns++;
      else process.stdout.write(`round ${round} failed:\n${output}\n`);
    }
  }
  const total = copies * rounds;
  console.log(`${cleanRuns}/${total} runs reported # fail 0 (node ${process.version}, libuv ${process.versions.uv})`);
  process.exitCode = cleanRuns === total ? 0 : 1;
}
