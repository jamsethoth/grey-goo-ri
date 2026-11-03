#!/usr/bin/env node
import { loadConfig } from '../lib/config.mjs';
import * as containment from '../lib/containment.ts';
import * as doctor from '../lib/doctor.mjs';
import * as exec from '../lib/exec.ts';
import * as git from '../lib/git.ts';
import * as github from '../lib/github.ts';
import * as interpreter from '../lib/interpreter.mjs';
import * as locks from '../lib/locks.ts';
import { parseOpts, positiveInt, UsageError } from '../lib/opts.mjs';
import * as record from '../lib/record.ts';
import * as run from '../lib/run.mjs';

const usage = `Usage: gg <command>

Commands:
  init      set up a repository for gg (not implemented)
  doctor    validate the configuration and print each Resolved Flow
  plan      produce the Plan for an Epic; plan --finish <planId> finishes one (not implemented)
  publish   publish Tickets from a Plan (not implemented)
  run       carry Tickets through their Flow
  work      list, resume, abandon, reset, approve (not implemented)
  trace     export a Trajectory (not implemented)
  stats     show usage and outcome statistics (not implemented)
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

// What a Run reaches outside itself, built once here and passed down as named options; a test passes fakes in their
// place (ADR 0019).
const realDeps = () => ({
  gh: github.createGh(),
  git: git.createGit(),
  exec: exec.createExec({ kernel32: containment.openKernel32() }),
  locks: locks.createLocks(),
  database: record.stateDatabase(),
  clock: interpreter.WALL_CLOCK,
});

async function runCommand(opts) {
  const target = positiveInt(opts._[0], 'ticket');
  const deps = realDeps();
  const { mainRoot } = await deps.git.repoInfo(process.cwd());
  const { HARNESSES: harnesses } = await import('../lib/harnesses/shipped.mjs');
  const results = await run.runTarget({
    ...deps,
    target,
    config: loadConfig(mainRoot),
    harnesses,
    protectedPaths: interpreter.protectedFiles(harnesses),
    cwd: mainRoot,
    log: (m) => process.stdout.write(`${m}\n`),
  });
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
    } else {
      process.stderr.write(`gg ${command}: ${e.message}\n`);
      process.exitCode = e.exitCode ?? 1;
    }
  }
} else {
  process.stderr.write(`gg: unknown command ${command}\n\n${usage}`);
  process.exitCode = 1;
}
