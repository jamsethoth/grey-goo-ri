// A promise latch, opened once: `wait()` resolves once `open()` has been called. A broken interleaving fails at its
// case's timeout; a shorter bound of its own failed correct interleavings whenever the machine was loaded enough that
// the other Ticket's whole Execution outlasted it.
export function latch(): { open: () => void; wait: () => Promise<void> } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { open: () => resolve(), wait: () => promise };
}
