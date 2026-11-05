import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import * as childExit from '../support/child-exit.ts';

// A stand-in for a spawned process: its piped streams, then its close, as a real child's arrive.
function fakeChild({ stdout }: { stdout: boolean }) {
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stderr, stdout: stdout ? new PassThrough() : null });
  const close = async (code: number) => {
    const streams = [stderr, ...(child.stdout ? [child.stdout] : [])];
    // A stream nothing reads is drained, so it ends.
    for (const stream of streams) stream.resume().end();
    await Promise.all(streams.map((stream) => once(stream, 'end')));
    child.emit('close', code);
  };
  return { child, stderr, stdout: child.stdout, close };
}

test('exitOf keeps a character whole when it arrives split across two chunks', async () => {
  const { child, stderr, close } = fakeChild({ stdout: false });
  const exit = childExit.exitOf(child as never);
  const euro = Buffer.from('€');
  stderr.write(euro.subarray(0, 1));
  stderr.write(euro.subarray(1));
  await close(1);
  assert.deepEqual(await exit, { code: 1, err: '€' });
});

test('exitOf collects stdout only when it is piped', async () => {
  const { child, stderr, stdout, close } = fakeChild({ stdout: true });
  const exit = childExit.exitOf(child as never);
  stdout?.write('ready\n');
  stderr.write('warning\n');
  await close(0);
  assert.deepEqual(await exit, { code: 0, err: 'warning\n', stdout: 'ready\n' });
});
