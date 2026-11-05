// A process that prints line and exits with code, 0 when none is given.
// The test runner also loads this file with no arguments, where it does nothing.
const [line, code = '0'] = process.argv.slice(2);
if (line) {
  console.log(line);
  process.exitCode = Number(code);
}
