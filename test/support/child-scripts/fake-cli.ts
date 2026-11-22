// An Agent CLI as a Harness launches it, replaying one recorded call (FAKE_CLI_RECORDING.jsonl) on stdout, with the
// recording's exit code; a command whose argv FAKE_CLI_COMMANDS holds prints its recorded answer instead
// (test/support/cli-replay.ts, #480). Its tests copy it alone to a directory whose path holds spaces, so it imports
// nothing. The test runner also loads this file with no FAKE_CLI_RECORDING, where it does nothing.
export {};
