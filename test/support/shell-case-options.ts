// The node:test options of the exec contract cases: their timeout, and the platforms and sandboxes each runs in.

// Only a restricted sandbox may refuse cleanup; there survivors need only be reported.
export const sandboxed = process.env.GG_TEST_SANDBOXED === '1';
const windows = process.platform === 'win32';

// Cases that wait for a process event: a broken runShell fails at this bound instead of hanging the file.
export const CASE = { timeout: 120_000 };
export const WIN_CASE = { ...CASE, skip: !windows && 'Windows only' };
export const UNSANDBOXED_CASE = {
  ...CASE,
  skip: sandboxed && 'a restricted sandbox may refuse cleanup: see its own case',
};
export const SANDBOXED_CASE = { ...CASE, skip: !sandboxed && 'a restricted sandbox only' };
export const UNSANDBOXED_WIN_CASE = { ...CASE, skip: WIN_CASE.skip || UNSANDBOXED_CASE.skip };
export const SANDBOXED_WIN_CASE = { ...CASE, skip: WIN_CASE.skip || SANDBOXED_CASE.skip };
export const POSIX_CASE = {
  ...CASE,
  skip: (windows && 'POSIX process listing only') || (sandboxed && 'a restricted sandbox may refuse cleanup'),
};
