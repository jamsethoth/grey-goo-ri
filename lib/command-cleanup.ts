// Command Cleanup's decisions: which processes a shell command left, and what cleanup does with each. Pure functions of
// the listings lib/process-tree.ts (POSIX) and lib/containment.ts (Windows) take; they list and signal, this decides.

// A process as a listing names it: its pid, its parent's pid, its start time as the kernel recorded it, and, in a full
// `ps` listing, its process group and command line.
export type ProcessRow = [pid: number, parentPid: number, started: string, pgid?: number, commandLine?: string];
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
}

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

// Grows `tree` with every listed process whose parent is in it, until no more join; `onJoin` sees each that does.
// selfPid, the process doing the cleanup, never joins.
export function growTree(
  tree: Set<number>,
  processes: ProcessRow[],
  selfPid: number,
  onJoin: (processRow: ProcessRow) => void = () => {},
) {
  for (let grew = true; grew;) {
    grew = false;
    for (const processRow of processes)
      if (!tree.has(processRow[0]) && tree.has(processRow[1]) && processRow[0] !== selfPid) {
        tree.add(processRow[0]);
        onJoin(processRow);
        grew = true;
      }
  }
}

// The watcher's update from one listing: a seen pid no longer listed is forgotten, since its pid may come to name
// another process, and each new process linked to rootPid or a seen descendant is recorded with its start time, so it
// is still recognised after its parent exits and it is reparented.
export function observe(seen: Seen, rootPid: number, processes: ProcessRow[], selfPid: number) {
  const listed = new Set(processes.map((processRow) => processRow[0]));
  for (const pid of seen.keys()) if (!listed.has(pid)) seen.delete(pid);
  growTree(new Set([rootPid, ...seen.keys()]), processes, selfPid, (processRow) => seen.set(processRow[0], processRow));
}

const sameProcess = (left: ProcessRow, right: ProcessRow) => left[0] === right[0] && left[2] === right[2];

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
  for (const processRow of processes) {
    const known = seen.get(processRow[0]);
    if (known && sameProcess(known, processRow)) alive.add(processRow[0]);
  }
  growTree(alive, processes, selfPid);
  const listed = new Set(processes.map((processRow) => processRow[0]));
  // A listed pid with another start time is a new process under a reused pid, not ours to kill, or ours after a
  // wall-clock step moved every start time ps reports: left alone, and not claimed gone.
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
