/**
 * The I0 harness's own tables and pure functions: what the system files trust
 * without seeing (`./helpers/cache-differential.ts`).
 */

import { BLOB_NOT_TEXT, BLOB_PARSE_LIMIT_EXCEEDED, BLOB_PARSE_WORKER_DIED, EXTENT_DIRECTORY_UNLISTABLE } from '@vibe-agent-toolkit/resources';
import { CRAWL_STORE_READ_ID, WORK_COUNTER_NAMES, type WorkCounter, type WorkCounterDump } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { groupOf, UNGROUPED } from './helpers/absence-causes.js';
import {
  ARM_NAMES,
  DECLARED_EMPTY,
  DUMPED_RELATIONS,
  expectNoDivergenceAndNoRefusal,
  expectSeed,
  GATE_SLICES,
  HOLE_MOVED_COLUMNS,
  hydratedSpend,
  normalizeDocument,
  PER_RUN_FIELDS,
  RELATION_NAMES,
  resourcesPhaseSpend,
  runEveryStep,
  VERB_NAMES,
  VERBS,
  type ArmDirs,
  type DifferentialResult,
  type HydrationFacts,
  type I0Seed,
} from './helpers/cache-differential.js';

/** SQLite's default argument limit, which `json_object` (two per column) must stay under. */
const SQLITE_MAX_FUNCTION_ARG = 127;

/** A document every verb's per-run paths reach into: lists at `data.checks` and `data.phases[].data.checks`. */
function keptDocument(): Record<string, unknown> {
  const checks = (): unknown[] => [{ id: 'a' }, { id: 'b' }];
  return {
    kept: 'answer',
    data: { kept: 'answer', checks: checks(), phases: [{ name: 'one', data: { kept: 'answer', checks: checks() } }, { name: 'two', data: { kept: 'answer' } }] },
  };
}

/**
 * Value one dotted path (`a.b`, `a.list[].c`, nested lists too) `'per-run'` in place,
 * through every element of every list it names.
 */
function plant(value: unknown, segments: readonly string[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  const record = value as Record<string, unknown>;
  const key = head.endsWith('[]') ? head.slice(0, -2) : head;
  if (head.endsWith('[]')) {
    for (const element of (record[key] as unknown[] | undefined) ?? []) plant(element, rest);
  } else if (rest.length === 0) {
    record[key] = 'per-run';
  } else {
    record[key] ??= {};
    plant(record[key], rest);
  }
}

/** A document holding every per-run field of a verb, valued `'per-run'`, beside fields that must survive. */
function documentWithPerRunFields(paths: readonly string[]): Record<string, unknown> {
  const document = keptDocument();
  for (const path of paths) plant(document, path.split('.'));
  return document;
}

describe('normalizeDocument', () => {
  it.each(VERB_NAMES)('removes exactly the per-run fields of %s', (verb) => {
    const planted = documentWithPerRunFields(PER_RUN_FIELDS[verb]);
    // Each path planted at least once, so a path the base document does not reach cannot pass vacuously.
    expect(JSON.stringify(planted).split('per-run').length - 1, 'plants').toBeGreaterThanOrEqual(PER_RUN_FIELDS[verb].length);
    const normalized = normalizeDocument(verb, planted);
    expect(JSON.stringify(normalized)).not.toContain('per-run');
    expect(normalized).toEqual(keptDocument());
  });

  it('leaves a document without the fields as it was', () => {
    const document = { status: 'success', data: null };
    expect(normalizeDocument('check', document)).toEqual(document);
  });
});

describe('the dump', () => {
  it.each(DUMPED_RELATIONS.map((relation) => [relation.name, relation.columns.length]))(
    "%s fits json_object's argument limit (%i columns)",
    (_name, columns) => {
      expect(2 * columns).toBeLessThanOrEqual(SQLITE_MAX_FUNCTION_ARG);
    },
  );

  it('names only real relations, and real columns, in its declared tables', () => {
    for (const name of Object.keys(DECLARED_EMPTY)) expect(RELATION_NAMES.has(name), name).toBe(true);
    for (const [name, column] of Object.entries(HOLE_MOVED_COLUMNS)) {
      expect(DUMPED_RELATIONS.find((relation) => relation.name === name)?.columns, name).toContain(column);
    }
  });
});

/** A query document whose dump holds the given rows. */
function dumpOf(rows: ReadonlyArray<readonly [relation: string, row: Record<string, unknown>]>): Record<string, unknown> {
  return { status: 'success', data: { rows: rows.map(([relation, row]) => ({ relation, row: JSON.stringify(row) })) } };
}

describe('the census', () => {
  it('counts a dump\'s member rows by member, and an exempt row as nothing', () => {
    const dump = dumpOf([
      ['blob_conditions', { code: BLOB_PARSE_LIMIT_EXCEEDED }],
      ['blob_conditions', { code: BLOB_NOT_TEXT }],
      ['resource_realizations', { contentState: 'oversize' }],
      ['resource_realizations', { contentState: 'keyed' }],
    ]);
    expect(VERBS.query.censusOf(dump)).toEqual({ rows: { [BLOB_PARSE_LIMIT_EXCEEDED]: 1, 'contentState:oversize': 1 }, findings: {} });
  });

  it('holds a realization condition to its own extent\'s kind', () => {
    const condition = { code: EXTENT_DIRECTORY_UNLISTABLE, extentId: 'ctx-fs', resourceId: 'res-dir' };
    const counted = dumpOf([['realization_conditions', condition], ['resolution_contexts', { contextId: 'ctx-fs', kind: 'filesystem' }]]);
    expect(VERBS.query.censusOf(counted).rows).toEqual({ [EXTENT_DIRECTORY_UNLISTABLE]: 1 });
    const otherKind = dumpOf([['realization_conditions', condition], ['resolution_contexts', { contextId: 'ctx-fs', kind: 'git' }]]);
    expect(() => VERBS.query.censusOf(otherKind)).toThrow(/neither an absence-cause member nor exempt/);
  });

  it('refuses to guess: an unknown code, and a condition whose extent the dump does not list, both throw', () => {
    expect(() => VERBS.query.censusOf(dumpOf([['blob_conditions', { code: 'NO_SUCH_CODE' }]]))).toThrow(/NO_SUCH_CODE/);
    const orphan = dumpOf([['realization_conditions', { code: EXTENT_DIRECTORY_UNLISTABLE, extentId: 'ctx-gone', resourceId: null }]]);
    expect(() => VERBS.query.censusOf(orphan)).toThrow(/no resolution_contexts row/);
  });

  it('exempts a declared refusal label by its extent\'s provenance, never by its value', () => {
    const declaration = { kind: 'skill', closureFrom: 'SKILL.md', refusals: [{ label: 'MY_LABEL' }] };
    const condition = { code: 'MY_LABEL', extentId: 'ctx-skill', resourceId: null };
    const contexts: Array<readonly [string, Record<string, unknown>]> = [['resolution_contexts', { contextId: 'ctx-skill', kind: 'skill' }]];
    const declared = dumpOf([...contexts, ['realization_conditions', condition], ['zone_provenance', { contextId: 'ctx-skill', parameterSet: JSON.stringify(declaration) }]]);
    expect(VERBS.query.censusOf(declared).rows).toEqual({});
    const undeclared = dumpOf([...contexts, ['realization_conditions', condition], ['zone_provenance', { contextId: 'ctx-other', parameterSet: JSON.stringify(declaration) }]]);
    expect(() => VERBS.query.censusOf(undeclared)).toThrow(/MY_LABEL/);
  });

  it('counts a finding by the group of members that surface it, and a refusal no member surfaces as ungrouped', () => {
    const report = { status: 'success', findings: [{ code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' }, { code: 'RESOURCE_PARSE_WORKER_DIED' }, { code: 'NOT_A_REFUSAL' }] };
    expect(VERBS.validate.censusOf(report)).toEqual({
      rows: {},
      findings: { [groupOf(BLOB_PARSE_LIMIT_EXCEEDED)]: 1, [groupOf(BLOB_PARSE_WORKER_DIED)]: 1 },
    });
    expect(VERBS.check.censusOf({ status: 'error', error: { code: 'USAGE_INVALID' } })).toEqual({ rows: {}, findings: { [UNGROUPED]: 1 } });
    const answers = { kind: 'context-answers', answers: [{ refused: [{ code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' }, { code: 'RESOURCE_UNREADABLE' }] }, {}] };
    expect(VERBS.context.censusOf(answers)).toEqual({ rows: {}, findings: { [groupOf(BLOB_PARSE_LIMIT_EXCEEDED)]: 2 } });
  });
});

describe('the gate slices', () => {
  const slices = Object.values(GATE_SLICES);

  it('run store-off, the reference, first in every slice', () => {
    for (const slice of slices) expect(slice.arms[0], slice.slice).toBe('storeOff');
  });

  it('hold every (arm, verb) cell but store-off\'s in exactly one slice, and name only real arms and verbs', () => {
    const counts = new Map<string, number>();
    for (const slice of slices) {
      for (const arm of slice.arms.filter((name) => name !== 'storeOff')) {
        for (const verb of slice.verbs) counts.set(`${arm} ${verb}`, (counts.get(`${arm} ${verb}`) ?? 0) + 1);
      }
    }
    const every = ARM_NAMES.filter((arm) => arm !== 'storeOff').flatMap((arm) => VERB_NAMES.map((verb) => `${arm} ${verb}`));
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(every.map((cell) => [cell, 1])));
  });
});

describe('where a run says its answer came from', () => {
  it('reads vat validate\'s from its first phase that reports one, under that phase\'s name', () => {
    const phases = [{ name: 'resources', data: { population: 'derived' } }, { name: 'checks', data: { population: 'store', lensPopulation: 'none' } }];
    expect(VERBS.vatValidate.originsOf({ data: { phases } })).toEqual({ 'resources.population': 'derived' });
    expect(VERBS.vatValidate.originsOf({ data: { phases: [{ name: 'skills', data: {} }, ...phases.slice(1)] } }))
      .toEqual({ 'checks.population': 'store', 'checks.lensPopulation': 'none' });
  });

  it('reads a one-population verb\'s from data, and nothing from a refusal', () => {
    expect(VERBS.check.originsOf({ data: { population: 'store', lensPopulation: 'derived' } })).toEqual({ population: 'store', lensPopulation: 'derived' });
    expect(VERBS.vatValidate.originsOf({ status: 'error', data: null })).toEqual({});
  });
});

/** A dump: one row in a blob-scoped relation, and one in each relation a hole moves a column of. */
function holeDump(blob: string, contentKey: string): Record<string, unknown> {
  const rows = [
    { relation: 'blobs', row: JSON.stringify({ contentKey: blob }) },
    { relation: 'resource_realizations', row: JSON.stringify({ path: 'docs/two.md', contentKey }) },
    { relation: 'zone_provenance', row: JSON.stringify({ zone: 'repo', extentDigest: `digest-of-${contentKey}` }) },
  ];
  return { status: 'success', data: { population: 'store', rows } };
}

/** A recorded run's cell, for a run no test reads it of. */
const NO_DIRS: ArmDirs = { root: '', tmp: '', home: '', store: '', timing: '', parse: '' };
const NO_CELL = { work: [], extentsBefore: [], cell: { dirs: NO_DIRS, corpus: '' } } as const;

/** A query run the store served. */
function servedQuery(label: keyof DifferentialResult['runs'], document: Record<string, unknown>) {
  return { label, verb: 'query', status: 0, stdout: '', stderr: '', document, origins: VERBS.query.originsOf(document), charged: [CRAWL_STORE_READ_ID], ...NO_CELL } as const;
}

/** The reference reads the new bytes; the warm arm was primed on the old ones, then measured. */
function holeResult(measuredBlob: string): DifferentialResult {
  const prime = servedQuery('warmSameHistory:prime', holeDump('old-blob', 'old-key'));
  const measured = servedQuery('warmSameHistory:measured', holeDump(measuredBlob, 'old-key'));
  const reference = servedQuery('storeOff:measured', holeDump('new-blob', 'new-key'));
  return {
    arms: ['storeOff', 'warmSameHistory'],
    verbs: ['query'],
    measured: { storeOff: { query: reference }, cold: {}, warmSameHistory: { query: measured }, partialEviction: {} },
    runs: { 'storeOff:measured': { query: reference }, 'warmSameHistory:prime': { query: prime }, 'warmSameHistory:measured': { query: measured } },
    rows: VERBS,
  };
}

describe('a documented hole', () => {
  const seed: I0Seed = {
    name: 'hole',
    needs: null,
    arms: ['storeOff', 'warmSameHistory'],
    verbs: ['query'],
    expect: { documentsHole: { arm: 'warmSameHistory', because: 'normalization is outside what VAT supports' } },
    consumed: { runs: [], check: () => undefined },
  };

  it('holds when the warm run serves exactly what its prime derived', () => {
    expect(() => expectSeed(seed, holeResult('old-blob'))).not.toThrow();
  });

  it('reds when the warm run serves blob facts its prime never derived', () => {
    expect(() => expectSeed(seed, holeResult('neither-blob'))).toThrow();
  });
});

/** A store-off-only result: the reference arm's dump, and one validate report. */
function storeOffResult(dump: Record<string, unknown>, report: Record<string, unknown>): DifferentialResult {
  const run = (verb: 'query' | 'validate', document: Record<string, unknown>) =>
    ({ label: 'storeOff:measured', verb, status: 0, stdout: '', stderr: '', document, origins: VERBS[verb].originsOf(document), charged: [], ...NO_CELL }) as const;
  const measured = { query: run('query', dump), validate: run('validate', report) };
  return {
    arms: ['storeOff'],
    verbs: ['validate', 'query'],
    measured: { storeOff: measured, cold: {}, warmSameHistory: {}, partialEviction: {} },
    runs: { 'storeOff:measured': measured },
    rows: VERBS,
  };
}

describe('a refusal seed', () => {
  const seed: I0Seed = {
    name: 'limit',
    needs: null,
    arms: ['storeOff'],
    verbs: ['validate', 'query'],
    expect: { refuses: { cause: BLOB_PARSE_LIMIT_EXCEEDED, perVerb: { validate: 1, query: 1 } } },
    consumed: { runs: [], check: () => undefined },
  };
  const dump = dumpOf([['blob_conditions', { code: BLOB_PARSE_LIMIT_EXCEEDED }]]);

  it('holds when every verb refuses under a code its cause surfaces', () => {
    expect(() => expectSeed(seed, storeOffResult(dump, { status: 'success', findings: [{ code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' }] }))).not.toThrow();
  });

  it('reds when a verb refuses under a code of the same group that its cause does not surface', () => {
    const relabelled = { status: 'success', findings: [{ code: 'RESOURCE_UNREADABLE' }] };
    expect(() => expectSeed(seed, storeOffResult(dump, relabelled))).toThrow(/does not surface/);
  });
});

describe('the unseeded gate', () => {
  const clean = { status: 'success', findings: [] };

  it('holds over a dump with no absence', () => {
    expect(() => expectNoDivergenceAndNoRefusal(storeOffResult(dumpOf([]), clean))).not.toThrow();
  });

  it('reds on a blob its sniffer called not text, though that code is exempt from the census', () => {
    const sniffed = dumpOf([['blob_conditions', { code: BLOB_NOT_TEXT }]]);
    expect(() => expectNoDivergenceAndNoRefusal(storeOffResult(sniffed, clean))).toThrow(/BLOB_NOT_TEXT/);
  });
});

describe('the seed suite\'s cleanup', () => {
  /** A step that records its name, then throws when told to. */
  const step = (ran: string[], name: string, throws = false) => (): void => {
    ran.push(name);
    if (throws) throw new Error(name);
  };

  it('runs every step though an earlier one throws, then rethrows the first error', () => {
    const ran: string[] = [];
    const steps = [step(ran, 'restore a', true), step(ran, 'restore b', true), step(ran, 'remove cells'), step(ran, 'context cleanup')];
    expect(() => runEveryStep(steps)).toThrow('restore a');
    expect(ran).toEqual(['restore a', 'restore b', 'remove cells', 'context cleanup']);
  });

  it('returns quietly when every step succeeds', () => {
    const ran: string[] = [];
    runEveryStep([step(ran, 'a'), step(ran, 'b')]);
    expect(ran).toEqual(['a', 'b']);
  });
});

/** A `vat validate` process's dump whose resources phase counted `counts`, every other counter 0. */
function validateDump(counts: Partial<Record<WorkCounter, number>>): WorkCounterDump {
  const phase = Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, counts[name] ?? 0])) as Record<WorkCounter, number>;
  return { pid: 1, role: 'cli', counters: phase, phases: { resources: phase } };
}

describe('the hydration tell', () => {
  // Ten view members, one refused by size; three evicted, two of them twins of one key; no skill.
  const facts: HydrationFacts = {
    members: 10,
    evicted: [
      { path: 'docs/a.md', bytes: 5, contentKey: 'k1' },
      { path: 'docs/twin-a.md', bytes: 7, contentKey: 'k2' },
      { path: 'docs/twin-b.md', bytes: 7, contentKey: 'k2' },
    ],
    refusedFromStore: 1,
  };

  it('holds a phase that admitted every held member from the store and computed only the evicted keys', () => {
    // Seven store admissions and the refusal probed; ten registry stats; three reads; two parses.
    const hydrated = validateDump({ 'content.read': 3, 'content.hashed': 3, 'content.hashedBytes': 19, 'parse.cache.hit': 2, 'registry.admitted': 10, 'fs.stat': 18 });
    expect(resourcesPhaseSpend([hydrated])).toEqual(hydratedSpend(facts));
  });

  it('reds on a phase that fell back to the cold lane for every member, though it admitted every one', () => {
    const cold = validateDump({ 'content.read': 10, 'content.hashed': 10, 'content.hashedBytes': 60, 'parse.cache.hit': 9, 'registry.admitted': 10, 'fs.stat': 10 });
    expect(resourcesPhaseSpend([cold])).not.toEqual(hydratedSpend(facts));
  });

  it('reds on a phase that read one held member besides the evicted ones', () => {
    const extra = validateDump({ 'content.read': 4, 'content.hashed': 4, 'content.hashedBytes': 25, 'parse.cache.hit': 3, 'registry.admitted': 10, 'fs.stat': 17 });
    expect(resourcesPhaseSpend([extra])).not.toEqual(hydratedSpend(facts));
  });

  it('charges skill discovery nothing: a phase that read one SKILL.md besides reds', () => {
    // Two members, both admitted from the store; the discovery read a SKILL.md of 11 bytes and looked it up.
    const residual = validateDump({ 'content.read': 1, 'content.hashed': 1, 'content.hashedBytes': 11, 'parse.cache.hit': 1, 'registry.admitted': 2, 'fs.stat': 4 });
    const hydrated = hydratedSpend({ members: 2, evicted: [], refusedFromStore: 0 });
    expect(hydrated).toEqual({ read: 0, hashedBytes: 0, parseLookups: 0, admitted: 2, probed: 2 });
    expect(resourcesPhaseSpend([residual])).not.toEqual(hydrated);
  });

  it('reads only the one dump that carries the resources phase', () => {
    const child: WorkCounterDump = { ...validateDump({}), phases: {} };
    expect(() => resourcesPhaseSpend([child])).toThrow(/found 0/u);
    expect(() => resourcesPhaseSpend([validateDump({}), validateDump({})])).toThrow(/found 2/u);
  });
});
