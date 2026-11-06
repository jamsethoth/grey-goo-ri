// A process that starts `script args` as its own attached child, with no stdio, and ends when that child does, so a
// case that ends the child it knows ends the whole chain, even when the run under test did not name this one (#285).
// The test runner also loads this file with no arguments, where it does nothing.
import { spawn } from 'node:child_process';

const [script, ...args] = process.argv.slice(2);
if (script) spawn(process.execPath, [script, ...args], { stdio: 'ignore' }).on('exit', () => process.exit());
