#!/usr/bin/env node
import { parseOpts, UsageError } from '../lib/opts.mjs';

const usage = `Usage: gg <command>

Commands:
  init      set up a repository for gg
  doctor    check the environment and configuration
  plan      produce the Plan for an Epic
  publish   publish Tickets from a Plan
  run       carry Tickets through their Flow
  work      list, resume, abandon, reset, approve
  trace     export a Trajectory
  stats     show usage and outcome statistics
`;

const SPECS = {
  init: {},
  doctor: {},
  plan: { bools: ['bg'], values: ['name', 'session', 'replan'], optional: ['finish'] },
  publish: {},
  run: {},
  work: {},
  trace: {},
  stats: { bools: ['refresh', 'by-label', 'json'], values: ['label'] },
};
const command = process.argv[2];

function notImplemented(name, opts) {
  process.stderr.write(`gg ${name}: not implemented\n`);
  process.exitCode = 1;
}

if (command === undefined || command === '--help') {
  process.stdout.write(usage);
} else if (Object.hasOwn(SPECS, command)) {
  try {
    // An omitted bools would fall back to the parser's legacy boolean flags.
    notImplemented(command, parseOpts(process.argv.slice(3), { bools: [], ...SPECS[command] }));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`gg ${command}: ${e.message}\n\n${usage}`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`gg: unknown command ${command}\n\n${usage}`);
  process.exitCode = 1;
}
