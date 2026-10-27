// The Flow validator (V1): everything the configuration decides, checked before any agent runs, giving each Flow's
// Resolved Flow plus errors and warnings.

import { assertClaimEnum, assertStrict } from './briefs.mjs';
import * as refs from './refs.mjs';
import { analyse } from './rules.mjs';

const ENDS = ['ready-for-qa', 'needs-human', 'needs-replan'];
// `cleanup` is the Pending cleanup hold's Await Label (L11) and `done` the human-only end (L12).
const RESERVED_VERTICES = [...ENDS, 'cleanup', 'done'];
const HARNESS_OUTCOMES = ['harness-timeout', 'harness-transient', 'harness-unparsed'];
// R12c, T7: the engine's own Outcomes, which end at needs-human unless routed.
const ENGINE_OUTCOMES = ['failed', ...HARNESS_OUTCOMES];
const NEEDS_HUMAN = { end: 'needs-human' };
const PR_READY = 'pr-ready';
// shortcut: the path analysis enumerates paths' states, exponential in a Flow's bounds and inputs; the example reaches
// a few thousand. Past this admission fails; a summary per bounded edge would lift it if real Flows get there.
const PATH_STATES = 100_000;
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
// A string key only: Object.hasOwn would coerce a list such as ["push"] to the key it spells.
const has = (o, key) => typeof key === 'string' && isRecord(o) && Object.hasOwn(o, key);
const isName = (v) => typeof v === 'string' && v.trim() !== '';
const isCount = (v) => Number.isInteger(v) && v > 0;
const entries = (v) => (isRecord(v) ? Object.entries(v) : []);
const unique = (list) => [...new Set(list)];
const json = JSON.stringify;
const reserved = (name) => name === 'failed' || ENDS.includes(name) || name.startsWith('harness-');
const RESERVED = 'is reserved for the engine: failed, an end name or harness-*';

// Strict like a response schema's objects, so an output and a response field of the same fields are one type.
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const STRING = { type: 'string' };
const INTEGER = { type: 'integer' };
const STRING_LIST = { type: 'array', items: STRING };
const STATES = ['passed', 'failed', 'not-run'];
// gg's own outputs: a Check's evidence (checks.evidence), an Action's cleanup (L11, exec's survivors) and a Vertex's
// rescue (W3), whose diffStat is events.diffStats' totals.
const EVIDENCE = object({ command: STRING, output: STRING });
const CLEANUP = object({ confirmed: { type: 'boolean' }, survivors: { type: 'array', items: object({ pid: INTEGER, error: STRING }) } });
const RESCUE = object({ ref: STRING, output: STRING,
  diffStat: object({ files: INTEGER, insertions: INTEGER, deletions: INTEGER, testFiles: INTEGER, testInsertions: INTEGER }) });
// What each Action kind produces, as `<action id>.<output>` (W2); an agent's response is typed by its schema.
const outputs = (action, schema) => object(action.do === 'agent' ? { response: schema, cleanup: CLEANUP }
  : action.do === 'check' ? { evidence: EVIDENCE, cleanup: CLEANUP }
    : action.do === 'commit' ? { files: STRING_LIST } : {});
// Two schemas are one type when they differ only in key order or in the order of required or enum.
const typeKey = (node) => json(node, (k, v) => (Array.isArray(v) && (k === 'required' || k === 'enum') ? [...v].sort()
  : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));

export function validate(config, { harnesses, readSchema }) {
  if (!isRecord(config)) return { flows: {}, errors: [{ at: '(root)', message: 'the configuration must be an object' }], warnings: [] };
  const errors = [];
  const warnings = [];
  const error = (at, message) => { errors.push({ at, message }); };
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

  if (config.procedures !== undefined && !isRecord(config.procedures)) error('procedures', 'procedures must be an object from name to Procedure');
  if (config.agents !== undefined && !isRecord(config.agents)) error('agents', 'agents must be an object from name to Agent');
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
      if (!has(ACTION_KEYS, a.do)) return error(atA, `do ${json(a.do)} is not one of ${Object.keys(ACTION_KEYS).join(', ')}`);
      if (a.do === 'check' && !has(CHECK_KEYS, a.kind)) {
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
          if (!has(config.commands, a.command)) error(atA, `Check ${a.id} names command ${json(a.command)}, which the repository Layer does not declare`);
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
        claims[token] = isRecord(c) && c.stop === true ? { stop: true, ...(c.comment !== undefined && { comment: c.comment }) }
          : { requires: isRecord(c) && Array.isArray(c.requires) ? c.requires : [] };
      }
      if (schema !== refs.ANY) {
        try {
          assertClaimEnum(schema, Object.keys(p.claims));
        } catch (e) {
          error(`${at}.claims`, `${schemaName}: ${e.message}`);
        }
      }
    }
    const required = (token) => unique(claims[token].requires ?? []).filter((id) => checkIds.includes(id));
    const passing = Object.keys(claims).filter((t) => !claims[t].stop);
    const tokens = {
      passed: passing,
      failed: passing.filter((t) => required(t).length),
      stopped: Object.keys(claims).filter((t) => claims[t].stop),
    };

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
    const malformed = new Set();
    for (const table of TABLES) {
      const rows = p[table] ?? [];
      tables[table] = Array.isArray(rows) ? rows : [];
      if (!Array.isArray(rows)) { error(`${at}.${table}`, `${table} must be a list of rows`); continue; }
      if (rows.length && !tokens[table].length) error(`${at}.${table}`, `${NO_TOKEN[table]}, so the ${table} table never applies`);
      rows.forEach((row, r) => {
        const atR = `${at}.${table}[${r}]`;
        if (!isRecord(row) || !isRecord(row.when) || typeof row.outcome !== 'string' || Object.keys(row).length !== 2) {
          malformed.add(table);
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
        check: object(Object.fromEntries(checkIds.map((id) => [id, { type: 'string', enum: STATES }]))),
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
            const field = (Array.isArray(a.fields) ? a.fields : []).find((f) => isName(f) && refs.resolve(node.items, f).error);
            return field === undefined ? null : `fields: ${json(field)} is not a field of the list's items`;
          });
        }
        if (a.do === 'pr-upsert') for (const path of Object.values(isRecord(a.with) ? a.with : {})) ref(where, path, scope('passed'), any);
      });
      const falls = {};
      for (const table of TABLES) {
        const fields = {};
        let typed = !malformed.has(table);
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

    // R11d: pr-ready runs only on fresh passing Checks, so every token it can run under requires one.
    const ready = actions.findIndex((a) => isRecord(a) && a.do === 'pr-ready');
    for (const token of ready === -1 ? [] : tokens.passed) {
      if (!claims[token].requires.length) error(`${at}.actions[${ready}]`, `pr-ready publishes only after passing Checks, but Claim token ${token} requires none`);
    }

    return { name, at, agent, actions, claims, required, checks, tests, access: p.access ?? null, tokens, tables, otherwise: p.otherwise,
      recover: p.recover ?? null, typeRefs };
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
      const analysis = analyseTable(proc, table, fields, rows);
      for (const message of analysis.errors) error(atOf(table), message);
      for (const w of analysis.warnings) warnings.push({ at: atOf(table), message: w.message });
      result[table] = analysis.falls;
    }
    return result;
  }
  const procedureFalls = {};
  for (const proc of Object.values(procedures)) {
    if (proc) procedureFalls[proc.name] = runRefs(proc, refs.ANY, () => false, false, (where) => `${proc.at}.${where}`);
  }

  const flows = {};
  let graphErrors = 0;
  if (config.flows !== undefined && !isRecord(config.flows)) error('flows', 'flows must be an object from name to Flow');
  else if (!Object.keys(config.flows ?? {}).length) error('flows', 'no Flow is declared; gg init writes an example');
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
    if (ticket.routes !== undefined && !isRecord(ticket.routes)) error(`${at}.ticket.routes`, 'routes must be an object from Outcome to target');
    for (const [outcome, target] of entries(ticket.routes)) checkTarget(target, vertices, `${at}.ticket.routes.${outcome}`, { allowMax: true });

    const procedureOf = (v) => (isRecord(v) && has(procedures, v.procedure) ? procedures[v.procedure] : null);
    // `<vertex>.<action id>.<output>` and `<vertex>.rescue` (W2, W3), for every input's `from`.
    const scope = object(Object.fromEntries(Object.entries(vertices).map(([id, v]) => {
      const proc = procedureOf(v);
      if (!proc) return [id, refs.ANY];
      const schema = proc.agent ? schemas.get(proc.agent.schema)?.node ?? refs.ANY : refs.ANY;
      const actions = proc.actions.filter((a) => isRecord(a) && typeof a.id === 'string');
      return [id, object({ rescue: RESCUE, ...Object.fromEntries(actions.map((a) => [a.id, outputs(a, schema)])) })];
    })));

    const resolved = {};
    const used = new Set();
    const procs = {};
    const typedOf = {};
    for (const [id, v] of Object.entries(vertices)) {
      const atV = `${at}.ticket.vertices.${id}`;
      if (RESERVED_VERTICES.includes(id)) error(atV, `Vertex id ${json(id)} is reserved: an end name, cleanup or done`);
      if (!isRecord(v)) { error(atV, 'a Vertex must be an object'); continue; }
      unknownKeys(v, VERTEX_KEYS, atV);
      const proc = procedureOf(v);
      if (!has(config.procedures, v.procedure)) error(atV, `procedure ${json(v.procedure)} is not declared`);
      if (proc) used.add(proc.name);

      const overrides = Object.fromEntries(Object.entries(v).filter(([k]) => AGENT_KEYS.includes(k)));
      let agent = null;
      if (v.use !== undefined && !has(config.agents, v.use)) error(atV, `uses agent ${json(v.use)}, which is not declared`);
      else if (proc && !proc.agent && (v.use !== undefined || Object.keys(overrides).length)) error(atV, `procedure ${proc.name} has no agent Action, so the Vertex takes no Agent`);
      else if (proc?.agent) {
        const library = v.use === undefined ? {} : config.agents[v.use];
        const merged = { ...library, ...overrides };
        if (!isRecord(library)) error(atV, `agent ${v.use} must be an object`);
        else if (!Object.keys(merged).length) error(atV, `procedure ${proc.name} has an agent Action, so the Vertex needs an Agent`);
        else {
          const label = v.use === undefined ? `the agent of Vertex ${id}` : `agent ${v.use}`;
          if (merged.harness == null) error(atV, `${label} names no harness; set one in a user or repository Layer`);
          else if (!has(harnesses, merged.harness)) error(atV, `${label} names harness ${json(merged.harness)}, which is not registered`);
          agent = { ...merged, harness: merged.harness ?? null, model: merged.model ?? null, effort: merged.effort ?? null };
        }
      }

      const inputs = {};
      const nodes = {};
      if (v.inputs !== undefined && !isRecord(v.inputs)) error(`${atV}.inputs`, 'inputs must be an object from name to { from, optional?, pick? }');
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
        routing: {},
        inputs,
        route: v.route ?? {},
        maxVisits: v.maxVisits ?? null,
        exhausted: v.exhausted ?? null,
      };
      procs[id] = proc;
      typedOf[id] = proc?.typeRefs(object(nodes), (input) => inputs[input]?.optional === true).falls ?? {};
    }
    checkGraph(at, ticket, resolved, procs, typedOf);
    const effective = Object.fromEntries([...used].map((p) => {
      const { actions, claims, tests, access, tables, otherwise, recover, checks } = procedures[p];
      return [p, { actions, claims, tests, access, recover, ...tables, otherwise: otherwise ?? null, checks: checks.map((c) => c.id) }];
    }));
    return { name, plan: f.plan ?? null, actionCap: f.actionCap ?? null, procedures: effective,
      ticket: { entry: ticket.entry ?? null, routes: ticket.routes ?? {}, vertices: resolved } };
  }

  // The graph checks, per Outcome (S4): routing (R12b, R12c, T3), bounds (I3, V3), commits (S2, T1c), pr-ready before
  // ready-for-qa (R11e) and inputs (Q7, T9), over every path from the entry; unreachable Vertices are warned.
  function checkGraph(at, ticket, resolved, procs, typedOf) {
    // The graph reads Procedures, routes and inputs as declared, so its checks wait until no other check has failed;
    // `routing` is filled in either way, for gg doctor.
    const clean = errors.length === graphErrors;
    const fail = (where, message) => {
      if (!clean) return;
      error(where, message);
      graphErrors++;
    };
    const atV = (id) => `${at}.ticket.vertices.${id}`;
    const isVertex = (t) => typeof t === 'string' && Object.hasOwn(resolved, t);
    // U5: a target lands on its Vertex, or on an exhausted target once the edge's max or the Vertex's maxVisits is
    // spent (needs-human when none is named). `exhausted` marks a landing that no edge max bounds.
    const lands = (target, exhausted = false, seen = []) => {
      if (isRecord(target) && Object.hasOwn(target, 'to')) {
        return [...lands(target.to, exhausted, seen), ...(isCount(target.max) ? lands(target.exhausted ?? NEEDS_HUMAN, true, seen) : [])];
      }
      if (isRecord(target)) return ENDS.includes(target.end) ? [{ end: target.end, exhausted }] : [];
      if (!isVertex(target) || seen.includes(target)) return [];
      const v = resolved[target];
      return [{ vertex: target, exhausted }, ...(isCount(v.maxVisits) ? lands(v.exhausted ?? NEEDS_HUMAN, true, [...seen, target]) : [])];
    };
    // T3: the Flow's routes apply to every Outcome the Vertex does not route itself.
    const route = (v, outcome) => {
      for (const [by, routes, key] of [['Vertex route', v.route, outcome], ['Vertex "*"', v.route, '*'],
        ['Flow routes', ticket.routes, outcome], ['Flow "*"', ticket.routes, '*']]) {
        if (has(routes, key)) return { target: routes[key], by };
      }
      return ENGINE_OUTCOMES.includes(outcome) ? { target: NEEDS_HUMAN, by: 'engine default' } : null;
    };

    const edges = [];
    for (const [id, v] of Object.entries(resolved)) {
      const proc = procs[id];
      if (!proc) continue;
      const write = v.access !== null && v.access !== 'read-only';
      if (write && proc.tokens.passed.length) {
        if (!proc.actions.some((a) => isRecord(a) && a.do === 'commit')) {
          fail(atV(id), `Vertex ${id} writes, so it must commit on every passing path, but procedure ${proc.name} has no commit Action`);
        }
        for (const token of proc.tokens.passed) {
          if (!proc.claims[token].requires.length) fail(atV(id), `Vertex ${id} writes, so its committing Claim token ${token} must require a Check`);
        }
      }
      const cases = casesOf(proc, typedOf[id]);
      for (const outcome of v.outcomes) {
        const r = route(v, outcome);
        if (!r) { fail(atV(id), `Outcome ${outcome} is not routed by the Vertex or the Flow's routes`); continue; }
        const landings = lands(r.target);
        const mine = cases.filter((c) => c.outcome === outcome);
        const rescued = landings.some((l) => l.vertex);
        const left = landings.some((l) => l.end);
        v.routing[outcome] = { target: r.target, by: r.by,
          work: !write || mine.every((c) => c.table === 'passed') ? null
            : rescued && left ? 'rescued, or left in place once exhausted' : rescued ? 'rescued' : 'left in place' };
        edges.push({ from: id, outcome, target: r.target, landings, cases: mine, write });
      }
    }

    if (!clean) return;
    const bounded = (id) => isCount(resolved[id].maxVisits);
    const next = Object.fromEntries(Object.keys(resolved).map((id) => [id, []]));
    for (const e of edges) {
      for (const l of e.landings) {
        if (!l.vertex || bounded(e.from) || bounded(l.vertex) || (l.vertex === e.target?.to && !l.exhausted && isCount(e.target.max))) continue;
        next[e.from].push(l.vertex);
      }
    }
    for (const cycle of cycles(next)) {
      fail(`${at}.ticket`, `the cycle through ${cycle.join(', ')} has no edge with max and no Vertex with maxVisits; the Action Cap does not bound a cycle`);
    }

    const producer = (source) => {
      const [vertex, action, output] = refs.parse(source).steps;
      return action === 'rescue' ? `${vertex}.rescue` : `${vertex}.${action}.${output}`;
    };
    // Each input's sources, as the outputs that produce them.
    const groups = new Map();
    for (const v of Object.values(resolved)) for (const input of Object.values(v.inputs)) groups.set(json(input.from), input.from.map(producer));
    // The facts a Visit ending in case `c` adds: the inputs it produces a source of, and whether pr-ready ran.
    const gained = (e, c, toVertex, must) => {
      const keys = leaves(e.from, procs[e.from], c, e.write && toVertex, must);
      const facts = [...groups].filter(([, sources]) => sources.some((k) => keys.includes(k))).map(([g]) => g);
      return keys.includes(PR_READY) ? [...facts, PR_READY] : facts;
    };
    // U5 path by path, counting what a bound counts: an entry to an exhausted Vertex goes to its exhausted target; a
    // traversal of an exhausted edge to the edge's, unless the edge's Vertex is exhausted too, whose target wins.
    const spent = (counts, key, bound) => isCount(bound) && (counts[key] ?? 0) >= bound;
    const bump = (counts, key, bound) => (isCount(bound) ? { ...counts, [key]: (counts[key] ?? 0) + 1 } : counts);
    const enter = (target, counts, seen = []) => {
      if (isRecord(target)) return ENDS.includes(target.end) ? [{ end: target.end, counts }] : [];
      if (!isVertex(target) || seen.includes(target)) return [];
      const { maxVisits, exhausted } = resolved[target];
      const key = `visits ${json(target)}`;
      if (spent(counts, key, maxVisits)) return enter(exhausted ?? NEEDS_HUMAN, counts, [...seen, target]);
      return [{ vertex: target, counts: bump(counts, key, maxVisits) }];
    };
    const follow = (e, counts) => {
      const t = e.target;
      if (!(isRecord(t) && Object.hasOwn(t, 'to'))) return enter(t, counts);
      const key = `edge ${json([e.from, e.outcome])}`;
      if (!spent(counts, key, t.max)) return enter(t.to, bump(counts, key, t.max));
      const vertexSpent = isVertex(t.to) && spent(counts, `visits ${json(t.to)}`, resolved[t.to].maxVisits);
      return enter(vertexSpent ? t.to : t.exhausted ?? NEEDS_HUMAN, counts);
    };
    // Every state a path reaches: a Vertex, the facts holding at its entry and the bounds' counts, with one transition
    // per case of each Outcome. `must` adds what such a Visit surely leaves, otherwise what it may.
    const explore = (must) => {
      const states = new Map();
      const queue = [];
      const unready = [];
      let count = 0;
      const add = (v, facts, counts) => {
        const key = json([facts.toSorted(), Object.entries(counts).sort()]);
        if (!states.has(v)) states.set(v, new Map());
        if (states.get(v).has(key)) return;
        states.get(v).set(key, facts);
        queue.push([v, facts, counts]);
        count++;
      };
      for (const l of enter(ticket.entry, {})) if (l.vertex) add(l.vertex, [], l.counts);
      while (queue.length) {
        if (count > PATH_STATES) return null;
        const [u, facts, counts] = queue.pop();
        for (const e of edges) {
          if (e.from !== u) continue;
          for (const l of follow(e, counts)) {
            for (const c of e.cases) {
              const next = unique([...facts, ...gained(e, c, Boolean(l.vertex), must)]);
              if (l.vertex) add(l.vertex, next, l.counts);
              else if (l.end === 'ready-for-qa' && !next.includes(PR_READY)) unready.push(e);
            }
          }
        }
      }
      return { states: new Map([...states].map(([v, m]) => [v, [...m.values()]])), unready };
    };
    const every = explore(true);
    const some = every && explore(false)?.states;
    if (!some) {
      fail(`${at}.ticket`, `the paths reach more than ${PATH_STATES} states, so inputs and pr-ready cannot be checked; bound fewer edges and Vertices`);
      return;
    }
    for (const id of Object.keys(resolved)) if (!every.states.has(id)) warnings.push({ at: atV(id), message: `Vertex ${id} is not reachable from the entry` });
    for (const e of every.unready) fail(atV(e.from), `Outcome ${e.outcome} reaches end ready-for-qa on a path that runs no pr-ready`);
    for (const [id, v] of Object.entries(resolved)) {
      if (!every.states.has(id)) continue;
      for (const [name, input] of Object.entries(v.inputs)) {
        const g = json(input.from);
        if (!input.optional && !every.states.get(id).every((facts) => facts.includes(g))) {
          fail(`${atV(id)}.inputs.${name}`, `input ${name} is required, but some path to ${id} produces none of its sources`);
        }
        if (input.optional && !some.get(id).some((facts) => facts.includes(g))) {
          fail(`${atV(id)}.inputs.${name}`, `input ${name} is optional, but no path to ${id} produces any of its sources`);
        }
      }
    }
  }

  return { flows, errors: dedupe(errors), warnings: dedupe(warnings) };
}

// R8b: the boxes of a Claim token's legal inputs to a table, each the Check states it fixes: its required Checks
// passed in the passed table; in the failed table one box per required Check, the first not to pass.
function boxesOf(proc, table, token) {
  const req = proc.required(token);
  if (table === 'passed') return [Object.fromEntries(req.map((id) => [id, ['passed']]))];
  if (table === 'stopped') return [{}];
  return req.map((id, j) => Object.fromEntries([...req.slice(0, j).map((r) => [r, ['passed']]), [id, ['failed', 'not-run']]]));
}

// The ways a Procedure produces each Outcome: a box of one Claim token's inputs to one table, with the rows that fire
// in it and the table's default when some input falls through (R8b, T7); or a harness failure (table null). A table
// the analyser could not read may fire any row and fall through.
function casesOf(proc, typed) {
  const cases = [];
  for (const table of TABLES) {
    for (const token of proc.tokens[table]) {
      for (const checks of boxesOf(proc, table, token)) {
        const result = typed[table] && analyse({ name: `${proc.name}.${table}`, rows: typed[table].rows,
          fields: Object.fromEntries(Object.entries(typed[table].fields).map(([path, spec]) => {
            const [head, id] = refs.parse(path).steps;
            if (head === 'claim') return [path, { kind: 'enum', values: [token] }];
            return [path, head === 'check' && Object.hasOwn(checks, id) ? { kind: 'enum', values: checks[id] } : spec];
          })) });
        const exact = result && !result.errors.some((e) => e.row === null);
        const fired = proc.tables[table].filter((row, i) => typeof row?.outcome === 'string' && !(exact && result.errors.some((e) => e.row === i)));
        const fallback = table === 'failed' ? proc.otherwise ?? 'failed' : table === 'passed' ? proc.otherwise ?? token : token;
        const outcomes = unique([...fired.map((row) => row.outcome), ...(!exact || result.defaultExample !== null ? [fallback] : [])]);
        for (const outcome of outcomes) cases.push({ outcome, table, token, checks });
      }
    }
  }
  if (proc.agent) cases.push(...HARNESS_OUTCOMES.map((outcome) => ({ outcome, table: null, token: null, checks: {} })));
  return cases;
}

// The outputs a Visit of Vertex `id` leaves when it ends in case `c` (W2, W3): the agent's response on every Claim
// (N10); effects only on a passing Claim (S4); the rescue when failing work moves on to a Vertex (R5a); a Check's
// evidence only when it passed (N9): surely when its box fixes it passed, possibly when the box leaves it open.
function leaves(id, proc, c, rescued, must) {
  if (c.table === null) return rescued ? [`${id}.rescue`] : [];
  const passed = c.table === 'passed';
  const evidence = (check) => (Object.hasOwn(c.checks, check) ? json(c.checks[check]) === '["passed"]' : !must);
  const keys = [];
  for (const a of proc.actions) {
    if (!isRecord(a) || typeof a.id !== 'string') continue;
    if (a.do === 'agent') keys.push(`${id}.${a.id}.response`, `${id}.${a.id}.cleanup`);
    else if (a.do === 'check' && evidence(a.id)) keys.push(`${id}.${a.id}.evidence`, `${id}.${a.id}.cleanup`);
    else if (passed && a.do === 'commit') keys.push(`${id}.${a.id}.files`);
    else if (passed && a.do === 'pr-ready') keys.push(PR_READY);
  }
  return !passed && rescued ? [...keys, `${id}.rescue`] : keys;
}

// The strongly connected components of `next` that hold a cycle, each in declaration order (Tarjan).
function cycles(next) {
  const ids = Object.keys(next);
  const index = new Map();
  const low = new Map();
  const stack = [];
  const found = [];
  const visit = (v) => {
    index.set(v, index.size);
    low.set(v, index.get(v));
    stack.push(v);
    for (const w of next[v]) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (stack.includes(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const component = stack.splice(stack.indexOf(v));
    if (component.length > 1 || next[v].includes(v)) found.push(ids.filter((id) => component.includes(id)));
  };
  for (const v of ids) if (!index.has(v)) visit(v);
  return found;
}

const dedupe = (list) => [...new Map(list.map((e) => [`${e.at}\n${e.message}`, e])).values()];

// R8b: a table is analysed once per Claim token reaching it, with that token's required Checks fixed: passed in the
// passed table; in the failed table, one box per required Check, where it is the first not to pass. A row is an error
// only when it fires in no box (J16).
// shortcut: each partly taken row keeps the box warning naming the most earlier rows, so a row taken only across tokens
// goes unwarned; #165 aggregates the boxes before warning.
function analyseTable(proc, table, fields, rows) {
  const boxes = proc.tokens[table].flatMap((token) => {
    const req = proc.required(token);
    if (table === 'passed') return [{ token, checks: Object.fromEntries(req.map((id) => [id, ['passed']])) }];
    if (table === 'stopped') return [{ token, checks: {} }];
    return req.map((id, j) => ({ token, checks: Object.fromEntries([...req.slice(0, j).map((r) => [r, ['passed']]), [id, ['failed', 'not-run']]]) }));
  });
  const results = boxes.map(({ token, checks }) => ({ token, ...analyse({ name: `${proc.name}.${table}`, rows,
    fields: Object.fromEntries(Object.entries(fields).map(([path, spec]) => {
      const [head, id] = refs.parse(path).steps;
      if (head === 'claim') return [path, { kind: 'enum', values: [token] }];
      return [path, head === 'check' && Object.hasOwn(checks, id) ? { kind: 'enum', values: checks[id] } : spec];
    })) }) }));
  const errors = unique(results.flatMap((r) => r.errors.filter((e) => e.row === null).map((e) => e.message)));
  rows.forEach((_, i) => {
    const found = results.map((r) => r.errors.find((e) => e.row === i));
    if (found.length && found.every(Boolean)) errors.push((found.find((e) => e.message.includes('never fires')) ?? found[0]).message);
  });
  const size = (w) => w.earlier.reduce((n, [a, b]) => n + b - a + 1, 0) + w.more;
  const best = new Map();
  for (const w of results.flatMap((r) => r.warnings)) {
    const key = json(w.rows);
    if (!best.has(key) || size(w) > size(best.get(key))) best.set(key, w);
  }
  return {
    errors,
    warnings: [...best.values()].sort((a, b) => a.rows[0] - b.rows[0]),
    falls: unique(results.filter((r) => r.defaultExample !== null).map((r) => r.token)),
  };
}

function validCondition(cond) {
  if (typeof cond === 'string' || typeof cond === 'boolean' || Number.isInteger(cond)) return true;
  return isRecord(cond) && Object.keys(cond).length > 0 && Object.entries(cond).every(([op, v]) => OPS.includes(op) && Number.isInteger(v));
}

// The Outcomes a Procedure can produce (R12b, T7): each table's rows, and its default when some input falls through.
function outcomesOf(proc, falls) {
  const { tokens, tables, otherwise } = proc;
  const out = [];
  // `fell`: the tokens some input falls through the table for; every token reaching a table that was not analysed.
  const add = (table, fallback) => {
    if (!tokens[table].length) return;
    out.push(...tables[table].map((row) => row?.outcome).filter((o) => typeof o === 'string'));
    const fell = falls[table] ?? tokens[table];
    if (fell.length) out.push(...fallback(fell));
  };
  add('passed', (fell) => (otherwise ? [otherwise] : fell));
  add('failed', () => [otherwise ?? 'failed']);
  add('stopped', (fell) => fell);
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
