// Diagnostic only (branch diag/winjob-coldstart): where does the first runShell-with-timeout spend its time on Windows?
import { spawnSync } from 'node:child_process';
import * as exec from '../lib/exec.mjs';
const order = process.argv[2];
const t = async (label, fn) => { const s = performance.now(); await fn(); console.log(`${label}: ${Math.round(performance.now() - s)} ms`); };
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
const node = `"${process.execPath}" -e "process.stdin.resume(); process.stdin.on('end', () => console.log('eof'))"`;
const job = (i) => t(`runShell with timeout #${i}`, async () => { const r = await exec.runShell(node, { timeoutMs: 60000 }); if (r.timedOut || !/eof/.test(r.output)) throw new Error(JSON.stringify(r)); });
const steps = {
  job: async () => { for (const i of [1, 2, 3]) await job(i); },
  ps: async () => { for (const i of [1, 2]) await t(`powershell exit #${i}`, () => ps('exit 0')); },
  addtype: async () => { for (const i of [1, 2]) await t(`powershell Add-Type #${i}`, () => ps(`Add-Type -TypeDefinition 'public static class D${i} { public static int F() { return 1; } }'`)); },
};
console.log(`order: ${order}`);
for (const s of order.split(',')) await steps[s]();
