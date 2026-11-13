/**
 * The I0 harness's own tables and pure functions: what the system files trust
 * without seeing (`./helpers/cache-differential.ts`).
 */

import {
  BLOB_FINDING_CONDITION_CODES,
  BLOB_NOT_TEXT,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_PARSE_WORKER_DIED,
  BLOB_REFUSAL_CONDITION_CODES,
  type ParseRefusedResource,
} from '@vibe-agent-toolkit/resources';
import { CRAWL_STORE_READ_ID } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_EMPTY,
  DUMPED_RELATIONS,
  expectSeed,
  HOLE_MOVED_COLUMNS,
  normalizeDocument,
  PARSE_REFUSAL_BLOB_CODES,
  PARSE_REFUSAL_CODES,
  PER_RUN_FIELDS,
  refusingBlobCondition,
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

describe('the census', () => {
  it('pairs each parse refusal blob code with the finding code production reports it under', () => {
    // Written out here, against the codes `resources` exports, so a pairing production changes reds this
    // test rather than silently moving the harness's limit set with it. The record's type keeps it
    // exhaustive over the finding codes a parse refusal can carry.
    const expected: Record<ParseRefusedResource['code'], string> = {
      RESOURCE_PARSE_LIMIT_EXCEEDED: BLOB_PARSE_LIMIT_EXCEEDED,
      RESOURCE_PARSE_WORKER_DIED: BLOB_PARSE_WORKER_DIED,
    };
    expect(PARSE_REFUSAL_BLOB_CODES).toEqual(new Map(Object.entries(expected).map(([finding, blob]) => [blob, finding])));
    expect(PARSE_REFUSAL_CODES).toHaveLength(Object.keys(expected).length);
    expect(new Set(PARSE_REFUSAL_CODES)).toEqual(new Set(Object.keys(expected)));
  });

  it('counts a blob condition as a limit exactly when production logs it as a parse refusal', () => {
    for (const code of BLOB_REFUSAL_CONDITION_CODES) {
      const dump = { status: 'success', data: { rows: [{ relation: 'blob_conditions', row: JSON.stringify({ code }) }] } };
      const limit = code === BLOB_PARSE_LIMIT_EXCEEDED || code === BLOB_PARSE_WORKER_DIED;
      expect(VERBS.query.refusalsOf(dump), code).toEqual(limit ? { limit: 1, other: 0 } : { limit: 0, other: 1 });
    }
  });

  it('classifies a blob condition by code, and refuses to guess an unknown one', () => {
    const [refusal] = PARSE_REFUSAL_BLOB_CODES.keys();
    const [finding] = BLOB_FINDING_CONDITION_CODES;
    expect(refusingBlobCondition(JSON.stringify({ code: refusal }))).toBe(refusal);
    expect(refusingBlobCondition(JSON.stringify({ code: finding }))).toBeUndefined();
    expect(() => refusingBlobCondition(JSON.stringify({ code: 'NO_SUCH_CODE' }))).toThrow(/no known kind/);
  });

  it('counts a blob not sniffed as text as a refusal: the gate fixture holds only text', () => {
    expect(refusingBlobCondition(JSON.stringify({ code: BLOB_NOT_TEXT }))).toBe(BLOB_NOT_TEXT);
  });

  it('counts every not-admitted code as a refusal, the parse refusals as limits', () => {
    const findings = [...PARSE_REFUSAL_CODES, 'RESOURCE_UNREADABLE'].map((code) => ({ code }));
    expect(VERBS.validate.refusalsOf({ status: 'success', findings })).toEqual({ limit: PARSE_REFUSAL_CODES.length, other: 1 });
  });

  it('counts a parse refusal as a limit and any other refusal apart, in every document shape', () => {
    const [limitCode] = PARSE_REFUSAL_CODES;
    const report = { status: 'success', findings: [{ code: limitCode }, { code: 'NOT_A_REFUSAL' }] };
    expect(VERBS.validate.refusalsOf(report)).toEqual({ limit: 1, other: 0 });
    expect(VERBS.check.refusalsOf({ status: 'error', error: { code: 'SOME_ERROR' } })).toEqual({ limit: 0, other: 1 });
    const dump = { status: 'success', data: { rows: [{ relation: 'blob_conditions', row: JSON.stringify({ code: [...PARSE_REFUSAL_BLOB_CODES.keys()][0] }) }] } };
    expect(VERBS.query.refusalsOf(dump)).toEqual({ limit: 1, other: 0 });
    const answers = { kind: 'context-answers', answers: [{ refused: [{ code: limitCode }, { code: 'OTHER' }] }, {}] };
    expect(VERBS.context.refusalsOf(answers)).toEqual({ limit: 1, other: 1 });
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
function servedQuery(label: string, document: Record<string, unknown>) {
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
