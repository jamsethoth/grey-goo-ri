#!/usr/bin/env node
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

const commands = ['init', 'doctor', 'plan', 'publish', 'run', 'work', 'trace', 'stats'];
const command = process.argv[2];

if (command === undefined || command === '--help') {
  process.stdout.write(usage);
} else if (commands.includes(command)) {
  process.stderr.write(`gg ${command}: not implemented\n`);
  process.exitCode = 1;
} else {
  process.stderr.write(`gg: unknown command ${command}\n\n${usage}`);
  process.exitCode = 1;
}
