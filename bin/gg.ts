#!/usr/bin/env node
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
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
import * as stateDatabase from '../lib/state-database/index.ts';
import * as report from '../lib/validate/report.ts';
import * as work from '../lib/work.ts';

// A command: its usage line, the flags it takes, and what runs it; one with no `run` is not implemented.
interface Command {
  summary: string;
  flags?: options.OptionSpec;
  run?: (parsed: options.ParsedOptions, gh: github.Gh) => Promise<void>;
}

// What a Run reaches outside itself, built once here and passed down as one `deps`; a test passes fakes in their place
// (ADR 0019).
const realDeps = (gh: github.Gh): interpreter.Deps => ({
  gh,
  git: git.createGit(),
  exec: exec.createExec({ kernel32: containment.openKernel32() }),
  locks: locks.createLocks(),
  database: stateDatabase.createStateDatabase(),
  clock: clock.WALL_CLOCK,
});

// The repository a command acts on: the one --repo names, else the one holding the current directory. Node reports a
// working directory that is missing or a file as `spawn git ENOENT`, as if git were missing, so gg names it first.
function repositoryPath(parsed: options.ParsedOptions) {
  const path = resolve((parsed.repo as string | undefined) ?? process.cwd());
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true)
    throw new Error(`--repo ${path}: not a directory`);
  return path;
}

function runCommand(parsed: options.ParsedOptions, gh: github.Gh) {
  return runTickets(parsed, gh, options.positiveInteger(parsed._[0], 'ticket'));
}

// gg run over `target`, and gg work resume, which re-enters its Ticket first (Q3 A).
async function runTickets(parsed: options.ParsedOptions, gh: github.Gh, target: number, resume?: { vertex: string }) {
  const deps = realDeps(gh);
  const { mainRoot } = await deps.git.repoInfo(repositoryPath(parsed));
  const harnesses = (await import('../lib/harnesses/shipped.ts')).shipped(deps.exec);
  const results = await run.runTarget({
    deps,
    target,
    flow: parsed.flow as string | undefined,
    config: config.loadSources(mainRoot),
    harnesses,
    protectedPaths: interpreter.protectedFiles(harnesses),
    cwd: mainRoot,
    log: (line) => process.stdout.write(`${line}\n`),
    ...(resume && { resume }),
  });
  process.exitCode = run.runExitCode(results);
}

async function initCommand(parsed: options.ParsedOptions) {
  const { mainRoot, gitCommonDir } = await git.repoInfo(repositoryPath(parsed));
  const baseBranch = await git.defaultBranch(mainRoot);
  const harness = parsed.harness as string | undefined;
  process.stdout.write(doctor.init(mainRoot, { baseBranch, commonDir: gitCommonDir, harness }));
}

async function doctorCommand(parsed: options.ParsedOptions, gh: github.Gh) {
  const { mainRoot, gitCommonDir } = await git.repoInfo(repositoryPath(parsed));
  const runner = exec.createExec({ kernel32: containment.openKernel32() });
  const harnesses = (await import('../lib/harnesses/shipped.ts')).shipped(runner);
  const { text, exitCode } = await doctor.doctor({
    config: config.loadSources(mainRoot),
    harnesses,
    gh,
    cwd: mainRoot,
    commonDir: gitCommonDir,
    probe: parsed.probe === true,
  });
  process.stdout.write(text);
  process.exitCode = exitCode;
}

// gg work's verbs: abandon forgets a Ticket's position and keeps its worktree (request 3.5); done and resume let a
// person resolve or hand back a stopped Ticket (L12); the rest wait for gg work.
const WORK_VERBS = ['list', 'resume', 'done', 'abandon', 'reset', 'approve'];

async function workCommand(parsed: options.ParsedOptions, gh: github.Gh) {
  const [verb, ticket] = parsed._;
  if (!WORK_VERBS.includes(verb as string))
    throw new options.UsageError(`work takes a verb, one of ${WORK_VERBS.join(', ')}`);
  if (!['abandon', 'done', 'resume'].includes(verb as string)) {
    process.stderr.write(`gg work ${verb}: not implemented\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.close !== undefined && verb !== 'done') throw new options.UsageError('--close is for work done only');
  if (parsed.at !== undefined && verb !== 'resume') throw new options.UsageError('--at is for work resume only');
  const target = options.positiveInteger(ticket, 'ticket');
  if (verb === 'resume') {
    if (typeof parsed.at !== 'string') throw new options.UsageError('work resume takes --at <vertex>');
    return runTickets(parsed, gh, target, { vertex: parsed.at });
  }
  const { mainRoot, gitCommonDir } = await git.repoInfo(repositoryPath(parsed));
  const { repository, repositoryFile } = config.loadSources(mainRoot);
  const problems = settingsModule.labelPrefixProblems(repository.labelPrefix, repositoryFile);
  if (problems.length) throw new Error(problems.map((problem) => report.line('error', problem)).join('\n'));
  const where = {
    ticket: target,
    commonDir: gitCommonDir,
    cwd: mainRoot,
    labelPrefix: repository.labelPrefix as string,
  };
  const text =
    verb === 'done'
      ? await work.done({
          ...where,
          deps: { ...realDeps(gh), locks: locks.createLocks() },
          close: parsed.close === true,
          log: (line) => process.stdout.write(`${line}\n`),
        })
      : await work.abandon({ ...where, gh, locks: locks.createLocks() });
  process.stdout.write(text);
}

// gg ask-session: a question to a Session an agent handed off past its contextBudget (#430 Q1 A).
async function askSessionCommand(parsed: options.ParsedOptions) {
  const [sessionId, question] = parsed._;
  if (!sessionId || !question) throw new options.UsageError('ask-session takes a handed-off Session and a question');
  const { gitCommonDir } = await git.repoInfo(repositoryPath(parsed));
  const { askSession } = await import('../lib/harnesses/ask-session.ts');
  const runner = exec.createExec({ kernel32: containment.openKernel32() });
  process.stdout.write(`${await askSession({ runner, commonDir: gitCommonDir, sessionId, question })}\n`);
}

const COMMANDS: Record<string, Command> = {
  init: {
    summary: "write the example into the repository and the user's gg.json; --harness <name> names each Agent's",
    flags: { values: ['harness', 'repo'] },
    run: initCommand,
  },
  doctor: {
    summary: 'validate the configuration and print each Resolved Flow; --probe adds the model probes',
    flags: { bools: ['probe'], values: ['repo'] },
    run: doctorCommand,
  },
  plan: {
    summary: 'produce the Plan for an Epic; plan --finish <planId> finishes one',
    flags: { bools: ['bg'], values: ['name', 'session', 'replan', 'finish'] },
  },
  publish: { summary: 'publish Tickets from a Plan' },
  run: {
    summary: 'carry Tickets through the default Flow, or the one --flow <name> names',
    flags: { values: ['flow', 'repo'] },
    run: runCommand,
  },
  work: {
    summary:
      'abandon <ticket> forgets its Execution Record; done <ticket> [--close] resolves it by hand; resume <ticket> ' +
      '--at <vertex> hands it back; list, reset, approve',
    flags: { bools: ['close'], values: ['at', 'repo'] },
    run: workCommand,
  },
  'ask-session': {
    summary: 'ask-session <session> <question> asks a Session an agent handed off, through a read-only copy of it',
    flags: { values: ['repo'] },
    run: askSessionCommand,
  },
  trace: { summary: 'export a Trajectory' },
  stats: {
    summary: 'show usage and outcome statistics',
    flags: { bools: ['refresh', 'by-label', 'json'], values: ['label'] },
  },
};

const usage = `Usage: gg <command>

Commands:
${Object.entries(COMMANDS)
  .map(([name, { summary, run: runs }]) => `  ${name.padEnd(13)}${summary}${runs ? '' : ' (not implemented)'}\n`)
  .join('')}
init, doctor, run, work and ask-session act on the repository holding the current directory, or the one
--repo <path> names.
`;

// gg with `argv` after its own path, over `gh`: the entry point passes the real gh, and the tests that spawn gg pass
// the fake one, since no test runs the real gh (#372). stub (#481): `harnesses` joins the shipped Harnesses by name, so
// the tests that spawn gg run their Agents on a stand-in that starts no CLI (F4).
export async function main(
  argv: string[],
  gh: github.Gh,
  _harnesses: Record<string, Record<string, unknown>> = {},
): Promise<void> {
  const name = argv[0];
  if (name === undefined || name === '--help') {
    process.stdout.write(usage);
  } else if (Object.hasOwn(COMMANDS, name)) {
    const command = COMMANDS[name];
    try {
      const parsed = options.parseOptions(argv.slice(1), command.flags ?? {});
      if (command.run) await command.run(parsed, gh);
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
}

if (import.meta.main) await main(process.argv.slice(2), github.createGh());
