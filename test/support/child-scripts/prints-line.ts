// A process that prints line and exits with code, 0 when none is given.
const [line, code = '0'] = process.argv.slice(2);
console.log(line);
process.exitCode = Number(code);
