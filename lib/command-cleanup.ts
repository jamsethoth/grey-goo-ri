// stub (#264): command cleanup's decisions, each returning a wrong value until green.

export type ProcessRow = [pid: number, parentPid: number, started: string];
export type Seen = Map<number, ProcessRow>;
export interface Survivor {
  pid: number;
  error: string;
}
export interface Cleanup {
  survivors: Survivor[];
  cleanupErrors: string[];
}
export type Listing = { processes: ProcessRow[]; error: string | undefined };
export type ProcessEntry = { pid: number; parentPid: number; exe: string };
export type KillPlan = { kill: number[]; survivors: Survivor[] };

export function parseListing(_helperResult: { code: number | null; stdout: string; stderr: string }): Listing {
  return { processes: [], error: undefined };
}

export function growTree(
  _tree: Set<number>,
  _processes: ProcessRow[],
  _selfPid: number,
  _onJoin: (processRow: ProcessRow) => void = () => {},
) {}

export function observe(_seen: Seen, _rootPid: number, _processes: ProcessRow[], _selfPid: number) {}

export function killPlan(_rootPid: number, _seen: Seen, _listing: Listing, _selfPid: number): KillPlan {
  return { kill: [], survivors: [] };
}

export function leftoverPids(_members: number[], _entries: ProcessEntry[], _commandPid: number): number[] {
  return [];
}
