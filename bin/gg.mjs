#!/usr/bin/env node
import { loadConfig } from '../lib/config.mjs';
import * as doctor from '../lib/doctor.mjs';
import * as exec from '../lib/exec.mjs';
import * as git from '../lib/git.mjs';
import * as gh from '../lib/github.mjs';
import * as interpreter from '../lib/interpreter.mjs';
import { parseOpts, positiveInt, UsageError } from '../lib/opts.mjs';
import * as run from '../lib/run.mjs';

const usage = `Usage: gg <command>

Commands:
  init      set up a repository for gg
  doctor    check the environment and configuration
  plan      produce the Plan for an Epic; plan --finish <planId> finishes one
  publish   publish Tickets from a Plan
  run       carry Tickets through their Flow
  work      list, resume, abandon, reset, approve
  trace     export a Trajectory
  stats     show usage and outcome statistics
`;

const SPECS = {
  init: {},
  doctor: {},
  plan: { bools: ['bg'], values: ['name', 'session', 'replan', 'finish'] },
  publish: {},
  run: {},
  work: {},
  trace: {},
  stats: { bools: ['refresh', 'by-label', 'json'], values: ['label'] },
};
const command = process.argv[2];

async function runCommand(opts) {
  const target = positiveInt(opts._[0], 'ticket');
  const { mainRoot } = await git.repoInfo(process.cwd());
  const { HARNESSES: harnesses } = await import('../lib/harnesses/shipped.mjs');
  const results = await run.runTarget({ target, config: loadConfig(mainRoot), harnesses,
    protectedPaths: interpreter.protectedFiles(harnesses), gh, git, exec, cwd: mainRoot,
    log: (m) => process.stdout.write(`${m}\n`) });
  process.exitCode = run.runExitCode(results);
}

async function doctorCommand() {
  const { mainRoot } = await git.repoInfo(process.cwd());
  const { HARNESSES: harnesses } = await import('../lib/harnesses/shipped.mjs');
  const { text, exitCode } = doctor.doctor({ config: loadConfig(mainRoot), harnesses });
  process.stdout.write(text);
  process.exitCode = exitCode;
}

function notImplemented(name, opts) {
  process.stderr.write(`gg ${name}: not implemented\n`);
  process.exitCode = 1;
}

if (command === undefined || command === '--help') {
  process.stdout.write(usage);
} else if (Object.hasOwn(SPECS, command)) {
  try {
    const opts = parseOpts(process.argv.slice(3), SPECS[command]);
    if (command === 'run') await runCommand(opts);
    else if (command === 'doctor') await doctorCommand();
    else notImplemented(command, opts);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`gg ${command}: ${e.message}\n\n${usage}`);
      process.exitCode = 1;
    } else if (command === 'run') {
      process.stderr.write(`gg run: ${e.message}\n`);
      process.exitCode = e.exitCode ?? 1;
    } else throw e;
  }
} else {
  process.stderr.write(`gg: unknown command ${command}\n\n${usage}`);
  process.exitCode = 1;
}
