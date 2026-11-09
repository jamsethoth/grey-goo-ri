#!/usr/bin/env node
import * as clock from '../lib/clock.ts';
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
import * as settingsModule from '../lib/settings.ts';
import * as report from '../lib/validate/report.ts';
import * as work from '../lib/work.ts';

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
  clock: clock.WALL_CLOCK,
});

async function runCommand(parsed: options.ParsedOptions) {
  const target = options.positiveInteger(parsed._[0], 'ticket');
  const deps = realDeps();
  const { mainRoot } = await deps.git.repoInfo(process.cwd());
  const { HARNESSES: harnesses } = await import('../lib/harnesses/shipped.ts');
  const results = await run.runTarget({
    deps,
    target,
    flow: parsed.flow as string | undefined,
    config: config.loadSources(mainRoot),
    harnesses,
    protectedPaths: interpreter.protectedFiles(harnesses),
    cwd: mainRoot,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = run.runExitCode(results);
}

// shortcut: the main checkout's branch stands for the repository's default branch; read origin's HEAD when gg init
// runs where the two differ.
async function initCommand(parsed: options.ParsedOptions) {
  const { mainRoot } = await git.repoInfo(process.cwd());
  const baseBranch = (await git.currentBranch(mainRoot)) ?? 'main';
  process.stdout.write(doctor.init(mainRoot, { baseBranch, harness: parsed.harness as string | undefined }));
}

async function doctorCommand() {
  const { mainRoot, gitCommonDir } = await git.repoInfo(process.cwd());
  const { HARNESSES: harnesses } = await import('../lib/harnesses/shipped.ts');
  const { text, exitCode } = await doctor.doctor({
    config: config.loadSources(mainRoot),
    harnesses,
    gh: github.createGh(),
    cwd: mainRoot,
    commonDir: gitCommonDir,
  });
  process.stdout.write(text);
  process.exitCode = exitCode;
}

// gg work's verbs: abandon forgets a Ticket's position and keeps its worktree (request 3.5); the rest wait for gg work.
const WORK_VERBS = ['list', 'resume', 'done', 'abandon', 'reset', 'approve'];

async function workCommand(parsed: options.ParsedOptions) {
  const [verb, ticket] = parsed._;
  if (!WORK_VERBS.includes(verb as string))
    throw new options.UsageError(`work takes a verb, one of ${WORK_VERBS.join(', ')}`);
  if (verb !== 'abandon') {
    process.stderr.write(`gg work ${verb}: not implemented\n`);
    process.exitCode = 1;
    return;
  }
  const target = options.positiveInteger(ticket, 'ticket');
  const { mainRoot, gitCommonDir } = await git.repoInfo(process.cwd());
  const { repository, repositoryFile } = config.loadSources(mainRoot);
  const problems = settingsModule.labelPrefixProblems(repository.labelPrefix, repositoryFile);
  if (problems.length) throw new Error(problems.map((problem) => report.line('error', problem)).join('\n'));
  const text = await work.abandon({
    ticket: target,
    commonDir: gitCommonDir,
    cwd: mainRoot,
    labelPrefix: repository.labelPrefix as string,
    gh: github.createGh(),
    locks: locks.createLocks(),
  });
  process.stdout.write(text);
}

const COMMANDS: Record<string, Command> = {
  init: {
    summary: "write the example into the repository and the user's gg.json; --harness <name> names each Agent's",
    flags: { values: ['harness'] },
    run: initCommand,
  },
  doctor: { summary: 'validate the configuration and print each Resolved Flow', run: doctorCommand },
  plan: {
    summary: 'produce the Plan for an Epic; plan --finish <planId> finishes one',
    flags: { bools: ['bg'], values: ['name', 'session', 'replan', 'finish'] },
  },
  publish: { summary: 'publish Tickets from a Plan' },
  run: {
    summary: 'carry Tickets through the default Flow, or the one --flow <name> names',
    flags: { values: ['flow'] },
    run: runCommand,
  },
  work: { summary: 'abandon <ticket> forgets its Execution Record; list, resume, reset, approve', run: workCommand },
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
