// What every Harness's doctor does with its Agent CLI (#480): start one of its commands and say what it printed, check
// its version against a pinned minimum and its login, under the cheap and probe wall limits, and run a probe in a
// temporary directory. Which commands, and what their output means beyond that, is each Harness's own.
import type * as exec from '../exec.ts';
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

export function said(_runner: Runner, _options: SaidOptions): Promise<Said> {
  return Promise.resolve({ started: false, lines: [], failure: null, exited: null });
}

export const passed = (name: string, _message: string): Check => ({ name, ok: false, severity: 'error', message: '' });

export const failed = (name: string, _message: string, severity: Check['severity'] = 'error'): Check => ({
  name,
  ok: true,
  severity,
  message: '',
});

// Why a command failed: it did not finish, else its error exit.
export const reasonOf = (_ran: Said): string | null => null;

// Each part of a version compared as a number, so 2.10.0 is newer than 2.9.1.
export const atLeastMinimum = (_version: string, _minimum: string): boolean => false;

// The version a CLI's --version printed, against the pinned minimum, and how to update it when older.
export function versionCheck(_ran: Said, _cli: { command: string; minimum: string; update: string }): Check {
  return passed('version', '');
}

// The login a CLI's status command reported: loggedIn is null when the Harness could not read it, `unreadable` says
// what it printed instead, and `login` is the command that logs in.
export function loginCheck(
  _ran: Said,
  _status: { command: string; loggedIn: boolean | null; unreadable: string; login: string },
): Check {
  return passed('login', '');
}

// A temporary directory for a probe, named from `prefix`, removed after it.
export function inTemporary<T>(_prefix: string, use: (directory: string) => Promise<T>): Promise<T> {
  return use('');
}

// The lines of a stream that are JSON objects, as the CLI sent them.
export const objectLines = (_lines: string[]): Record<string, unknown>[] => [];
