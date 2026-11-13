/**
 * The I0 harness's own tables and pure functions: what the system files trust
 * without seeing (`./helpers/cache-differential.ts`).
 */

import { BLOB_NOT_TEXT, BLOB_PARSE_LIMIT_EXCEEDED, BLOB_PARSE_WORKER_DIED, EXTENT_DIRECTORY_UNLISTABLE } from '@vibe-agent-toolkit/resources';
import { CRAWL_STORE_READ_ID } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { groupOf, UNGROUPED } from './helpers/absence-causes.js';
import {
  DECLARED_EMPTY,
  DUMPED_RELATIONS,
  expectSeed,
  HOLE_MOVED_COLUMNS,
  normalizeDocument,
  PER_RUN_FIELDS,
  RELATION_NAMES,
  VERB_NAMES,
  VERBS,
  type DifferentialResult,
  type I0Seed,
} from './helpers/cache-differential.js';

/** SQLite's default argument limit, which `json_object` (two per column) must stay under. */
const SQLITE_MAX_FUNCTION_ARG = 127;

/** A document holding every per-run field of a verb, valued `'per-run'`, beside a field that must survive. */
function documentWithPerRunFields(paths: readonly string[]): Record<string, unknown> {
  const document: Record<string, unknown> = { kept: 'answer', data: { kept: 'answer', checks: [{ id: 'a' }, { id: 'b' }] } };
  for (const path of paths) {
    const segments = path.split('.');
    let cursor: unknown = document;
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const key = segment.endsWith('[]') ? segment.slice(0, -2) : segment;
      const record = cursor as Record<string, unknown>;
      if (segment.endsWith('[]')) {
        for (const element of record[key] as Array<Record<string, unknown>>) element[segments[index + 1] ?? ''] = 'per-run';
        break;
      }
      if (last) record[key] = 'per-run';
      else cursor = record[key] ??= {};
    }
  }
  return document;
}

describe('normalizeDocument', () => {
  it.each(VERB_NAMES)('removes exactly the per-run fields of %s', (verb) => {
    const normalized = normalizeDocument(verb, documentWithPerRunFields(PER_RUN_FIELDS[verb]));
    expect(JSON.stringify(normalized)).not.toContain('per-run');
    expect(normalized).toEqual({ kept: 'answer', data: { kept: 'answer', checks: [{ id: 'a' }, { id: 'b' }] } });
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

/** A dump: one row in a blob-scoped relation, and one in each relation a hole moves a column of. */
function holeDump(blob: string, contentKey: string): Record<string, unknown> {
  const rows = [
    { relation: 'blobs', row: JSON.stringify({ contentKey: blob }) },
    { relation: 'resource_realizations', row: JSON.stringify({ path: 'docs/two.md', contentKey }) },
    { relation: 'zone_provenance', row: JSON.stringify({ zone: 'repo', extentDigest: `digest-of-${contentKey}` }) },
  ];
  return { status: 'success', data: { population: 'store', rows } };
}

/** A query run the store served. */
function servedQuery(label: keyof DifferentialResult['runs'], document: Record<string, unknown>) {
  return { label, verb: 'query', status: 0, stdout: '', stderr: '', document, charged: [CRAWL_STORE_READ_ID] } as const;
}

/** The reference reads the new bytes; the warm arm was primed on the old ones, then measured. */
function holeResult(measuredBlob: string): DifferentialResult {
  const prime = servedQuery('warmSameHistory:prime', holeDump('old-blob', 'old-key'));
  const measured = servedQuery('warmSameHistory:measured', holeDump(measuredBlob, 'old-key'));
  const reference = servedQuery('storeOff:measured', holeDump('new-blob', 'new-key'));
  return {
    arms: ['storeOff', 'warmSameHistory'],
    verbs: ['query'],
    measured: { storeOff: { query: reference }, cold: {}, warmSameHistory: { query: measured } },
    runs: { 'storeOff:measured': { query: reference }, 'warmSameHistory:prime': { query: prime }, 'warmSameHistory:measured': { query: measured } },
    rows: VERBS,
  };
}

describe('a documented hole', () => {
  const seed: I0Seed = {
    name: 'hole',
    arms: ['storeOff', 'warmSameHistory'],
    verbs: ['query'],
    expect: { documentsHole: { arm: 'warmSameHistory', closedBy: 'the stat memo' } },
    consumed: { runs: [], check: () => undefined },
  };

  it('holds when the warm run serves exactly what its prime derived', () => {
    expect(() => expectSeed(seed, holeResult('old-blob'))).not.toThrow();
  });

  it('reds when the warm run serves blob facts its prime never derived', () => {
    expect(() => expectSeed(seed, holeResult('neither-blob'))).toThrow();
  });
});
