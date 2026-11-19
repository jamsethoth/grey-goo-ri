// The gate an argv waits behind on Windows (lib/containment.ts's startArgv). gg starts this process and puts it in a
// job before it sends the argv, so the argv and everything it starts begin inside the job. The argv runs with no shell
// on this process's stdio. This process answers once the argv has started, or with the spawn error, and exits with the
// argv's exit code. It stays until the argv exits, because node's own job for its children would kill them when it
// goes. Imported, as the layout test imports every module, it does nothing.
import { spawn } from 'node:child_process';

if (import.meta.main && process.send) {
  const answer = process.send.bind(process);
  process.once('message', (message) => {
    const { command, args } = message as { command: string; args: string[] };
    const fail = ({ message: text, code }: NodeJS.ErrnoException) =>
      answer({ error: { message: text, code } }, () => process.exit(1));
    try {
      const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
      child.on('spawn', () => answer({ started: true }, () => process.disconnect?.()));
      child.on('error', fail);
      child.on('exit', (code) => process.exit(code ?? 1));
    } catch (err) {
      fail(err as NodeJS.ErrnoException); // spawn throws at once for a .bat or .cmd, which takes a shell
    }
  });
}
