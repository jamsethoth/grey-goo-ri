// Command Cleanup's decisions: which processes a shell command left, and what cleanup does with each. Pure functions of
// the listings lib/process-tree.ts (POSIX) and lib/containment.ts (Windows) take; they list and signal, this decides.

// A process as a listing names it: its pid, its parent's pid, its start time as the listing gives it, and, in a full
// `ps` listing, its process group and command line. A seen descendant also keeps its start in seconds after the
// cleanup's own process's, in the listing it was seen in, where both parse.
export type ProcessRow = [
  pid: number,
  parentPid: number,
  started: string,
  pgid?: number,
  commandLine?: string,
  sinceSelf?: number,
];
// The descendants a POSIX watcher has seen, keyed by pid.
export type Seen = Map<number, ProcessRow>;
// A process listing's rows, and error when the listing is unusable.
export type Listing = { processes: ProcessRow[]; error: string | undefined };
// A process as a Windows snapshot names it.
export type ProcessEntry = { pid: number; parentPid: number; exe: string };

// A process as gg can name it to a human: null where the system would not say.
export interface NamedProcess {
  pid: number;
  created: string | null;
  commandLine: string | null;
}

// A process that could not be killed or confirmed gone, and why.
export interface Survivor extends NamedProcess {
  error: string;
}

// How gg can check later that a command's processes are gone (L14).
export type CleanupContainment = { kind: 'job' } | { kind: 'group'; pgid: number } | { kind: 'none' };

// What a returned call's Command Cleanup found (L11).
export interface CleanupReport {
  confirmed: boolean;
  survivors: Survivor[];
  reason: string | null;
  containment: CleanupContainment;
  // An unconfirmed job's handle, for the Run to close as it ends the Ticket. Not enumerable, so never saved.
  closeJob?: () => void;
}

// A report as a record or an Event saves it: closeJob is not enumerable, so no save writes it.
export type SavedCleanup = Omit<CleanupReport, 'closeJob'>;
// What a call or a Check's command reports of its cleanup: always whether it was confirmed and what survived.
export type CallCleanup = Pick<SavedCleanup, 'confirmed' | 'survivors'> & Partial<SavedCleanup>;

// A Check that ran no command started no process (owner, 2026-11-06).
export const NO_COMMAND: Pick<CleanupReport, 'confirmed' | 'survivors'> = { confirmed: true, survivors: [] };

// What a timed-out command's cleanup left: survivors, and cleanupErrors for anything that could not be confirmed gone.
export interface Cleanup {
  survivors: Survivor[];
  cleanupErrors: string[];
}

function reasonFor({ survivors, cleanupErrors }: Cleanup) {
  if (cleanupErrors.length) return cleanupErrors.join('; ');
  const count = survivors.length;
  if (count) return `${count} process${count === 1 ? '' : 'es'} could not be confirmed gone`;
  return 'the command ran uncontained, so its orphans cannot be found';
}

// Confirmed only under a containment gg can check, with nothing left and nothing it could not check (L11, L14): an
// uncontained command's orphans cannot be found, so it never is, whatever it is seen to have left.
export function cleanupReport(containment: CleanupContainment, cleanup: Cleanup): CleanupReport {
  const { survivors, cleanupErrors } = cleanup;
  const confirmed = containment.kind !== 'none' && !survivors.length && !cleanupErrors.length;
  return { confirmed, survivors, reason: confirmed ? null : reasonFor(cleanup), containment };
}

// Whether a later Run finds a held call's processes gone under its containment (L14).
// A job: the Run that held it closed its only handle before it released the ticket lock, so kill-on-close has fired
// (#245). A process group: empty means every inheriting child is gone, not only the survivors listed. None, or a report
// that names none: nothing can say, so the Ticket stays held for a human.
export function confirmedUnder(
  containment: CleanupContainment | undefined,
  groupHasMembers: (pgid: number) => boolean,
): boolean {
  if (containment?.kind === 'job') return true;
  return containment?.kind === 'group' && !groupHasMembers(containment.pgid);
}

const namedProcess = ([pid, , started, , commandLine]: ProcessRow): NamedProcess => ({
  pid,
  created: started || null,
  commandLine: commandLine || null,
});
export const survivorOf = (processRow: ProcessRow, error: string): Survivor => ({ ...namedProcess(processRow), error });

// What a finished command left: what the plan kills and what its process group still holds, less the command itself and
// a zombie its reparenting has not reaped yet, which has already ended.
export const leftoverRows = (rootPid: number, { kill }: KillPlan, { processes }: Listing): NamedProcess[] =>
  processes
    .filter(([pid, , , pgid]) => pid !== rootPid && (kill.includes(pid) || pgid === rootPid))
    .filter(([, , , , commandLine]) => !commandLine?.endsWith('<defunct>'))
    .map(namedProcess);

// The pids to kill, in order, and the survivors named whatever the kills do.
export type KillPlan = { kill: number[]; survivors: Survivor[] };

// The rows of a `ps -e -o pid=,ppid=,lstart=,pgid=,args=` run, with LC_ALL=C giving lstart its five fields; a listing
// that exited non-zero or has no rows is unusable.
export function parseListing({
  code,
  stdout,
  stderr,
}: {
  code: number | null;
  stdout: string;
  stderr: string;
}): Listing {
  const processes = stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length > 2 && /^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!))
    .map(([pid, parentPid, ...rest]): ProcessRow => {
      const started = rest.slice(0, 5).join(' ');
      if (rest.length <= 5) return [Number(pid), Number(parentPid), started];
      return [Number(pid), Number(parentPid), started, Number(rest[5]), rest.slice(6).join(' ')];
    });
  const failure = code === null ? 'did not start' : 'exit ' + code;
  const error =
    code !== 0 || !processes.length ? `process snapshot failed (${failure}): ${stderr.trim()}`.trim() : undefined;
  return { processes, error };
}

// Grows `tree` with every listed process whose parent is in it, until no more join; `onJoin` sees each that does, and
// `joins` can refuse one. selfPid, the process doing the cleanup, never joins.
export function growTree(
  tree: Set<number>,
  processes: ProcessRow[],
  selfPid: number,
  {
    onJoin = () => {},
    joins = () => true,
  }: { onJoin?: (processRow: ProcessRow) => void; joins?: (processRow: ProcessRow) => boolean } = {},
) {
  for (let grew = true; grew;) {
    grew = false;
    for (const processRow of processes)
      if (!tree.has(processRow[0]) && tree.has(processRow[1]) && processRow[0] !== selfPid && joins(processRow)) {
        tree.add(processRow[0]);
        onJoin(processRow);
        grew = true;
      }
  }
}

// The pids linked to rootPid through parent pids in a Windows snapshot, for the fallback that has no job to list. A
// Windows parent pid is not cleared when the parent ends and can be reused, so a process joins only if it started no
// earlier than the parent it names (#297). One whose start cannot be read, gone or closed to gg, is left out, with what
// it started. startOf gives a process's start as a FILETIME.
export function linkedPids(
  rootPid: number,
  entries: ProcessEntry[],
  selfPid: number,
  startOf: (pid: number) => bigint | null,
): number[] {
  const starts = new Map<number, bigint | null>();
  const started = (pid: number) => {
    if (!starts.has(pid)) starts.set(pid, startOf(pid));
    return starts.get(pid) as bigint | null;
  };
  const startedAfterParent = ([pid, parentPid]: ProcessRow) => {
    const [child, parent] = [started(pid), started(parentPid)];
    return child !== null && parent !== null && child >= parent;
  };
  const rows = entries.map(({ pid, parentPid }): ProcessRow => [pid, parentPid, '']);
  const linked: number[] = [];
  growTree(new Set([rootPid]), rows, selfPid, { onJoin: ([pid]) => linked.push(pid), joins: startedAfterParent });
  return linked;
}

// The watcher's update from one listing: a seen pid no longer listed is forgotten, since its pid may come to name
// another process, and each new process linked to rootPid or a seen descendant is recorded with its start time, so it
// is still recognised after its parent exits and it is reparented.
export function observe(seen: Seen, rootPid: number, processes: ProcessRow[], selfPid: number) {
  const listed = new Set(processes.map((processRow) => processRow[0]));
  for (const pid of seen.keys()) if (!listed.has(pid)) seen.delete(pid);
  const sinceSelf = sinceSelfIn(processes, selfPid);
  growTree(new Set([rootPid, ...seen.keys()]), processes, selfPid, {
    onJoin: (processRow) => {
      const [pid, parentPid, started, pgid, commandLine] = processRow;
      const since = sinceSelf(processRow);
      seen.set(pid, Number.isNaN(since) ? processRow : [pid, parentPid, started, pgid, commandLine, since]);
    },
  });
}

// Linux lists a start as the boot time plus the start since boot, and the boot time can move a second between two
// listings, or more when the wall clock is stepped (#352). One listing reads one boot time for every row, so a start
// counted from the cleanup's own process's does not move. NaN where that row is missing or either start does not parse.
function sinceSelfIn(processes: ProcessRow[], selfPid: number) {
  const startOf = (processRow: ProcessRow | undefined) =>
    processRow ? Date.parse(`${processRow[2]} UTC`) / 1000 : Number.NaN;
  const selfStart = startOf(processes.find(([pid]) => pid === selfPid));
  return (processRow: ProcessRow) => startOf(processRow) - selfStart;
}

// The same process: its start counted from the cleanup's own where both listings give one, else its start as listed.
const sameProcess = (known: ProcessRow, processRow: ProcessRow, since: number) =>
  known[0] === processRow[0] &&
  (known[5] === undefined || Number.isNaN(since) ? known[2] === processRow[2] : known[5] === since);

// A cleanup's plan from a listing taken with the group stopped: `seeds`, each seen descendant still listed with its
// start time, and whatever those have started. Never another process.
function planFrom(
  { seeds, rootPid }: { seeds: number[]; rootPid: number },
  seen: Seen,
  { processes, error }: Listing,
  selfPid: number,
): KillPlan {
  if (error) {
    // cannot tell what is alive: attempt the seeds, and name every other known descendant rather than claim success
    const survivors = [...seen.entries()]
      .filter(([pid]) => pid !== rootPid)
      .map(([, processRow]) => survivorOf(processRow, 'not verified gone: ' + error));
    return { kill: seeds, survivors };
  }
  const alive = new Set(seeds);
  const sinceSelf = sinceSelfIn(processes, selfPid);
  for (const processRow of processes) {
    const known = seen.get(processRow[0]);
    if (known && sameProcess(known, processRow, sinceSelf(processRow))) alive.add(processRow[0]);
  }
  growTree(alive, processes, selfPid);
  const listed = new Set(processes.map((processRow) => processRow[0]));
  // A listed pid with another start time is a new process under a reused pid, or ours after the boot time moved in a
  // listing with no row of the cleanup's own to count from: left alone, and not claimed gone.
  const survivors = processes
    .filter((processRow) => seen.has(processRow[0]) && !alive.has(processRow[0]))
    .map((processRow) => survivorOf(processRow, 'not verified gone: its pid now has another start time'));
  return { kill: [...alive].filter((pid) => listed.has(pid)), survivors };
}

// What a POSIX timeout kills: the plan from rootPid, the command still running.
export const killPlan = (rootPid: number, seen: Seen, listing: Listing, selfPid: number): KillPlan =>
  planFrom({ seeds: [rootPid], rootPid }, seen, listing, selfPid);

// What is killed of what a POSIX command left once it has exited. The command is left out: gg has reaped it, and its
// pid may name another process by now.
export const leftoverPlan = (rootPid: number, seen: Seen, listing: Listing, selfPid: number): KillPlan =>
  planFrom({ seeds: [], rootPid }, seen, listing, selfPid);

// A job's members still running once its command has exited. A member still exiting is in the job but no longer in
// the snapshot. windowsHide makes libuv start cmd.exe with CREATE_NO_WINDOW, so it gets a conhost.exe of its own, which
// ends just after cmd.exe does. That host is in the job unless it started before cmd.exe was put there.
export function leftoverPids(members: number[], entries: ProcessEntry[], commandPid: number): number[] {
  const running = new Set(
    entries
      .filter((entry) => !(entry.parentPid === commandPid && entry.exe.toLowerCase() === 'conhost.exe'))
      .map((entry) => entry.pid),
  );
  return members.filter((pid) => running.has(pid));
}

// What a stage left running in the job its launcher holds: the job's members in the snapshot, less the launcher. A
// member not in the snapshot is still exiting. A console host ends with the last process attached to it, so it is never
// the leak: whatever keeps it alive is named, and a test's commands start hosts with any parent.
export function strayProcesses(members: number[], entries: ProcessEntry[], selfPid: number): ProcessEntry[] {
  const held = new Set(members);
  return entries.filter(({ pid, exe }) => held.has(pid) && pid !== selfPid && exe.toLowerCase() !== 'conhost.exe');
}
