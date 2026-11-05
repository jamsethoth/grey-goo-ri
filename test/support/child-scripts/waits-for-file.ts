// A process that writes its pid to pidFile and lingers until file exists.
import { existsSync, writeFileSync } from 'node:fs';

const [file, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
const wait = setInterval(() => {
  if (existsSync(file)) clearInterval(wait);
}, 50);
