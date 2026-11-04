import * as claude from './claude.ts';
import * as codex from './codex.ts';

// Every Harness gg ships, by the name an Agent selects. A new Harness is one module and one entry here.
export const HARNESSES = { claude, codex };
