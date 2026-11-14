import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The shape of a saved row's TypeScript type, read with the compiler API: what each key holds, which keys a row may
// leave out, and each union's forms by the type that names them (#402). The record types are the one declaration of a
// row; a test reads its rules from this walk, never from a hand-kept list.

type Kinded =
  | { kind: 'json' }
  | { kind: 'scalar'; type: string; members: string[] | null }
  | { kind: 'list'; of: Shape }
  | { kind: 'keyed'; of: Shape }
  | { kind: 'object'; keys: Record<string, Key>; open: boolean }
  | { kind: 'union'; by: UnionBy; forms: Form[] };
type Structure = Extract<Kinded, { kind: 'list' | 'keyed' | 'object' }>;
export type Shape = Kinded & { nullable: boolean };
export interface Key {
  // A row may leave the key out: it is optional, or its type allows undefined, which JSON cannot hold.
  optional: boolean;
  shape: Shape;
}
// A union's forms are told apart by their keys, by one key's closed set of values (a tag), or by being a list or not.
export type UnionBy = 'keys' | 'tag' | 'list';
export interface Form {
  name: string;
  shape: Shape;
}

export const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');

function readConfig(): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    `${root}tsconfig.json`,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('tsconfig.json did not parse');
  return parsed;
}
export const configured = readConfig();

// A namespace as gg's modules import it: lib/approval-action.ts is `approvalAction`, lib/effects/index.ts `effects`.
function namespaceOf(fileName: string) {
  const parts = fileName.replace(/\.ts$/, '').split('/');
  const stem = parts.at(-1) === 'index' ? parts.at(-2)! : parts.at(-1)!;
  return stem.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase());
}

export class TypeShapes {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  private readonly json: ts.Type;

  constructor(program = ts.createProgram([`${root}lib/record-json.ts`], configured.options)) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.json = this.declared('lib/json-value.ts', 'JsonValue');
  }

  // The type a module exports by `name`.
  declared(file: string, name: string): ts.Type {
    const source = this.program.getSourceFile(`${root}${file}`);
    const moduleSymbol = source && this.checker.getSymbolAtLocation(source);
    const symbol = moduleSymbol && this.checker.getExportsOfModule(moduleSymbol).find((held) => held.name === name);
    if (!symbol) throw new Error(`${file} exports no ${name}`);
    return this.checker.getDeclaredTypeOfSymbol(symbol);
  }

  shapeOf(file: string, name: string): Shape {
    return this.shape(this.declared(file, name), 0);
  }

  // The name of the type a form is: its alias or interface, as gg's modules name it, or its tag, or its keys.
  private formName(type: ts.Type, tag: string | null): string {
    const symbol = type.aliasSymbol ?? (type.flags & ts.TypeFlags.Object ? type.getSymbol() : undefined);
    const declaration = symbol?.declarations?.[0];
    if (this.checker.isArrayType(type)) return this.checker.typeToString(type);
    if (symbol && declaration && !symbol.name.startsWith('__')) {
      const fileName = declaration.getSourceFile().fileName;
      if (fileName.startsWith(root) && !fileName.includes('/node_modules/'))
        return `${namespaceOf(fileName.slice(root.length))}.${symbol.name}`;
    }
    if (tag !== null) {
      const tagType = this.checker.getTypeOfSymbol(type.getProperty(tag)!);
      return `${tag}=${this.checker.typeToString(tagType).replaceAll('"', '')}`;
    }
    return `{${this.ownKeys(type).join(',')}}`;
  }

  // The keys a row of `type` may hold: an optional key typed only undefined or never rules a key out of a form, so a
  // row never holds it.
  private ownKeys(type: ts.Type) {
    return type
      .getProperties()
      .filter((property) => !(this.checker.getTypeOfSymbol(property).getNonNullableType().flags & ts.TypeFlags.Never))
      .map((property) => property.name);
  }

  private shape(declared: ts.Type, depth: number): Shape {
    if (depth > 30) throw new Error(`${this.checker.typeToString(declared)} nests too deep`);
    if (this.checker.isTypeAssignableTo(this.json, declared)) return { nullable: true, kind: 'json' };
    const members = declared.isUnion() ? declared.types : [declared];
    const nullable = members.some((member) => member.flags & ts.TypeFlags.Null);
    const held = members.filter((member) => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    const scalars = held.filter((member) => !(member.flags & ts.TypeFlags.Object) && !member.isIntersection());
    const structured = held.filter((member) => !scalars.includes(member));
    if (!structured.length) {
      const literal = scalars.every((member) => member.isStringLiteral());
      const type = this.checker.typeToString(this.checker.getNonNullableType(declared));
      return {
        nullable,
        kind: 'scalar',
        type,
        members: literal ? scalars.map((member) => (member as ts.StringLiteralType).value) : null,
      };
    }
    if (scalars.length) throw new Error(`${this.checker.typeToString(declared)} mixes scalars and structures`);
    if (structured.length === 1) return { nullable, ...this.structure(structured[0], depth) };
    const tag = this.tagOf(structured);
    let by: UnionBy = tag === null ? 'keys' : 'tag';
    if (structured.some((member) => this.checker.isArrayType(member))) by = 'list';
    return {
      nullable,
      kind: 'union',
      by,
      forms: structured.map((member) => ({
        name: this.formName(member, tag),
        shape: { nullable: false, ...this.structure(member, depth) },
      })),
    };
  }

  // The key every form holds with a closed set of values, which tells the forms apart.
  private tagOf(forms: readonly ts.Type[]): string | null {
    const [first] = forms;
    if (forms.some((form) => this.checker.isArrayType(form))) return null;
    const closed = (form: ts.Type, key: string) => {
      const property = form.getProperty(key);
      if (!property || property.flags & ts.SymbolFlags.Optional) return false;
      const type = this.checker.getTypeOfSymbol(property);
      const values = type.isUnion() ? type.types : [type];
      return values.every((value) => value.isStringLiteral() || value.flags & ts.TypeFlags.Null);
    };
    return this.ownKeys(first).find((key) => forms.every((form) => closed(form, key))) ?? null;
  }

  private structure(type: ts.Type, depth: number): Structure {
    if (this.checker.isArrayType(type))
      return { kind: 'list', of: this.shape(this.checker.getTypeArguments(type as ts.TypeReference)[0], depth + 1) };
    const index = type.getStringIndexType();
    const properties = type
      .getProperties()
      .map((property) => ({ property, type: this.checker.getTypeOfSymbol(property) }))
      .filter(({ type: held }) => !(held.getNonNullableType().flags & ts.TypeFlags.Never));
    if (index && !properties.length) return { kind: 'keyed', of: this.shape(index, depth + 1) };
    const keys = Object.fromEntries(
      properties.map(({ property, type: held }) => [
        property.name,
        {
          optional: Boolean(property.flags & ts.SymbolFlags.Optional) || this.allowsUndefined(held),
          shape: this.shape(held, depth + 1),
        },
      ]),
    );
    return { kind: 'object', keys, open: Boolean(index) };
  }

  private allowsUndefined(type: ts.Type) {
    return (type.isUnion() ? type.types : [type]).some((member) => member.flags & ts.TypeFlags.Undefined);
  }
}

// Every path a shape declares, each with its type: `[]` for a list's items, `*` for a keyed object's names, and
// `<form>` where a union's form is chosen. An optional key ends in `?`. Given a row's `value`, only the paths it holds.
export function paths(shape: Shape, value?: { held: unknown }, prefix = ''): string[] {
  const join = (segment: string) => (prefix && !/^[[<]/.test(segment) ? `${prefix}.` : prefix) + segment;
  const line = (path: string, optional: boolean, of: Shape) => `${path}${optional ? '?' : ''}: ${typeOf(of)}`;
  const below = (of: Shape, path: string, held: unknown) => paths(of, value && { held }, path);
  if (value?.held === null) return [];
  const items = (held: unknown) => (value ? Object.values(held as object) : [undefined]);
  switch (shape.kind) {
    case 'json':
    case 'scalar':
      return [];
    case 'list':
    case 'keyed': {
      const path = join(shape.kind === 'list' ? '[]' : '*');
      return items(value?.held).flatMap((item) => [line(path, false, shape.of), ...below(shape.of, path, item)]);
    }
    case 'union': {
      const forms = value ? [formOf(shape, value.held)].filter((form) => form !== undefined) : shape.forms;
      return forms.flatMap((form) => below(form.shape, join(`<${form.name}>`), value?.held));
    }
    case 'object':
      return Object.entries(shape.keys)
        .filter(([key]) => !value || Object.hasOwn(value.held as object, key))
        .flatMap(([key, { optional, shape: of }]) => [
          line(join(key), optional, of),
          ...below(of, join(key), value && (value.held as Record<string, unknown>)[key]),
        ]);
  }
}

// The path of every object a shape declares, as segments: a key, `[]` or `*`. A union's forms at one path share it.
export function objectPaths(shape: Shape, prefix: string[] = []): string[][] {
  switch (shape.kind) {
    case 'json':
    case 'scalar':
      return [];
    case 'list':
      return objectPaths(shape.of, [...prefix, '[]']);
    case 'keyed':
      return objectPaths(shape.of, [...prefix, '*']);
    case 'union': {
      const found = shape.forms.flatMap((form) => objectPaths(form.shape, prefix));
      return [...new Map(found.map((segments) => [segments.join('.'), segments])).values()];
    }
    case 'object':
      return [
        prefix,
        ...Object.entries(shape.keys).flatMap(([key, held]) => objectPaths(held.shape, [...prefix, key])),
      ];
  }
}

// The shape a node of `row` is declared with, found by its segments: each union on the way is read as the form its
// value fits, and a key an open object does not declare is JSON. Undefined where the row leaves the declaration.
export function declaredAt(shape: Shape, row: unknown, segments: (string | number)[]): Shape | undefined {
  let declared: Shape | undefined = shape;
  let value = row;
  for (const segment of segments) {
    const placed: Shape | undefined = declared && formed(declared, value);
    if (!placed) return undefined;
    if (placed.kind === 'json') return placed;
    if (placed.kind === 'list' || placed.kind === 'keyed') declared = placed.of;
    else if (placed.kind !== 'object') return undefined;
    else declared = placed.keys[segment]?.shape ?? (placed.open ? { nullable: true, kind: 'json' } : undefined);
    value = (value as Record<string | number, unknown>)[segment];
  }
  return declared;
}

// A shape as `value` is read by it: a union as the form the value fits.
export const formed = (shape: Shape, value: unknown): Shape | undefined =>
  shape.kind === 'union' ? formOf(shape, value)?.shape : shape;

// A shape's type as a path line gives it.
export function typeOf(shape: Shape): string {
  const nullable = shape.nullable && shape.kind !== 'json' ? ' | null' : '';
  switch (shape.kind) {
    case 'json':
      return 'JsonValue';
    case 'scalar':
      return shape.type + nullable;
    case 'list':
      return `list${nullable}`;
    case 'keyed':
      return `keyed${nullable}`;
    case 'object':
      return `${shape.open ? 'open object' : 'object'}${nullable}`;
    case 'union':
      return `${shape.forms.map((form) => form.name).join(' | ')}${nullable}`;
  }
}

// The form of a union that `value` fits: by its tag's value, by being a list, or by its keys: every key the form
// requires held, and no key it does not declare.
export function formOf(shape: Extract<Shape, { kind: 'union' }>, value: unknown): Form | undefined {
  const isObject = (held: unknown): held is Record<string, unknown> =>
    typeof held === 'object' && held !== null && !Array.isArray(held);
  return shape.forms.find(({ shape: form }) => {
    if (form.kind === 'list') return Array.isArray(value);
    if (form.kind !== 'object' || !isObject(value)) return false;
    const keys = Object.keys(value);
    const fits = (key: string) => {
      const declared = form.keys[key];
      if (!declared) return form.open;
      const { shape: held } = declared;
      const member = value[key];
      return held.kind !== 'scalar' || !held.members || member === null || held.members.includes(member as string);
    };
    return Object.entries(form.keys).every(([key, { optional }]) => optional || keys.includes(key)) && keys.every(fits);
  });
}
