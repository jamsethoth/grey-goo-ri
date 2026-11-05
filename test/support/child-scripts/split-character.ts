// A process that prints € and a newline in two writes delayMs apart, the character's bytes split between them.
// The test runner also loads this file with no arguments, where it does nothing.
const [delayMs] = process.argv.slice(2);
if (delayMs) {
  process.stdout.write(Buffer.from([0xe2, 0x82]));
  setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), Number(delayMs));
}
