// What an argv starts as with no shell, which exec's run and launch share: on Windows an npm .cmd shim is read for the
// program and script it names (#423).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

// A shim's end, as npm's cmd-shim writes it: the program, then the script beside the shim, then the arguments.
const NPM_SHIM = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/;

// What an argv starts with no shell. On Windows a name found first on PATH as a .cmd or .bat, or a path to one, is an
// npm shim, which only cmd.exe can run: it starts the program and script the shim names instead, its own node.exe when
// it has one, as the shim does. Any other .cmd is refused, since running it takes a shell. An .exe or .com found first
// starts as named.
export function argvOf(command: string, args: string[], path = process.env.PATH ?? '') {
  if (process.platform !== 'win32') return { command, args };
  const candidates = /[\\/]/.test(command)
    ? [command]
    : path
        .split(';')
        .filter(Boolean)
        .flatMap((directory) =>
          (extname(command) ? [''] : ['.com', '.exe', '.bat', '.cmd']).map((extension) =>
            join(directory.replace(/"/g, ''), command + extension),
          ),
        );
  const found = candidates.find((file) => statSync(file, { throwIfNoEntry: false })?.isFile());
  if (!found || !/\.(?:cmd|bat)$/i.test(found)) return { command, args };
  const script = NPM_SHIM.exec(readFileSync(found, 'utf8'))?.[1];
  if (!script) throw new Error(`${found} is not an npm shim: gg runs no .cmd through a shell`);
  const ownNode = join(dirname(found), 'node.exe');
  return { command: existsSync(ownNode) ? ownNode : 'node', args: [join(dirname(found), script), ...args] };
}
