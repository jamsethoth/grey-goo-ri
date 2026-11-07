#!/usr/bin/env node
import * as config from '../lib/config.ts';
import * as containment from '../lib/containment.ts';
import * as doctor from '../lib/doctor.ts';
import * as exec from '../lib/exec.ts';
import * as git from '../lib/git.ts';
import * as github from '../lib/github.ts';
import * as interpreter from '../lib/interpreter.ts';
import * as locks from '../lib/locks.ts';
import * as options from '../lib/options.ts';
import * as record from '../lib/record.ts';
import * as run from '../lib/run.ts';

// A command: its usage line, the flags it takes, and what runs it; one with no `run` is not implemented.
interface Command {
  summary: string;
  flags?: options.OptionSpec;
  run?: (parsed: options.ParsedOptions) => Promise<void>;
}

// What a Run reaches outside itself, built once here and passed down as one `deps`; a test passes fakes in their place
// (ADR 0019).
const realDeps = (): interpreter.Deps => ({
  gh: github.createGh(),
  git: git.createGit(),
  exec: exec.createExec({ kernel32: containment.openKernel32() }),
  locks: locks.createLocks(),
  database: record.createStateDatabase(),
  clock: interpreter.WALL_CLOCK,
});

async function runCommand(parsed: options.ParsedOptions) {
  const target = options.positiveInteger(parsed._[0], 'ticket');
  const deps = realDeps();
  const { mainRoot } = await deps.git.repoInfo(process.cwd());
  const { HARNESSES: harnesses } = await import('../lib/harnesses/shipped.ts');
  const results = await run.runTarget({
    deps,
    target,
    config: config.loadLayers(mainRoot),
    harnesses,
    protectedPaths: interpreter.protectedFiles(harnesses),
    cwd: mainRoot,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = run.runExitCode(results);
}

async function doctorCommand() {
  const { mainRoot } = await git.repoInfo(process.cwd());
  const { HARNESSES: harnesses } = await import('../lib/harnesses/shipped.ts');
  const { text, exitCode } = await doctor.doctor({
    config: config.loadLayers(mainRoot),
    harnesses,
    gh: github.createGh(),
    cwd: mainRoot,
  });
  process.stdout.write(text);
  process.exitCode = exitCode;
}

const COMMANDS: Record<string, Command> = {
  init: { summary: 'set up a repository for gg' },
  doctor: { summary: 'validate the configuration and print each Resolved Flow', run: doctorCommand },
  plan: {
    summary: 'produce the Plan for an Epic; plan --finish <planId> finishes one',
    flags: { bools: ['bg'], values: ['name', 'session', 'replan', 'finish'] },
  },
  publish: { summary: 'publish Tickets from a Plan' },
  run: { summary: 'carry Tickets through their Flow', run: runCommand },
  work: { summary: 'list, resume, abandon, reset, approve' },
  trace: { summary: 'export a Trajectory' },
  stats: {
    summary: 'show usage and outcome statistics',
    flags: { bools: ['refresh', 'by-label', 'json'], values: ['label'] },
  },
};

const usage = `Usage: gg <command>

Commands:
${Object.entries(COMMANDS)
  .map(([name, { summary, run: runs }]) => `  ${name.padEnd(10)}${summary}${runs ? '' : ' (not implemented)'}\n`)
  .join('')}`;

const name = process.argv[2];

if (name === undefined || name === '--help') {
  process.stdout.write(usage);
} else if (Object.hasOwn(COMMANDS, name)) {
  const command = COMMANDS[name];
  try {
    const parsed = options.parseOptions(process.argv.slice(3), command.flags ?? {});
    if (command.run) await command.run(parsed);
    else {
      process.stderr.write(`gg ${name}: not implemented\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    const { message, exitCode } = err as Error & { exitCode?: number };
    if (err instanceof options.UsageError) {
      process.stderr.write(`gg ${name}: ${message}\n\n${usage}`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`gg ${name}: ${message}\n`);
      process.exitCode = exitCode ?? 1;
    }
  }
} else {
  process.stderr.write(`gg: unknown command ${name}\n\n${usage}`);
  process.exitCode = 1;
}
