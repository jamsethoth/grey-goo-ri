// The gg CLI as a child process over the fake gh, for the cases that spawn gg: no test runs the real gh (#372).
import * as gg from '../../bin/gg.ts';
import * as github from '../../lib/github.ts';
import * as fakeGh from './fake-gh.ts';

await gg.main(process.argv.slice(2), github.createGh(fakeGh.fakeGh({ branch: 'main', ticket: 1 }).gh));
