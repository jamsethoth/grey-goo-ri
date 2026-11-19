import type * as exec from '../exec.ts';

// The paths that configure Codex, which gg protects from every agent (request 3.2).
export const protectedPaths: string[] = ['.codex/', 'AGENTS.md'];

// No launch profile until slice 3 builds Codex's launch; the Config Hash still pins its confinement (#428).
export const launchProfile = null;

// stub: the members that start the CLI, built from the exec shipped.ts is given (run and doctor are to come).
export const createCli = (_runner: Pick<exec.Exec, 'launch'>) => ({});
