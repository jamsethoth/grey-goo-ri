// A process that reads stdin to its end and then prints line.
// The test runner also loads this file with no arguments, where it does nothing.
const [line] = process.argv.slice(2);
if (line) {
  process.stdin.resume();
  process.stdin.on('end', () => console.log(line));
}
