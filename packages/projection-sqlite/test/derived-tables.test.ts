/**
 * The derived relations — their DDL, and the write path that fills them.
 *
 * These assert the properties that keep "a lens's output is not a projection
 * table" true in the code rather than only in a comment: that a derived
 * relation carries no extent key, that it exists in the in-memory database and
 * nowhere in the registry, and that a second evaluation REPLACES a first rather
 * than unioning with it — the failure that would silently double every
 * `GROUP BY` a caller writes.
 */

import { DERIVED_TABLES, PROJECTION_TABLES, allDerivedSpecs } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { EXTENT_KEY_COLUMNS, createDerivedTableSql, insertDerivedSql } from '../src/schema-sql.js';
import { openEphemeralProjectionStore } from '../src/store.js';

/** A minimal lens row, since every field but `contextId` is fixed for these. */
function lensRow(contextId: string): Record<string, unknown> {
  return {
    contextId,
    species: 'lens',
    kind: 'authored-link',
    rootId: 'root-x',
    extentContextId: 'ctx-base',
    role: null,
  };
}

/** One edge, keyed however the caller needs it to differ. */
function edgeRow(src: string, refOrdinal: number, contextId: string): Record<string, unknown> {
  return { src, refOrdinal, contextId, kind: 'local_file', origin: 'authored' };
}

describe('derived relations are shaped like tables without being tables', () => {
  it('registers none of them as a projection table', () => {
    const tableNames = new Set(Object.values(PROJECTION_TABLES).map((spec) => spec.name));
    for (const spec of allDerivedSpecs()) {
      expect(tableNames.has(spec.name)).toBe(false);
    }
  });

  it('emits NO extent key, which is the whole difference from a stored table', () => {
    for (const spec of allDerivedSpecs()) {
      const sql = createDerivedTableSql(spec);
      for (const column of EXTENT_KEY_COLUMNS) {
        expect(sql).not.toContain(`"${column}"`);
      }
    }
  });

  it('declares every column the row schema does, in order', () => {
    const sql = createDerivedTableSql(DERIVED_TABLES.edges);
    for (const column of DERIVED_TABLES.edges.columns) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain('PRIMARY KEY ("src", "refOrdinal", "contextId")');
  });

  it('does not declare a nullable column NOT NULL', () => {
    // `refOrdinal` is nullable on the edge row, and declaring it NOT NULL would
    // reject a legitimate row at insert time with a constraint error naming
    // none of this.
    expect(createDerivedTableSql(DERIVED_TABLES.edges)).toContain('"refOrdinal" INTEGER,');
  });

  it('binds one placeholder per declared column', () => {
    const sql = insertDerivedSql(DERIVED_TABLES.edges);
    const placeholders = sql.slice(sql.indexOf('VALUES')).split('?').length - 1;
    expect(placeholders).toBe(DERIVED_TABLES.edges.columns.length);
  });
});

describe('writeDerived fills the relations the ephemeral store creates', () => {
  it('round-trips rows through SQL', async () => {
    const store = openEphemeralProjectionStore();
    try {
      await store.writeDerived({
        lensContexts: [lensRow('lens-a')],
        edges: [edgeRow('res-1', 0, 'lens-a'), edgeRow('res-2', 0, 'lens-a')],
      });
      expect(store.query('SELECT COUNT(*) AS n FROM edges')).toEqual([{ n: 2 }]);
      expect(store.query('SELECT contextId FROM lens_contexts')).toEqual([{ contextId: 'lens-a' }]);
    } finally {
      await store.close();
    }
  });

  it('REPLACES a previous evaluation rather than unioning with it', async () => {
    // The failure this guards: two evaluations in one process are two answers to
    // two questions. Appending would leave both in the table and silently double
    // every count a caller groups.
    const store = openEphemeralProjectionStore();
    try {
      await store.writeDerived({ edges: [edgeRow('res-1', 0, 'lens-a')] });
      await store.writeDerived({ edges: [edgeRow('res-9', 0, 'lens-b')] });
      expect(store.query('SELECT src FROM edges')).toEqual([{ src: 'res-9' }]);
    } finally {
      await store.close();
    }
  });

  it('leaves a relation the caller OMITTED alone, which is not the same as empty', async () => {
    const store = openEphemeralProjectionStore();
    try {
      await store.writeDerived({ lensContexts: [lensRow('lens-a')], edges: [edgeRow('res-1', 0, 'lens-a')] });
      // Names `edges` only: `lensContexts` is absent, so it must survive.
      await store.writeDerived({ edges: [edgeRow('res-2', 0, 'lens-a')] });
      expect(store.query('SELECT COUNT(*) AS n FROM lens_contexts')).toEqual([{ n: 1 }]);
      // An explicit empty array DOES clear, which is the other half of the pair.
      await store.writeDerived({ lensContexts: [] });
      expect(store.query('SELECT COUNT(*) AS n FROM lens_contexts')).toEqual([{ n: 0 }]);
    } finally {
      await store.close();
    }
  });

  it('accepts a null in a nullable key column, since an edge may carry no ordinal', async () => {
    const store = openEphemeralProjectionStore();
    try {
      await store.writeDerived({ edges: [edgeRow('res-1', 0, 'lens-a')] });
      await expect(
        store.writeDerived({ edges: [{ ...edgeRow('res-1', 0, 'lens-a'), refOrdinal: null }] }),
      ).resolves.toBeUndefined();
      expect(store.query('SELECT refOrdinal FROM edges')).toEqual([{ refOrdinal: null }]);
    } finally {
      await store.close();
    }
  });
});
