import type * as exec from '../exec.ts';

// The paths that configure Claude Code, which gg protects from every agent (request 3.2).
export const protectedPaths: string[] = ['.claude/', '.mcp.json', 'CLAUDE.md'];

// stub: the members that start the CLI, built from the exec shipped.ts is given (run and doctor are to come).
export const createCli = (_runner: Pick<exec.Exec, 'launch'>) => ({});
