// A process that writes its pid to pidFile and lingers until file exists.
// The test runner also loads this file with no arguments, where it does nothing.
import { existsSync, writeFileSync } from 'node:fs';

const [file, pidFile] = process.argv.slice(2);
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
  const wait = setInterval(() => {
    if (existsSync(file)) clearInterval(wait);
  }, 50);
}
