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

import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { DERIVED_TABLES, PROJECTION_TABLES, allDerivedSpecs } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { openRunDatabase } from '../src/run-database.js';
import { EXTENT_KEY_COLUMNS, createDerivedTableSql, insertDerivedSql } from '../src/schema-sql.js';
import { openSqliteFactStore } from '../src/store.js';

import { sampleProjection } from './fixtures.js';

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

describe('writeDerived fills the relations the run database creates', () => {
  it('round-trips rows through SQL', async () => {
    const store = openRunDatabase(sampleProjection());
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
    const store = openRunDatabase(sampleProjection());
    try {
      await store.writeDerived({ edges: [edgeRow('res-1', 0, 'lens-a')] });
      await store.writeDerived({ edges: [edgeRow('res-9', 0, 'lens-b')] });
      expect(store.query('SELECT src FROM edges')).toEqual([{ src: 'res-9' }]);
    } finally {
      await store.close();
    }
  });

  it('leaves a relation the caller OMITTED alone, which is not the same as empty', async () => {
    const store = openRunDatabase(sampleProjection());
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
    const store = openRunDatabase(sampleProjection());
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

describe('an UNEVALUATED derived relation does not exist, so SQLite refuses it', () => {
  // 🚨 The refusal the query lane's lazy lens evaluation rests on. It used to be
  // a word scan over the statement, run by the same scanner that SELECTED the
  // lenses — so it could never fire for a statement the selector had seen, and a
  // reference the scanner missed would read an existing, EMPTY table and answer
  // 0. With no table, the engine itself says `no such table`, whatever spelling
  // reached it.
  it('throws `no such table` for a relation nothing wrote', async () => {
    const store = openRunDatabase(sampleProjection());
    try {
      expect(() => store.query('SELECT * FROM edges')).toThrow(/no such table: edges/u);
    } finally {
      await store.close();
    }
  });

  it('creates the relation on an EMPTY write — "evaluated, no rows" is a real answer', async () => {
    const store = openRunDatabase(sampleProjection());
    try {
      await store.writeDerived({ edges: [] });
      expect(store.query('SELECT * FROM edges')).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('creates ONLY the relations the write names', async () => {
    const store = openRunDatabase(sampleProjection());
    try {
      await store.writeDerived({ edges: [edgeRow('res-1', 0, 'lens-a')] });
      expect(store.query('SELECT COUNT(*) AS n FROM edges')).toEqual([{ n: 1 }]);
      expect(() => store.query('SELECT * FROM lens_contexts')).toThrow(/no such table: lens_contexts/u);
    } finally {
      await store.close();
    }
  });

  it('rolls a failed first write back to ABSENT, and a later write still creates the relation', async () => {
    const store = openRunDatabase(sampleProjection());
    try {
      await expect(store.writeDerived({ edges: [{ ...edgeRow('res-1', 0, 'lens-a'), refOrdinal: 'x' }] }))
        .rejects.toThrow(/numeric column/u);
      expect(() => store.query('SELECT * FROM edges')).toThrow(/no such table: edges/u);
      await store.writeDerived({ edges: [edgeRow('res-1', 0, 'lens-a')] });
      expect(store.query('SELECT COUNT(*) AS n FROM edges')).toEqual([{ n: 1 }]);
    } finally {
      await store.close();
    }
  });
});

describe('the shared on-disk fact store cannot take a lens evaluation', () => {
  // 🚨 The whole safety property. That database is ONE per VAT release, shared
  // by every root on the machine. Derived rows carry no extent key, so eviction
  // cannot reach them, and `writeDerived` clears each relation with no root
  // predicate — one repository's evaluation would delete another repository's
  // rows. The factory returns the `FactStore` port, which has no such method.
  it('has no writeDerived, in the type or on the handle', async () => {
    const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-derived-refusal-'));
    const onDisk = openSqliteFactStore({ directory });
    try {
      // @ts-expect-error -- a lens's rows never reach the fact store
      expect(onDisk.writeDerived).toBeUndefined();
      expect('writeDerived' in onDisk).toBe(false);
    } finally {
      await onDisk.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('has no table for them either', async () => {
    // The DDL split is the second line of defence, and it is what makes the
    // "why are these two schemas different?" cleanup dangerous.
    const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-derived-absent-'));
    const onDisk = openSqliteFactStore({ directory });
    await onDisk.close();
    const raw = new DatabaseSync(safePath.join(directory, 'projection.db'), { readOnly: true });
    try {
      const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row['name']);
      expect(names, 'the control found no table at all — the check is vacuous').toContain('blobs');
      for (const spec of allDerivedSpecs()) {
        expect(names).not.toContain(spec.name);
      }
    } finally {
      raw.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
