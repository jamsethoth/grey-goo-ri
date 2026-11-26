// What every Harness's doctor does with its Agent CLI (#480): start one of its commands and say what it printed, check
// its version against a pinned minimum and its login, under the cheap and probe wall limits, and run a probe in a
// temporary directory. Which commands, and what their output means beyond that, is each Harness's own.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as exec from '../exec.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as runContext from '../run-context.ts';

type Runner = Pick<exec.Exec, 'launch'>;
type Check = runContext.DoctorCheck;

// The wall limits: a cheap command starts no model call; a probe makes one.
export const CHEAP_WALL_MS = 60_000;
export const PROBE_WALL_MS = 300_000;

// What one command printed: whether it started at all, its lines, why it did not finish when it did not, and its
// error exit.
export interface Said {
  started: boolean;
  lines: string[];
  failure: string | null;
  exited: string | null;
}

// A command to start: its executable and argv, how its failures name it (by default its whole command line), and the
// rest of a launch; wallMs defaults to the cheap limit.
export interface SaidOptions extends Omit<exec.LaunchOptions, 'onLine'> {
  name?: string;
}

export async function said(runner: Runner, { name, ...options }: SaidOptions): Promise<Said> {
  const lines: string[] = [];
  try {
    const ended = await runner.launch({ wallMs: CHEAP_WALL_MS, ...options, onLine: (line) => lines.push(line) });
    // On POSIX a crash ends by a signal, with no code.
    const command = name ?? [options.command, ...options.args].join(' ');
    const failure = ended.timedOut ? `${command} timed out` : null;
    const exited = ended.code
      ? `${command} exited ${ended.code}`
      : ended.signal && `${command} ended by ${ended.signal}`;
    return { started: true, lines, failure, exited };
  } catch (err) {
    return { started: false, lines, failure: (err as Error).message, exited: null };
  }
}

export const passed = (name: string, message: string): Check => ({ name, ok: true, severity: 'error', message });

export const failed = (name: string, message: string, severity: Check['severity'] = 'error'): Check => ({
  name,
  ok: false,
  severity,
  message,
});

// Why a command failed: it did not finish, else its error exit.
export const reasonOf = ({ failure, exited }: Said): string | null => failure ?? exited;
const becauseOf = (ran: Said) => (reasonOf(ran) === null ? '' : `: ${reasonOf(ran)}`);

// Each part of a version compared as a number, so 2.10.0 is newer than 2.9.1.
export function atLeastMinimum(version: string, minimum: string): boolean {
  const [found, least] = [version, minimum].map((text) => text.split('.').map(Number)) as [number[], number[]];
  const index = found.findIndex((part, position) => part !== least[position]);
  return index === -1 || found[index]! > least[index]!;
}

// The version a CLI's --version printed, against the pinned minimum, and how to update it when older. The version
// starts the first line; a first line that starts with anything else gives none.
export function versionCheck(ran: Said, cli: { command: string; minimum: string; update: string }): Check {
  const version = /^\d+\.\d+\.\d+/.exec(ran.lines[0] ?? '')?.[0];
  if (version === undefined)
    return failed(
      'version',
      `${cli.command} --version printed ${JSON.stringify(ran.lines.join('\n'))}${becauseOf(ran)}`,
    );
  return atLeastMinimum(version, cli.minimum)
    ? passed('version', `${cli.command} ${version}`)
    : failed(
        'version',
        `${cli.command} ${version} is older than the minimum ${cli.minimum}: update it with ${cli.update}`,
      );
}

// The login a CLI's status command reported: loggedIn is null when the Harness could not read it, `unreadable` says
// what it printed instead, and `login` is the command that logs in.
export function loginCheck(
  ran: Said,
  status: { command: string; loggedIn: boolean | null; unreadable: string; login: string },
): Check {
  if (status.loggedIn === null) return failed('login', `${status.unreadable}${becauseOf(ran)}`);
  return status.loggedIn
    ? passed('login', `${status.command} is logged in`)
    : failed('login', `${status.command} is not logged in: log in with ${status.login}`);
}

// The shell a Harness would start on win32: the first `file` on `path`, and whether it is a packaged app, under
// \WindowsApps\, which Windows starts outside gg's job (ADR 0030); null when no directory on `path` holds it.
export interface FoundShell {
  path: string;
  packaged: boolean;
}

// Stub (#484 Red): the PATH walk is Green's.
export const findShell = (_file: string, _path: string = process.env.PATH ?? ''): FoundShell | null => null;

// A temporary directory for a probe, named from `prefix`, removed after it; on Windows a CLI just ended may hold it for
// a moment.
export async function inTemporary<T>(prefix: string, use: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
}

// The lines of a stream that are JSON objects, as the CLI sent them.
export const objectLines = (lines: string[]): Record<string, unknown>[] =>
  lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return referencePaths.isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
