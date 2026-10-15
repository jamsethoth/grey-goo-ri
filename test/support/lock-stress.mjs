// Stress loop for the locks suite, never run by npm test: `node test/support/lock-stress.mjs [copies] [rounds]`.
// Runs `copies` parallel copies of the suite `rounds` times and tallies the runs that report `# fail 0`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// node --test runs support files too; it sets NODE_TEST_CONTEXT, so the loop stays out of npm test.
if (!process.env.NODE_TEST_CONTEXT) {
  const [copies = 4, rounds = 25] = process.argv.slice(2).map(Number);
  const suite = fileURLToPath(new URL('../locks.test.mjs', import.meta.url));
  const runOnce = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', suite], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(/^# fail 0$/m.test(out) ? null : out));
  });
  let clean = 0;
  for (let round = 0; round < rounds; round++) {
    const failures = (await Promise.all(Array.from({ length: copies }, runOnce))).filter(Boolean);
    clean += copies - failures.length;
    for (const out of failures) process.stdout.write(`round ${round} failed:\n${out}\n`);
  }
  const total = copies * rounds;
  console.log(`${clean}/${total} runs reported # fail 0 (node ${process.version}, libuv ${process.versions.uv})`);
  process.exitCode = clean === total ? 0 : 1;
}
