// The Flow validator (V1): everything the configuration decides, checked before any agent runs, giving each Flow's
// Resolved Flow plus errors and warnings. Graph checks (routing, bounds, paths) are #107's.

import { assertClaimEnum, assertStrict } from './briefs.mjs';
import * as refs from './refs.mjs';
import { analyse } from './rules.mjs';

const ENDS = ['ready-for-qa', 'needs-human', 'needs-replan'];
// `cleanup` is the Pending cleanup hold's Await Label (L11) and `done` the human-only end (L12).
const RESERVED_VERTICES = [...ENDS, 'cleanup', 'done'];
const HARNESS_OUTCOMES = ['harness-timeout', 'harness-transient', 'harness-unparsed'];
// The heads of gg's own reference paths, so an Action id never shadows one.
const HEADS = ['claim', 'pass', 'check', 'response', 'inputs', 'rescue'];
const TABLES = ['passed', 'failed', 'stopped'];
const NO_TOKEN = { passed: 'no Claim token passes', failed: 'no Claim token requires a Check', stopped: 'no Claim token stops' };
const OPS = ['<', '<=', '>', '>=', '='];

const AGENT_KEYS = ['harness', 'model', 'effort', 'persona', 'skills', 'mcp', 'plugins', 'mode', 'access', 'network', 'resolution',
  'contextBudget', 'timeouts'];
const VERTEX_KEYS = ['use', 'procedure', 'inputs', 'route', 'maxVisits', 'exhausted', ...AGENT_KEYS];
const PROCEDURE_KEYS = ['tests', 'access', 'claims', 'actions', 'recover', ...TABLES, 'otherwise'];
const ACTION_KEYS = {
  agent: ['brief', 'schema'],
  check: ['kind', 'recoverBrief', 'recoverable'],
  commit: ['type'],
  push: [],
  'pr-upsert': ['body', 'with'],
  'pr-ready': [],
  comment: ['target', 'body'],
  'await-approval': ['decisions'],
};
const CONDITION_KEYS = ['field', 'is', 'none', 'any', 'all', 'count', 'where', ...OPS];
const CHECK_KEYS = {
  command: ['command', 'reuse'],
  'tests-fail': ['command', 'names'],
  response: [...CONDITION_KEYS, 'all-of'],
  repeat: ['list', 'fields'],
};

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v.trim() !== '';
const isCount = (v) => Number.isInteger(v) && v > 0;
const entries = (v) => (isRecord(v) ? Object.entries(v) : []);
const unique = (list) => [...new Set(list)];
const json = JSON.stringify;
const reserved = (name) => name === 'failed' || ENDS.includes(name) || name.startsWith('harness-');
const RESERVED = 'is reserved for the engine: failed, an end name or harness-*';

const object = (properties) => ({ type: 'object', properties });
const STRING_LIST = { type: 'array', items: { type: 'string' } };
const OPAQUE = object({});
const STATES = { type: 'string', enum: ['passed', 'failed', 'not-run'] };
// What each Action kind produces, as `<action id>.<output>` (W2); an agent's response is typed by its schema.
const outputs = (action, schema) => object(action.do === 'agent' ? { response: schema, cleanup: OPAQUE }
  : action.do === 'check' ? { evidence: OPAQUE, cleanup: OPAQUE }
    : action.do === 'commit' ? { files: STRING_LIST } : {});
// Sorted keys, so two schemas that differ only in key order are one type.
const typeKey = (node) => json(node, (k, v) => (isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));

export function validate(config, { harnesses, readSchema }) {
  const errors = [];
  const warnings = [];
  const error = (at, message) => errors.push({ at, message });
  const unknownKeys = (value, keys, at) => {
    for (const key of Object.keys(value)) if (!keys.includes(key)) error(at, `unknown key ${json(key)}`);
  };
  const schemas = new Map();
  const loadSchema = (name, at) => {
    if (!schemas.has(name)) {
      let schema;
      try {
        schema = readSchema(name);
      } catch (e) {
        schemas.set(name, { node: refs.ANY, error: `schema ${name} cannot be read: ${e.message}` });
      }
      if (!schemas.has(name)) {
        try {
          assertStrict(schema);
          schemas.set(name, { node: schema });
        } catch (e) {
          schemas.set(name, { node: refs.ANY, error: `${name}: ${e.message}` });
        }
      }
    }
    const loaded = schemas.get(name);
    if (loaded.error) error(at, loaded.error);
    return loaded.node;
  };

  const procedures = {};
  for (const [name, p] of entries(config.procedures)) procedures[name] = checkProcedure(name, p);

  function checkProcedure(name, p) {
    const at = `procedures.${name}`;
    if (!isRecord(p)) return error(at, 'a Procedure must be an object');
    unknownKeys(p, PROCEDURE_KEYS, at);
    const actions = Array.isArray(p.actions) ? p.actions : [];
    if (!actions.length) error(at, 'actions must be a non-empty list');
    const ids = [];
    let agent = null;
    let schema = refs.ANY;
    let schemaName = null;
    const checks = [];
    const responseConditions = [];
    actions.forEach((a, i) => {
      const atA = `${at}.actions[${i}]`;
      if (!isRecord(a)) return error(atA, 'an Action must be an object');
      if (typeof a.id !== 'string' || !/^[^\s:.]+$/.test(a.id)) error(atA, `Action id ${json(a.id)} must be non-empty with no ":", "." or whitespace`);
      else if (ids.includes(a.id)) error(atA, `Action id ${json(a.id)} is repeated`);
      else if (HEADS.includes(a.id)) error(atA, `Action id ${json(a.id)} is reserved for gg's references: ${HEADS.join(', ')}`);
      ids.push(a.id);
      if (!Object.hasOwn(ACTION_KEYS, a.do)) return error(atA, `do ${json(a.do)} is not one of ${Object.keys(ACTION_KEYS).join(', ')}`);
      if (a.do === 'check' && !Object.hasOwn(CHECK_KEYS, a.kind)) {
        checks.push(a);
        return error(atA, `Check kind ${json(a.kind)} is not one of ${Object.keys(CHECK_KEYS).join(', ')}`);
      }
      unknownKeys(a, ['id', 'do', ...ACTION_KEYS[a.do], ...(a.do === 'check' ? CHECK_KEYS[a.kind] : [])], atA);
      const template = (key) => { if (!isName(a[key])) error(atA, `${key} must name a file`); };
      const optionalTemplate = (key) => { if (a[key] !== undefined) template(key); };
      if (a.do === 'agent') {
        if (agent) return error(atA, 'a Procedure has at most one agent Action');
        agent = a;
        template('brief');
        if (isName(a.schema)) {
          schemaName = a.schema;
          schema = loadSchema(a.schema, atA);
        } else template('schema');
      } else if (a.do === 'check') {
        checks.push(a);
        optionalTemplate('recoverBrief');
        if (a.recoverable !== undefined && typeof a.recoverable !== 'boolean') error(atA, 'recoverable must be true or false');
        if (a.kind === 'command' || a.kind === 'tests-fail') {
          // U13: a Check names a Declared Command, never a command line.
          if (!Object.hasOwn(config.commands ?? {}, a.command)) error(atA, `Check ${a.id} names command ${json(a.command)}, which the repository Layer does not declare`);
        }
        if (a.kind === 'command' && a.reuse !== undefined && a.reuse !== 'tree') error(atA, 'reuse may only be tree');
        if (a.kind === 'response') responseConditions.push([a, atA]);
        if (a.kind === 'repeat' && !(Array.isArray(a.fields) && a.fields.length && a.fields.every(isName))) error(atA, 'fields must be a non-empty list of field names');
      } else if (a.do === 'commit') {
        if (!isName(a.type)) error(atA, 'type must name the commit type');
      } else if (a.do === 'pr-upsert') {
        template('body');
        if (a.with !== undefined && !isRecord(a.with)) error(atA, 'with must be an object of reference paths');
      } else if (a.do === 'comment') {
        if (a.target !== 'pr' && a.target !== 'ticket') error(atA, 'target must be pr or ticket');
        template('body');
      } else if (a.do === 'await-approval') {
        // The decisions' own rules are #119's.
        if (!(Array.isArray(a.decisions) && a.decisions.length && a.decisions.every(isName))) error(atA, 'decisions must be a non-empty list of names');
      }
    });
    const checkIds = checks.map((c) => c.id);

    let claims;
    if (!agent) {
      // R11f: no agent Action, so the implicit Claim ok requires every Check.
      if (p.claims !== undefined) error(`${at}.claims`, 'a Procedure with no agent Action declares no claims: its implicit Claim ok requires every Check it declares');
      claims = { ok: { requires: checkIds } };
    } else if (!isRecord(p.claims) || !Object.keys(p.claims).length) {
      error(`${at}.claims`, 'a Procedure with an agent Action declares its claims');
      claims = {};
    } else {
      claims = {};
      for (const [token, c] of Object.entries(p.claims)) {
        const atC = `${at}.claims.${token}`;
        if (reserved(token)) error(atC, `Claim token ${json(token)} ${RESERVED}`);
        if (isRecord(c) && c.stop === true && Object.keys(c).every((k) => k === 'stop' || k === 'comment')) {
          if (c.comment !== undefined && !isName(c.comment)) error(atC, 'comment must name a file');
        } else if (isRecord(c) && Array.isArray(c.requires) && Object.keys(c).length === 1) {
          for (const id of c.requires) if (!checkIds.includes(id)) error(atC, `requires ${json(id)}, which is not a Check of this Procedure`);
        } else {
          error(atC, 'a Claim token is { requires: [<check ids>] } or { stop: true, comment?: <file> }');
        }
        claims[token] = c;
      }
      if (schema !== refs.ANY) {
        try {
          assertClaimEnum(schema, Object.keys(p.claims));
        } catch (e) {
          error(`${at}.claims`, `${schemaName}: ${e.message}`);
        }
      }
    }
    const passing = Object.keys(claims).filter((t) => !claims[t]?.stop);
    const tokens = {
      passed: passing,
      failed: passing.filter((t) => claims[t]?.requires?.length),
      stopped: Object.keys(claims).filter((t) => claims[t]?.stop),
    };
    // A Check every passing token requires has passed wherever the passed table applies.
    const alwaysPassed = checkIds.filter((id) => passing.length && passing.every((t) => claims[t]?.requires?.includes(id)));

    const tests = p.tests ?? 'frozen';
    if (!(tests === 'frozen' || tests === 'write' || (isRecord(tests) && Object.keys(tests).length === 1 && Object.hasOwn(tests, 'named')))) {
      error(`${at}.tests`, 'tests must be frozen, write or { named: <reference path> }');
    }
    if (p.access !== undefined && p.access !== 'read-only') error(`${at}.access`, 'access may only be read-only');
    if (p.recover !== undefined) {
      if (!isRecord(p.recover) || !isCount(p.recover.max) || !isName(p.recover.brief) || Object.keys(p.recover).length !== 2) {
        error(`${at}.recover`, 'recover is { max: <positive integer>, brief: <file> }');
      } else if (!agent) error(`${at}.recover`, 'recover resumes the agent Action, which this Procedure lacks');
    }
    const tables = {};
    for (const table of TABLES) {
      const rows = p[table] ?? [];
      tables[table] = Array.isArray(rows) ? rows : [];
      if (!Array.isArray(rows)) { error(`${at}.${table}`, `${table} must be a list of rows`); continue; }
      if (rows.length && !tokens[table].length) error(`${at}.${table}`, `${NO_TOKEN[table]}, so the ${table} table never applies`);
      rows.forEach((row, r) => {
        const atR = `${at}.${table}[${r}]`;
        if (!isRecord(row) || !isRecord(row.when) || typeof row.outcome !== 'string' || Object.keys(row).length !== 2) {
          return error(atR, 'a row is { when: { <field>: <condition> }, outcome: <name> }');
        }
        if (reserved(row.outcome)) error(atR, `outcome ${json(row.outcome)} ${RESERVED}`);
      });
    }
    if (p.otherwise !== undefined) {
      if (!isName(p.otherwise)) error(`${at}.otherwise`, 'otherwise must name an Outcome');
      else if (reserved(p.otherwise)) error(`${at}.otherwise`, `otherwise ${json(p.otherwise)} ${RESERVED}`);
    }

    for (const [check, atA] of responseConditions) {
      if (!agent) { error(atA, 'a response Check reads the agent Action\'s response, which this Procedure lacks'); continue; }
      const list = check['all-of'];
      if (list === undefined) for (const m of conditionProblems(check, schema)) error(atA, m);
      else if (!Array.isArray(list) || !list.length || CONDITION_KEYS.some((k) => Object.hasOwn(check, k))) error(atA, 'all-of is a non-empty list of conditions, alone');
      else list.forEach((c, i) => { for (const m of conditionProblems(c, schema)) error(atA, `all-of[${i}]: ${m}`); });
    }

    // Every typed reference, given a scope for `inputs`: ANY when typing the Procedure alone, a Vertex's inputs after.
    function typeRefs(inputs, optional) {
      const found = [];
      const scope = (table) => object({
        claim: { type: 'string', enum: tokens[table] },
        pass: { type: 'integer', min: 1, max: 1 + (isCount(p.recover?.max) ? p.recover.max : 0) },
        check: object(Object.fromEntries(checkIds.map((id) => [id, table === 'passed' && alwaysPassed.includes(id) ? { type: 'string', enum: ['passed'] } : STATES]))),
        ...(agent && { response: schema }),
        inputs,
        ...Object.fromEntries(actions.filter((a) => isRecord(a) && typeof a.id === 'string').map((a) => [a.id, outputs(a, schema)])),
      });
      const ref = (where, path, s, want) => {
        const r = refs.resolve(s, path);
        const message = r.error ?? (r.type && want(r.type, r.node, path));
        if (message) found.push({ where, path, message });
        return r;
      };
      const stringList = (label) => (type, _, path) => (type.kind === 'list' && type.of?.kind === 'string' ? null
        : `${label} must read a list of strings; ${json(path)} is ${json(type)}`);
      const any = () => null;
      if (isRecord(tests)) ref('tests', tests.named, scope('passed'), stringList('tests: named'));
      actions.forEach((a, i) => {
        if (!isRecord(a)) return;
        const where = `actions[${i}]`;
        if (a.do === 'check' && a.kind === 'tests-fail') ref(where, a.names, scope('passed'), stringList('names'));
        if (a.do === 'check' && a.kind === 'repeat') {
          ref(where, a.list, scope('passed'), (type, node) => {
            if (!(type.kind === 'list' && type.of?.kind === 'object')) return `list must read a list of objects; ${json(a.list)} is ${json(type)}`;
            const field = (a.fields ?? []).find((f) => isName(f) && refs.resolve(node.items, f).error);
            return field === undefined ? null : `fields: ${json(field)} is not a field of the list's items`;
          });
        }
        if (a.do === 'pr-upsert') for (const path of Object.values(isRecord(a.with) ? a.with : {})) ref(where, path, scope('passed'), any);
      });
      const falls = {};
      for (const table of TABLES) {
        const fields = {};
        let typed = true;
        tables[table].forEach((row, r) => {
          if (!isRecord(row?.when)) return;
          for (const [path, cond] of Object.entries(row.when)) {
            const where = `${table}[${r}]`;
            if (!validCondition(cond)) {
              typed = false;
              found.push({ where, path, message: `condition on ${json(path)} must be a string, boolean or integer, or an object of ${OPS.join(', ')} with integers` });
              continue;
            }
            const { type, error: e } = ref(where, path, scope(table), (t) => (['enum', 'boolean', 'integer'].includes(t.kind) ? null
              : `rule field ${json(path)} is ${json(t)}; rules match only enum, boolean and integer fields`));
            if (e || !type || !['enum', 'boolean', 'integer'].includes(type.kind)) { typed = false; continue; }
            const fits = type.kind === 'integer' ? typeof cond !== 'string' && typeof cond !== 'boolean'
              : typeof cond === (type.kind === 'boolean' ? 'boolean' : 'string');
            if (!fits) {
              typed = false;
              found.push({ where, path, message: `condition ${json(cond)} on ${json(path)} does not fit its field, which is ${json(type)}` });
              continue;
            }
            // T10: an absent optional input is a value of the domain.
            const input = refs.parse(path).steps;
            fields[path] = { ...type, ...(input[0] === 'inputs' && optional(input[1]) && { absent: true }) };
          }
        });
        if (typed && tokens[table].length) falls[table] = { fields, rows: tables[table] };
      }
      return { found, falls };
    }

    return { name, at, agent, claims, checks, checkIds, tests, access: p.access ?? null, tokens, tables, otherwise: p.otherwise,
      recover: p.recover ?? null, definition: p, typeRefs };
  }

  const isInputPath = (path) => typeof path === 'string' && refs.parse(path).steps?.[0] === 'inputs';
  // A Procedure's typed references, typed alone (`inputs` ANY) or at a Vertex: alone it reports everything but the
  // references to `inputs` and the tables that read one, which each Vertex using it reports in its own scope.
  function runRefs(proc, inputs, optional, atVertex, atOf) {
    const { found, falls } = proc.typeRefs(inputs, optional);
    for (const f of found) if (atVertex === isInputPath(f.path)) error(atOf(f.where), f.message);
    const result = {};
    for (const [table, { fields, rows }] of Object.entries(falls)) {
      if (atVertex !== Object.keys(fields).some(isInputPath)) continue;
      const analysis = analyse({ name: `${proc.name}.${table}`, fields, rows });
      for (const e of analysis.errors) error(atOf(table), e.message);
      for (const w of analysis.warnings) warnings.push({ at: atOf(table), message: w.message });
      result[table] = analysis.defaultExample !== null;
    }
    return result;
  }
  const procedureFalls = {};
  for (const proc of Object.values(procedures)) {
    if (proc) procedureFalls[proc.name] = runRefs(proc, refs.ANY, () => false, false, (where) => `${proc.at}.${where}`);
  }

  const flows = {};
  if (!isRecord(config.flows) || !Object.keys(config.flows).length) error('flows', 'no Flow is declared; gg init writes an example');
  for (const [name, f] of entries(config.flows)) flows[name] = checkFlow(name, f);

  function checkTarget(target, vertices, at, { allowMax }) {
    if (typeof target === 'string') {
      if (!Object.hasOwn(vertices, target)) error(at, `${json(target)} is not a Vertex`);
    } else if (isRecord(target) && Object.hasOwn(target, 'end') && Object.keys(target).length === 1) {
      if (target.end === 'done') error(at, 'end "done" is the human-only end, which no route may name');
      else if (!ENDS.includes(target.end)) error(at, `end ${json(target.end)} is not one of ${ENDS.join(', ')}`);
    } else if (allowMax && isRecord(target) && Object.hasOwn(target, 'to')) {
      unknownKeys(target, ['to', 'max', 'exhausted'], at);
      checkTarget(target.to, vertices, at, { allowMax: false });
      if (target.max !== undefined && !isCount(target.max)) error(at, 'max must be a positive integer');
      if (target.exhausted !== undefined) checkTarget(target.exhausted, vertices, at, { allowMax: false });
    } else {
      error(at, 'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }');
    }
  }

  function checkFlow(name, f) {
    const at = `flows.${name}`;
    if (!isRecord(f)) return error(at, 'a Flow must be an object');
    unknownKeys(f, ['plan', 'actionCap', 'ticket'], at);
    // X2b, X2d: plan is never defaulted, and must be null until Epic planning is built.
    if (!Object.hasOwn(f, 'plan')) error(at, 'plan is required: null when the Flow has no Epic-level planning');
    else if (f.plan !== null) error(`${at}.plan`, 'plan must be null until Epic planning is built');
    if (!isCount(f.actionCap)) error(`${at}.actionCap`, 'actionCap must be a positive integer');
    const ticket = isRecord(f.ticket) ? f.ticket : {};
    if (!isRecord(f.ticket)) error(`${at}.ticket`, 'ticket must be an object');
    unknownKeys(ticket, ['entry', 'routes', 'vertices'], `${at}.ticket`);
    const vertices = isRecord(ticket.vertices) ? ticket.vertices : {};
    if (!Object.keys(vertices).length) error(`${at}.ticket.vertices`, 'vertices must be a non-empty object');
    if (typeof ticket.entry !== 'string' || !Object.hasOwn(vertices, ticket.entry)) error(`${at}.ticket.entry`, `${json(ticket.entry)} is not a Vertex`);
    for (const [outcome, target] of entries(ticket.routes)) checkTarget(target, vertices, `${at}.ticket.routes.${outcome}`, { allowMax: true });

    const procedureOf = (v) => (isRecord(v) && Object.hasOwn(procedures, v.procedure) ? procedures[v.procedure] : null);
    // `<vertex>.<action id>.<output>` and `<vertex>.rescue` (W2, W3), for every input's `from`.
    const scope = object(Object.fromEntries(Object.entries(vertices).map(([id, v]) => {
      const proc = procedureOf(v);
      if (!proc) return [id, refs.ANY];
      const schema = proc.agent ? schemas.get(proc.agent.schema)?.node ?? refs.ANY : refs.ANY;
      const actions = (proc.definition.actions ?? []).filter((a) => isRecord(a) && typeof a.id === 'string');
      return [id, object({ rescue: OPAQUE, ...Object.fromEntries(actions.map((a) => [a.id, outputs(a, schema)])) })];
    })));

    const resolved = {};
    const used = new Set();
    for (const [id, v] of Object.entries(vertices)) {
      const atV = `${at}.ticket.vertices.${id}`;
      if (RESERVED_VERTICES.includes(id)) error(atV, `Vertex id ${json(id)} is reserved: an end name, cleanup or done`);
      if (!isRecord(v)) { error(atV, 'a Vertex must be an object'); continue; }
      unknownKeys(v, VERTEX_KEYS, atV);
      const proc = procedureOf(v);
      if (!isRecord(config.procedures) || !Object.hasOwn(config.procedures, v.procedure)) error(atV, `procedure ${json(v.procedure)} is not declared`);
      if (proc) used.add(proc.name);

      const overrides = Object.fromEntries(Object.entries(v).filter(([k]) => AGENT_KEYS.includes(k)));
      let agent = null;
      if (v.use !== undefined && !Object.hasOwn(config.agents ?? {}, v.use)) error(atV, `uses agent ${json(v.use)}, which is not declared`);
      else if (proc && !proc.agent && (v.use !== undefined || Object.keys(overrides).length)) error(atV, `procedure ${proc.name} has no agent Action, so the Vertex takes no Agent`);
      else if (proc?.agent) {
        const library = v.use === undefined ? {} : config.agents[v.use];
        const merged = { ...library, ...overrides };
        if (!Object.keys(merged).length) error(atV, `procedure ${proc.name} has an agent Action, so the Vertex needs an Agent`);
        else {
          const label = v.use === undefined ? `the agent of Vertex ${id}` : `agent ${v.use}`;
          if (merged.harness == null) error(atV, `${label} names no harness; set one in a user or repository Layer`);
          else if (!Object.hasOwn(harnesses, merged.harness)) error(atV, `${label} names harness ${json(merged.harness)}, which is not registered`);
          agent = { ...merged, harness: merged.harness ?? null, model: merged.model ?? null, effort: merged.effort ?? null };
        }
      }

      const inputs = {};
      const nodes = {};
      for (const [input, decl] of entries(v.inputs)) {
        const atI = `${atV}.inputs.${input}`;
        if (!isRecord(decl)) { error(atI, 'an input is { from, optional?, pick? }'); continue; }
        unknownKeys(decl, ['from', 'optional', 'pick'], atI);
        if (decl.optional !== undefined && typeof decl.optional !== 'boolean') error(atI, 'optional must be true or false');
        const from = Array.isArray(decl.from) ? decl.from : [decl.from];
        if (!from.length) error(atI, 'from must name at least one source');
        inputs[input] = { from, optional: decl.optional === true, ...(decl.pick !== undefined && { pick: decl.pick }) };
        // T6: every source of one input has one type.
        let first = null;
        for (const source of from) {
          const r = refs.resolve(scope, source);
          if (r.error) { error(atI, r.error); continue; }
          if (r.node === refs.ANY) continue;
          if (!first) first = { source, node: r.node };
          else if (typeKey(first.node) !== typeKey(r.node)) error(atI, `sources ${json(first.source)} and ${json(source)} have different types`);
        }
        let node = first?.node ?? refs.ANY;
        if (decl.pick !== undefined && node !== refs.ANY) {
          const type = refs.kindOf(node);
          if (!(type.kind === 'list' && type.of?.kind === 'object')) { error(atI, `pick needs a list of objects; ${json(first.source)} is ${json(type)}`); node = refs.ANY; }
          else {
            const r = refs.resolve(node, decl.pick);
            if (r.error) { error(atI, `pick: ${r.error}`); node = refs.ANY; } else node = r.node;
          }
        } else if (decl.pick !== undefined && refs.parse(decl.pick).error) error(atI, `pick: ${refs.parse(decl.pick).error}`);
        nodes[input] = node;
      }

      for (const [outcome, target] of entries(v.route)) checkTarget(target, vertices, `${atV}.route.${outcome}`, { allowMax: true });
      if (v.route !== undefined && !isRecord(v.route)) error(`${atV}.route`, 'route must be an object from Outcome to target');
      if (v.maxVisits !== undefined && !isCount(v.maxVisits)) error(`${atV}.maxVisits`, 'maxVisits must be a positive integer');
      if (v.exhausted !== undefined) checkTarget(v.exhausted, vertices, `${atV}.exhausted`, { allowMax: false });

      let falls = procedureFalls[proc?.name] ?? {};
      if (proc) {
        falls = { ...falls, ...runRefs(proc, object(nodes), (input) => inputs[input]?.optional === true,
          true, (where) => `${atV} (procedure ${proc.name}).${where}`) };
      }
      resolved[id] = {
        use: v.use ?? null,
        agent,
        procedure: v.procedure,
        access: proc?.access === 'read-only' ? 'read-only' : agent?.access ?? null,
        tests: proc?.tests ?? null,
        outcomes: proc ? outcomesOf(proc, falls) : [],
        inputs,
        route: v.route ?? {},
        maxVisits: v.maxVisits ?? null,
        exhausted: v.exhausted ?? null,
      };
    }
    const effective = Object.fromEntries([...used].map((p) => {
      const { definition, claims, tests, access, tables, otherwise, recover, checks } = procedures[p];
      return [p, { actions: definition.actions, claims, tests, access, recover, ...tables, otherwise: otherwise ?? null, checks: checks.map((c) => c.id) }];
    }));
    return { name, plan: f.plan ?? null, actionCap: f.actionCap ?? null, procedures: effective,
      ticket: { entry: ticket.entry ?? null, routes: ticket.routes ?? {}, vertices: resolved } };
  }

  return { flows, errors: dedupe(errors), warnings: dedupe(warnings) };
}

const dedupe = (list) => [...new Map(list.map((e) => [`${e.at}\n${e.message}`, e])).values()];

function validCondition(cond) {
  if (typeof cond === 'string' || typeof cond === 'boolean' || Number.isInteger(cond)) return true;
  return isRecord(cond) && Object.keys(cond).length > 0 && Object.entries(cond).every(([op, v]) => OPS.includes(op) && Number.isInteger(v));
}

// The Outcomes a Procedure can produce (R12b, T7): each table's rows, and its default when some input falls through.
function outcomesOf(proc, falls) {
  const { tokens, tables, otherwise } = proc;
  const out = [];
  const add = (table, fallback) => {
    if (!tokens[table].length) return;
    out.push(...tables[table].map((row) => row?.outcome).filter((o) => typeof o === 'string'));
    if (falls[table] !== false) out.push(...fallback);
  };
  add('passed', otherwise ? [otherwise] : tokens.passed);
  add('failed', [otherwise ?? 'failed']);
  add('stopped', tokens.stopped);
  if (proc.agent) out.push(...HARNESS_OUTCOMES);
  return unique(out);
}

// R4a, P5d: one response condition, read against the agent's response schema.
function conditionProblems(cond, schema) {
  if (!isRecord(cond)) return ['a condition must be an object'];
  const form = ['field', 'none', 'any', 'all', 'count'].filter((k) => Object.hasOwn(cond, k));
  if (form.length !== 1) return ['a condition is { field, is }, { none | any | all: <list>, where }, or { count: <list>, where, <op>: <integer> }'];
  const typed = (path) => {
    const r = refs.resolve(schema, path);
    return r.error ? { error: r.error } : r;
  };
  const value = (type, v) => (type === null ? null
    : type.kind === 'boolean' ? (typeof v === 'boolean' ? null : `${json(v)} is not true or false`)
      : type.kind === 'enum' ? (type.values.includes(v) ? null : `${json(v)} is not one of ${type.values.join(' | ')}`)
        : `the field is ${json(type)}; a response condition reads only enum and boolean fields`);
  if (form[0] === 'field') {
    const { type, error } = typed(cond.field);
    if (error) return [error];
    if (type?.kind === 'boolean' && typeof cond.is !== 'boolean') return [`${json(cond.field)} is a boolean, so is must be true or false`];
    const problem = value(type, cond.is);
    return problem ? [`${json(cond.field)}: ${problem}`] : [];
  }
  const list = cond[form[0]];
  const { type, node, error } = typed(list);
  if (error) return [error];
  if (type && !(type.kind === 'list' && type.of?.kind === 'object')) return [`${form[0]} must read a list of objects; ${json(list)} is ${json(type)}`];
  const problems = [];
  if (form[0] === 'count') {
    const ops = OPS.filter((op) => Object.hasOwn(cond, op));
    if (ops.length !== 1 || !Number.isInteger(cond[ops[0]])) problems.push(`count takes one of ${OPS.join(', ')} with an integer`);
  }
  if (!isRecord(cond.where)) return [...problems, 'where must be an object of item fields'];
  for (const [field, v] of Object.entries(cond.where)) {
    const r = node && node !== refs.ANY ? refs.resolve(node.items, field) : { type: null };
    if (r.error) { problems.push(`where: ${r.error}`); continue; }
    for (const one of Array.isArray(v) ? v : [v]) {
      const problem = value(r.type, one);
      if (problem) problems.push(`where ${json(field)}: ${problem}`);
    }
  }
  return problems;
}
