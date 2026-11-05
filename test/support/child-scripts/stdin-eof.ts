// A process that reads stdin to its end and then prints eof.
process.stdin.resume();
process.stdin.on('end', () => console.log('eof'));
