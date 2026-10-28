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
const INHERITED = Object.getOwnPropertyNames(Object.prototype);
const PROTOTYPE = 'is reserved: every object inherits a property of that name from Object.prototype';

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
  // H10: every later check keys plain objects by the configuration's names, so none runs while one is inherited.
  const inherited = inheritedNames(config);
  if (inherited.length) return { flows: {}, errors: inherited, warnings: [] };
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
  // The errors outside every Flow, which hold every Flow's graph checks (H6).
  const shared = errors.length;
  // Every declared Agent is checked once, used or not; its errors hold only the Flows that use it (H6).
  const failedAgents = new Set();
  const usedAgents = new Set(entries(config.flows).flatMap(([, f]) => entries(f?.ticket?.vertices).map(([, v]) => v?.use)));
  for (const [name, a] of entries(config.agents)) {
    const before = errors.length;
    if (!isRecord(a)) error(`agents.${name}`, 'an Agent must be an object');
    else if (a.harness == null) error(`agents.${name}`, `agent ${name} names no harness; set one in a user or repository Layer`);
    else if (!has(harnesses, a.harness)) error(`agents.${name}`, `agent ${name} names harness ${json(a.harness)}, which is not registered`);
    if (errors.length > before) failedAgents.add(name);
    if (!usedAgents.has(name)) warnings.push({ at: `agents.${name}`, message: `agent ${name} is used by no Vertex` });
  }
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
      if (target.max !== undefined && target.exhausted === undefined) error(at, 'an edge with max names its exhausted target');
      if (target.max === undefined && target.exhausted !== undefined) error(at, 'an edge names exhausted only with max');
      if (target.exhausted !== undefined) checkTarget(target.exhausted, vertices, at, { allowMax: false });
    } else {
      error(at, 'a route target is a Vertex id, { end: <end> } or { to, max?, exhausted? }');
    }
  }

  function checkFlow(name, f) {
    const at = `flows.${name}`;
    const start = errors.length;
    let held = false;
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
    const fallsOf = {};
    for (const [id, v] of Object.entries(vertices)) {
      const atV = `${at}.ticket.vertices.${id}`;
      if (RESERVED_VERTICES.includes(id)) error(atV, `Vertex id ${json(id)} is reserved: an end name, cleanup or done`);
      if (!isRecord(v)) { error(atV, 'a Vertex must be an object'); continue; }
      unknownKeys(v, VERTEX_KEYS, atV);
      const proc = procedureOf(v);
      if (!has(config.procedures, v.procedure)) error(atV, `procedure ${json(v.procedure)} is not declared`);
      if (proc) used.add(proc.name);
      if (failedAgents.has(v.use)) held = true;

      const overrides = Object.fromEntries(Object.entries(v).filter(([k]) => AGENT_KEYS.includes(k)));
      let agent = null;
      if (v.use !== undefined && !has(config.agents, v.use)) error(atV, `uses agent ${json(v.use)}, which is not declared`);
      else if (proc && !proc.agent && (v.use !== undefined || Object.keys(overrides).length)) error(atV, `procedure ${proc.name} has no agent Action, so the Vertex takes no Agent`);
      // A declared Agent that is not an object, or names an unregistered harness, is reported at agents.<name>.
      else if (proc?.agent && (v.use === undefined || isRecord(config.agents[v.use]))) {
        const merged = { ...(v.use === undefined ? {} : config.agents[v.use]), ...overrides };
        if (!Object.keys(merged).length) error(atV, `procedure ${proc.name} has an agent Action, so the Vertex needs an Agent`);
        else {
          const label = v.use === undefined ? `the agent of Vertex ${id}` : `agent ${v.use}`;
          // A harness the Vertex does not set itself is the Agent's, checked at agents.<name>.
          const own = v.use === undefined || Object.hasOwn(overrides, 'harness');
          if (own && merged.harness == null) error(atV, `${label} names no harness; set one in a user or repository Layer`);
          else if (own && !has(harnesses, merged.harness)) error(atV, `${label} names harness ${json(merged.harness)}, which is not registered`);
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
      if (v.maxVisits !== undefined && v.exhausted === undefined) error(atV, 'a Vertex with maxVisits names its exhausted target');
      if (v.maxVisits === undefined && v.exhausted !== undefined) error(atV, 'a Vertex names exhausted only with maxVisits');
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
        access: proc?.access === 'read-only' ? 'read-only' : agent?.access ?? 'read-only',
        tests: proc?.tests ?? null,
        outcomes: proc ? outcomesOf(proc, falls) : [],
        routing: {},
        inputs,
        route: v.route ?? {},
        maxVisits: v.maxVisits ?? null,
        exhausted: v.exhausted ?? null,
      };
      procs[id] = proc;
      fallsOf[id] = falls;
    }
    checkGraph(at, ticket, resolved, procs, fallsOf, shared === 0 && errors.length === start && !held);
    const effective = Object.fromEntries([...used].map((p) => {
      const { actions, claims, tests, access, tables, otherwise, recover, checks } = procedures[p];
      return [p, { actions, claims, tests, access, recover, ...tables, otherwise: otherwise ?? null, checks: checks.map((c) => c.id) }];
    }));
    return { name, plan: f.plan ?? null, actionCap: f.actionCap ?? null, procedures: effective,
      ticket: { entry: ticket.entry ?? null, routes: ticket.routes ?? {}, vertices: resolved } };
  }

  // The graph checks: routing (R12b, R12c, H7), bounds (I3, V3), commits (S2, T1c), and pr-ready before ready-for-qa
  // and inputs over the route map (R11e, Q7, H1-H5); unreachable Vertices are warned.
  // H6: the graph reads Procedures, routes and inputs as declared, so its checks wait until `clean`: no error outside
  // every Flow, and none in this one. Flows share no graph, so another Flow's errors do not hold them. `routing` is
  // filled in either way, for gg doctor.
  function checkGraph(at, ticket, resolved, procs, fallsOf, clean) {
    const fail = (where, message) => { if (clean) error(where, message); };
    const atV = (id) => `${at}.ticket.vertices.${id}`;
    const isVertex = (t) => typeof t === 'string' && Object.hasOwn(resolved, t);
    // H2, U5: a route lands on its Vertex, and on every exhausted target its edge's max or a Vertex's maxVisits can
    // reach. `exhausted` marks a landing that no edge max bounds. A missing exhausted target is H8's error, so its
    // needs-human here only fills in routing for doctor.
    const lands = (target, exhausted = false, seen = []) => {
      if (isRecord(target) && Object.hasOwn(target, 'to')) {
        return [...lands(target.to, exhausted, seen), ...(isCount(target.max) ? lands(target.exhausted ?? NEEDS_HUMAN, true, seen) : [])];
      }
      if (isRecord(target)) return ENDS.includes(target.end) ? [{ end: target.end, exhausted }] : [];
      if (!isVertex(target) || seen.includes(target)) return [];
      const v = resolved[target];
      return [{ vertex: target, exhausted }, ...(isCount(v.maxVisits) ? lands(v.exhausted ?? NEEDS_HUMAN, true, [...seen, target]) : [])];
    };
    // H7: an explicit Outcome name, the Vertex's then the Flow's, before either catch-all.
    const route = (v, outcome) => {
      for (const [by, routes, key] of [['Vertex route', v.route, outcome], ['Flow routes', ticket.routes, outcome],
        ['Vertex "*"', v.route, '*'], ['Flow "*"', ticket.routes, '*']]) {
        if (has(routes, key)) return { target: routes[key], by };
      }
      return ENGINE_OUTCOMES.includes(outcome) ? { target: NEEDS_HUMAN, by: 'engine default' } : null;
    };

    const edges = [];
    for (const [id, v] of Object.entries(resolved)) {
      const proc = procs[id];
      if (!proc) continue;
      const write = v.access !== 'read-only';
      if (write && proc.tokens.passed.length) {
        if (!proc.actions.some((a) => isRecord(a) && a.do === 'commit')) {
          fail(atV(id), `Vertex ${id} writes, so it must commit on every passing path, but procedure ${proc.name} has no commit Action`);
        }
        for (const token of proc.tokens.passed) {
          if (!proc.claims[token].requires.length) fail(atV(id), `Vertex ${id} writes, so its committing Claim token ${token} must require a Check`);
        }
      }
      const cases = casesOf(proc, fallsOf[id]);
      for (const outcome of v.outcomes) {
        const r = route(v, outcome);
        if (!r) { fail(atV(id), `Outcome ${outcome} is not routed by the Vertex or the Flow's routes`); continue; }
        const landings = lands(r.target);
        const mine = cases.filter((c) => c.outcome === outcome);
        const rescued = landings.some((l) => l.vertex);
        const left = landings.some((l) => l.end);
        const work = !write || mine.every((c) => c.table === 'passed') ? null
          : rescued && left ? 'rescued, or left in place once exhausted' : rescued ? 'rescued' : 'left in place';
        // An own key, so an Outcome such as __proto__ or toString is data.
        Object.defineProperty(v.routing, outcome, { value: { target: r.target, by: r.by, work }, enumerable: true, writable: true, configurable: true });
        edges.push({ from: id, outcome, landings, bounded: isRecord(r.target) && isCount(r.target.max) ? r.target.to : null, cases: mine, write });
      }
    }

    if (!clean) return;
    const bounded = (id) => isCount(resolved[id].maxVisits);
    const next = Object.fromEntries(Object.keys(resolved).map((id) => [id, []]));
    for (const e of edges) {
      for (const l of e.landings) {
        if (!l.vertex || bounded(e.from) || bounded(l.vertex) || (l.vertex === e.bounded && !l.exhausted)) continue;
        next[e.from].push(l.vertex);
      }
    }
    for (const cycle of cycles(next)) {
      fail(`${at}.ticket`, `the cycle through ${cycle.join(', ')} has no edge with max and no Vertex with maxVisits; the Action Cap does not bound a cycle`);
    }
    // H12: once every Vertex of such a loop is spent, an entry passes from exhausted target to exhausted target forever.
    const loops = new Map();
    for (const id of Object.keys(resolved)) {
      const chain = [];
      let cur = id;
      while (isVertex(cur) && bounded(cur) && !chain.includes(cur)) {
        chain.push(cur);
        cur = resolved[cur].exhausted;
      }
      if (!chain.includes(cur)) continue;
      const loop = chain.slice(chain.indexOf(cur));
      const members = Object.keys(resolved).filter((v) => loop.includes(v));
      loops.set(json(members), members);
    }
    for (const members of loops.values()) {
      fail(`${at}.ticket`, `the exhausted targets of ${members.join(', ')} form a loop: once their maxVisits are spent, no Vertex is ever entered`);
    }

    const producer = (source) => {
      const [vertex, action, output] = refs.parse(source).steps;
      return action === 'rescue' ? `${vertex}.rescue` : `${vertex}.${action}.${output}`;
    };
    // Each input's sources, as the outputs that produce them.
    const groups = new Map();
    for (const v of Object.values(resolved)) for (const input of Object.values(v.inputs)) groups.set(json(input.from), input.from.map(producer));
    // H3: the facts an Outcome guarantees, the inputs it produces a source of and whether pr-ready ran, are those every
    // way of reaching it does; each way is judged on its own first, so a list input (T6) may be met differently by each.
    const gained = (e, toVertex) => {
      const ways = e.cases.map((c) => {
        const keys = leaves(e.from, procs[e.from], c, e.write && toVertex);
        const facts = [...groups].filter(([, sources]) => sources.some((k) => keys.includes(k))).map(([g]) => g);
        return keys.includes(PR_READY) ? [...facts, PR_READY] : facts;
      });
      return ways.reduce((a, b) => a.filter((f) => b.includes(f)), ways[0] ?? []);
    };
    // The facts holding at each reachable Vertex's entry, on every route to it (`every`) or on some route.
    const analyse = (every) => {
      const facts = new Map([[ticket.entry, []]]);
      const queue = [ticket.entry];
      while (queue.length) {
        const u = queue.shift();
        for (const e of edges) {
          if (e.from !== u) continue;
          for (const l of e.landings) {
            if (!l.vertex) continue;
            const out = unique([...facts.get(u), ...gained(e, true)]);
            const old = facts.get(l.vertex);
            const merged = !old ? out : every ? old.filter((f) => out.includes(f)) : unique([...old, ...out]);
            if (!old || merged.length !== old.length) { facts.set(l.vertex, merged); queue.push(l.vertex); }
          }
        }
      }
      return facts;
    };
    const every = analyse(true);
    const some = analyse(false);
    for (const id of Object.keys(resolved)) if (!every.has(id)) warnings.push({ at: atV(id), message: `Vertex ${id} is not reachable from the entry` });
    // H4: the two errors that may be guesses on the map say so, and name the workaround.
    for (const e of edges) {
      if (!every.has(e.from) || !e.landings.some((l) => l.end === 'ready-for-qa')) continue;
      if (![...every.get(e.from), ...gained(e, false)].includes(PR_READY)) {
        fail(atV(e.from), `Outcome ${e.outcome} reaches end ready-for-qa on a route that may skip pr-ready; admission checks routes, not runs, so route it through the Vertex that runs pr-ready`);
      }
    }
    for (const [id, v] of Object.entries(resolved)) {
      if (!every.has(id)) continue;
      for (const [name, input] of Object.entries(v.inputs)) {
        const g = json(input.from);
        const where = `${atV(id)}.inputs.${name}`;
        if (!input.optional && !every.get(id).includes(g)) {
          fail(where, `input ${name} is required, but some route to ${id} may not produce any of its sources; admission checks routes, not runs, so if every run does produce one, mark the input optional`);
        }
        // H5: T9 is a warning.
        if (input.optional && !some.get(id).includes(g)) {
          warnings.push({ at: where, message: `input ${name} is optional, but no route to ${id} is sure to produce any of its sources; admission checks routes, not runs, so it may still arrive on some runs` });
        }
      }
    }
  }

  return { flows, errors: dedupe(errors), warnings: dedupe(warnings) };
}

// H10: each name the configuration gives that a plain object already has, which as a key is dropped (__proto__) or
// read as the inherited property.
function inheritedNames(config) {
  const found = [];
  const name = (at, what, n) => { if (INHERITED.includes(n)) found.push({ at, message: `${what} ${json(n)} ${PROTOTYPE}` }); };
  const keys = (o, at, what) => { for (const [k] of entries(o)) name(`${at}.${k}`, what, k); };
  keys(config.agents, 'agents', 'Agent');
  for (const [p, proc] of entries(config.procedures)) {
    const at = `procedures.${p}`;
    name(at, 'Procedure', p);
    if (Array.isArray(proc?.actions)) proc.actions.forEach((a, i) => name(`${at}.actions[${i}]`, 'Action id', a?.id));
    keys(proc?.claims, `${at}.claims`, 'Claim token');
    for (const table of TABLES) if (Array.isArray(proc?.[table])) proc[table].forEach((row, r) => name(`${at}.${table}[${r}]`, 'outcome', row?.outcome));
    name(`${at}.otherwise`, 'otherwise', proc?.otherwise);
  }
  for (const [f, flow] of entries(config.flows)) {
    const at = `flows.${f}`;
    name(at, 'Flow', f);
    keys(flow?.ticket?.routes, `${at}.ticket.routes`, 'route key');
    for (const [id, v] of entries(flow?.ticket?.vertices)) {
      const atV = `${at}.ticket.vertices.${id}`;
      name(atV, 'Vertex id', id);
      keys(v?.inputs, `${atV}.inputs`, 'input');
      keys(v?.route, `${atV}.route`, 'route key');
    }
  }
  return found;
}

// The ways a Procedure produces each Outcome (H3): a Claim token through one table, each row of that table counting for
// every token of it (H2), and the default for each token that falls through (outcomesOf, a token at a time); or a
// harness failure (table null).
function casesOf(proc, falls) {
  const cases = [];
  for (const table of TABLES) {
    for (const token of proc.tokens[table]) {
      const tokens = Object.fromEntries(TABLES.map((t) => [t, t === table ? [token] : []]));
      const fell = falls[table] ? { [table]: falls[table].filter((t) => t === token) } : {};
      for (const outcome of outcomesOf({ ...proc, agent: null, tokens }, fell)) cases.push({ outcome, table, token });
    }
  }
  if (proc.agent) cases.push(...HARNESS_OUTCOMES.map((outcome) => ({ outcome, table: null, token: null })));
  return cases;
}

// H3: the outputs a Visit of Vertex `id` is sure to leave when it ends in case `c`: the agent's response on any Claim
// (N10); effects, and the evidence of each Check the token requires (N9), only from the passed table (S4); the rescue
// when failing work moves on to a Vertex (R5a, W3).
function leaves(id, proc, c, rescued) {
  const passed = c.table === 'passed';
  const keys = [];
  for (const a of c.table === null ? [] : proc.actions) {
    if (!isRecord(a) || typeof a.id !== 'string') continue;
    if (a.do === 'agent') keys.push(`${id}.${a.id}.response`);
    else if (passed && a.do === 'check' && proc.required(c.token).includes(a.id)) keys.push(`${id}.${a.id}.evidence`);
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

// R8b, J16: a table's domain is the union of one box per Claim token reaching it, with that token's required Checks
// fixed: passed in the passed table; in the failed table, one box per required Check, where it is the first not to pass.
function analyseTable(proc, table, fields, rows) {
  const boxes = proc.tokens[table].flatMap((token) => {
    const req = proc.required(token);
    if (table === 'passed') return [{ token, checks: Object.fromEntries(req.map((id) => [id, ['passed']])) }];
    if (table === 'stopped') return [{ token, checks: {} }];
    return req.map((id, j) => ({ token, checks: Object.fromEntries([...req.slice(0, j).map((r) => [r, ['passed']]), [id, ['failed', 'not-run']]]) }));
  });
  const { errors, warnings, falls } = analyse({ name: `${proc.name}.${table}`, rows,
    boxes: boxes.map(({ token, checks }) => Object.fromEntries(Object.entries(fields).map(([path, spec]) => {
      const [head, id] = refs.parse(path).steps;
      if (head === 'claim') return [path, { kind: 'enum', values: [token] }];
      return [path, head === 'check' && Object.hasOwn(checks, id) ? { kind: 'enum', values: checks[id] } : spec];
    }))) });
  return { errors: errors.map((e) => e.message), warnings, falls: unique(falls.map((b) => boxes[b].token)) };
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
