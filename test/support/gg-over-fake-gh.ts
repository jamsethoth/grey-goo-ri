// The gg CLI as a child process over the fake gh, for the cases that spawn gg: no test runs the real gh (#372). Their
// Agents run on the Harness `stand-in`, which preflight refuses, so no case starts an Agent CLI, whichever shipped
// Harness passes preflight (F4, #481).
import * as gg from '../../bin/gg.ts';
import * as github from '../../lib/github.ts';
import * as fakeGh from './fake-gh.ts';
import * as fakeHarness from './fake-harness.ts';

const standIn = fakeHarness.fakeHarness({
  name: 'stand-in',
  validate: () => ({ ok: false, errors: ['the e2e stand-in starts no CLI'] }),
});

await gg.main(process.argv.slice(2), github.createGh(fakeGh.fakeGh({ branch: 'main', ticket: 1 }).gh), {
  'stand-in': standIn,
});
