// A process that prints € and a newline in two writes 200 ms apart, the character's bytes split between them.
process.stdout.write(Buffer.from([0xe2, 0x82]));
setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 200);
