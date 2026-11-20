/**
 * The run database's row order is canonical: a statement without `ORDER BY` answers alike whatever
 * order its rows arrived in — warm or cold, served from the store or derived. Hydration and a lens
 * write both insert in `compareRows` order, so SQLite's scan order is that order.
 *
 * Each relation is filled from two input orders and asked `SELECT *` and a `group_concat` over a
 * non-key column, the aggregate whose answer is the scan order itself. The rows include a
 * nullable-key tie — two rows equal on the primary key because the key holds `null` — which only the
 * tie-break by the remaining columns can order.
 */

import { compareRows, PROJECTION_TABLES } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { hydrateRunDatabase } from '../src/run-database.js';

/**
 * `blob_conditions` keys on (blob, code, ordinal, line, message); `line` is nullable, `severity` is
 * not key. The two `m` rows share an ordinal so they stay a nullable-key tie.
 */
const CONDITIONS: readonly Record<string, unknown>[] = [
  { blob: 'b1', code: 'C', ordinal: 0, severity: 'warning', message: 'x', line: 3 },
  { blob: 'b1', code: 'C', ordinal: 1, severity: 'warning', message: 'm', line: null },
  { blob: 'b1', code: 'C', ordinal: 1, severity: 'info', message: 'm', line: null },
  { blob: 'b0', code: 'A', ordinal: 0, severity: 'error', message: 'y', line: 1 },
];

/** `edges` keys on (src, refOrdinal, contextId); `refOrdinal` is nullable, `kind` is not key. */
const EDGES: readonly Record<string, unknown>[] = [
  { src: 's2', refOrdinal: 0, contextId: 'c', kind: 'local_file', origin: 'authored' },
  { src: 's1', refOrdinal: null, contextId: 'c', kind: 'url', origin: 'implicit' },
  { src: 's1', refOrdinal: null, contextId: 'c', kind: 'anchor', origin: 'implicit' },
];

/** What a statement answers over one relation filled in the given order. */
interface Answers {
  readonly all: readonly Record<string, unknown>[];
  readonly concatenated: unknown;
}

/** Hydrate `blob_conditions` from `rows`, in that order, and ask it. */
async function conditionsAnswers(rows: readonly Record<string, unknown>[]): Promise<Answers> {
  const database = hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['blob_conditions', rows]]) });
  try {
    return {
      all: database.query('SELECT * FROM "blob_conditions"'),
      concatenated: database.query('SELECT group_concat("severity") AS s FROM "blob_conditions"')[0]?.['s'],
    };
  } finally {
    await database.close();
  }
}

/** Fill `edges` by a lens write from `rows`, in that order, and ask it. */
async function edgesAnswers(rows: readonly Record<string, unknown>[]): Promise<Answers> {
  const database = hydrateRunDatabase({ rootId: 'root-1', relations: new Map() });
  try {
    await database.writeDerived({ edges: rows });
    return {
      all: database.query('SELECT * FROM "edges"'),
      concatenated: database.query('SELECT group_concat("kind") AS k FROM "edges"')[0]?.['k'],
    };
  } finally {
    await database.close();
  }
}

describe('a run database answers in canonical row order, whatever order its rows arrived in', () => {
  it('a hydrated relation, a nullable-key tie included', async () => {
    const forward = await conditionsAnswers(CONDITIONS);
    const backward = await conditionsAnswers([...CONDITIONS].reverse());

    expect(backward).toStrictEqual(forward);
    const canonical = [...CONDITIONS].sort(compareRows(PROJECTION_TABLES.blobConditions));
    expect(forward.concatenated).toBe(canonical.map((row) => row['severity']).join(','));
  });

  it('a lens relation, a nullable-key tie included', async () => {
    const forward = await edgesAnswers(EDGES);
    const backward = await edgesAnswers([...EDGES].reverse());

    expect(backward).toStrictEqual(forward);
    expect(forward.concatenated).toBe('anchor,url,local_file');
  });
});
