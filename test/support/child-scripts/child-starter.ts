// A process that starts `script args` as its own attached child, with no stdio, and outlives any case.
import { spawn } from 'node:child_process';
import * as childScripts from '../child-scripts.ts';

const [script, ...args] = process.argv.slice(2);
spawn(process.execPath, [script, ...args], { stdio: 'ignore' });
setTimeout(() => {}, childScripts.LIVES_MS);
