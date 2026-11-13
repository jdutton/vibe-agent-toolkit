/**
 * The I0 harness's own tables and pure functions: what the system files trust
 * without seeing (`./helpers/cache-differential.ts`).
 */

import {
  BLOB_FINDING_CONDITION_CODES,
  BLOB_REFUSAL_CONDITION_CODES,
  NOT_ADMITTED_PARSE_REFUSAL_CODES,
  PARSE_REFUSAL_BLOB_CODES,
} from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  BLOB_CONDITION_EXEMPT,
  DECLARED_EMPTY,
  DUMPED_RELATIONS,
  HOLE_MOVED_COLUMNS,
  normalizeDocument,
  PER_RUN_FIELDS,
  refusingBlobCondition,
  RELATION_NAMES,
  VERB_NAMES,
  VERBS,
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
  it('exempts only codes a blob condition can carry', () => {
    const known = new Set([...BLOB_REFUSAL_CONDITION_CODES, ...BLOB_FINDING_CONDITION_CODES]);
    for (const code of Object.keys(BLOB_CONDITION_EXEMPT)) expect(known.has(code), code).toBe(true);
  });

  it('classifies a blob condition by code, and refuses to guess an unknown one', () => {
    const [refusal] = [...PARSE_REFUSAL_BLOB_CODES];
    const [finding] = BLOB_FINDING_CONDITION_CODES;
    expect(refusingBlobCondition(JSON.stringify({ code: refusal }))).toBe(refusal);
    expect(refusingBlobCondition(JSON.stringify({ code: finding }))).toBeUndefined();
    expect(() => refusingBlobCondition(JSON.stringify({ code: 'NO_SUCH_CODE' }))).toThrow(/no known kind/);
  });

  it('counts a parse refusal as a limit and any other refusal apart, in every document shape', () => {
    const [limitCode] = NOT_ADMITTED_PARSE_REFUSAL_CODES;
    const report = { status: 'success', findings: [{ code: limitCode }, { code: 'NOT_A_REFUSAL' }] };
    expect(VERBS.validate.refusalsOf(report)).toEqual({ limit: 1, other: 0 });
    expect(VERBS.check.refusalsOf({ status: 'error', error: { code: 'SOME_ERROR' } })).toEqual({ limit: 0, other: 1 });
    const dump = { status: 'success', data: { rows: [{ relation: 'blob_conditions', row: JSON.stringify({ code: [...PARSE_REFUSAL_BLOB_CODES][0] }) }] } };
    expect(VERBS.query.refusalsOf(dump)).toEqual({ limit: 1, other: 0 });
    const answers = { kind: 'context-answers', answers: [{ refused: [{ code: limitCode }, { code: 'OTHER' }] }, {}] };
    expect(VERBS.context.refusalsOf(answers)).toEqual({ limit: 1, other: 1 });
  });
});
