// The middle of an orphan chain: it writes its pid to midFile, starts `script args` detached, and lingers until goFile
// exists, so the case decides when it exits and leaves that grandchild an orphan.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const [midFile, goFile, script, ...args] = process.argv.slice(2);
writeFileSync(midFile, String(process.pid));
spawn(process.execPath, [script, ...args], { detached: true, stdio: 'ignore' }).unref();
const wait = setInterval(() => {
  if (existsSync(goFile)) clearInterval(wait);
}, 50);
