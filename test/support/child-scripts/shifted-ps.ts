// A ps listing taken after the boot time moved: the real `ps -e -o pid=,ppid=,lstart=`, every start the given seconds
// later, as Linux lists them once btime has moved. Run under TZ=UTC and LC_ALL=C, as gg runs its listing.
// The test runner also loads this file with no arguments, where it does nothing.
import { spawnSync } from 'node:child_process';

const [seconds] = process.argv.slice(2);
if (seconds) {
  const listing = spawnSync('ps', ['-e', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8' });
  const rows = listing.stdout.split('\n').map((line) => {
    const [pid, parentPid, ...started] = line.trim().split(/\s+/);
    const moved = new Date(Date.parse(`${started.join(' ')} UTC`) + Number(seconds) * 1000);
    if (Number.isNaN(moved.getTime())) return line;
    // toUTCString gives "Thu, 12 Nov 2026 05:46:45 GMT"; lstart is "Thu Nov 12 05:46:45 2026"
    const [weekday, day, month, year, time] = moved.toUTCString().replace(',', '').split(' ');
    return `${pid} ${parentPid} ${weekday} ${month} ${Number(day)} ${time} ${year}`;
  });
  process.stdout.write(rows.join('\n'));
  process.exit(listing.status ?? 1);
}
