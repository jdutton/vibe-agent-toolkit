/**
 * The statements, checked without a database.
 *
 * These assert the *shape* the store depends on — that the extent key leads
 * both the columns and the key, that a nullable column is not declared
 * `NOT NULL`, that an `IN ()` with no members is refused rather than emitted.
 * Every one of them would otherwise only fail at runtime, on a connection, with
 * a SQLite error message that names none of these decisions.
 */

import { PROJECTION_TABLES } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  CREATE_EXTENTS_TABLE_SQL,
  EXTENT_KEY_COLUMNS,
  allSpecs,
  blobKeyColumn,
  createTableSql,
  deleteBlobFactsSql,
  deleteExtentSql,
  insertSql,
  selectBlobFactsSql,
  selectExtentSql,
  storedColumns,
  storedPrimaryKey,
} from '../src/schema-sql.js';

/** Count a substring's occurrences — placeholder counting, in one place. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('storedColumns', () => {
  it('prepends the extent key to an extent-scoped table', () => {
    expect(storedColumns(PROJECTION_TABLES.roots).slice(0, 2)).toEqual([...EXTENT_KEY_COLUMNS]);
  });

  it('leaves a blob-scoped table exactly as the registry declares it', () => {
    expect(storedColumns(PROJECTION_TABLES.blobs)).toEqual([...PROJECTION_TABLES.blobs.columns]);
  });

  it('keeps the registry column order after the extent key', () => {
    expect(storedColumns(PROJECTION_TABLES.resources).slice(2))
      .toEqual([...PROJECTION_TABLES.resources.columns]);
  });
});

describe('storedPrimaryKey', () => {
  it('prefixes an extent-scoped key so one tree is a key-range scan', () => {
    expect(storedPrimaryKey(PROJECTION_TABLES.resourceRealizations))
      .toEqual(['storeRootId', 'storeTreeHash', 'extentId', 'path']);
  });

  it('leaves a blob-scoped key alone', () => {
    expect(storedPrimaryKey(PROJECTION_TABLES.blobReferences)).toEqual(['blob', 'ordinal']);
  });
});

describe('createTableSql', () => {
  it('declares the extent key columns for an extent-scoped table', () => {
    const sql = createTableSql(PROJECTION_TABLES.roots);
    expect(sql).toContain('"storeRootId" TEXT NOT NULL');
    expect(sql).toContain('"storeTreeHash" TEXT NOT NULL');
  });

  it('omits them for a blob-scoped table', () => {
    expect(createTableSql(PROJECTION_TABLES.blobs)).not.toContain('"storeTreeHash"');
  });

  it('declares a boolean column as INTEGER, which is SQLite\'s only spelling for one', () => {
    expect(createTableSql(PROJECTION_TABLES.resources)).toContain('"observed" INTEGER NOT NULL');
  });

  it('declares a timestamp column as TEXT so it round-trips and sorts chronologically', () => {
    expect(createTableSql(PROJECTION_TABLES.resourceRealizations)).toContain('"mtime" TEXT,');
  });

  it('omits NOT NULL for a column the row schema makes nullable', () => {
    expect(createTableSql(PROJECTION_TABLES.blobs)).toContain('"frontmatterError" TEXT,');
  });

  it('omits NOT NULL for a JSON column, whose own union admits null', () => {
    // `zone_provenance.parameterSet` carries no `.nullable()` wrapper, so a
    // backend reading only the wrapper chain would declare it NOT NULL and fail
    // on the first null payload.
    expect(createTableSql(PROJECTION_TABLES.zoneProvenance)).toContain('"parameterSet" TEXT,');
  });

  it('names every registry column, for every table', () => {
    for (const spec of allSpecs()) {
      const sql = createTableSql(spec);
      for (const column of storedColumns(spec)) {
        expect(sql, `${spec.name}.${column}`).toContain(`"${column}"`);
      }
    }
  });

  it('is idempotent DDL, so opening an existing store is not an error', () => {
    for (const spec of allSpecs()) {
      expect(createTableSql(spec)).toContain('CREATE TABLE IF NOT EXISTS');
    }
    expect(CREATE_EXTENTS_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS');
  });
});

describe('insertSql', () => {
  it('binds one placeholder per stored column, extent key included', () => {
    const sql = insertSql(PROJECTION_TABLES.roots);
    expect(occurrences(sql, '?')).toBe(storedColumns(PROJECTION_TABLES.roots).length);
  });

  it('lists columns in the same order the store binds them', () => {
    expect(insertSql(PROJECTION_TABLES.roots))
      .toBe('INSERT INTO "roots" ("storeRootId", "storeTreeHash", "id", "path") VALUES (?, ?, ?, ?)');
  });

  it('agrees with the DDL on placeholder count for every table', () => {
    for (const spec of allSpecs()) {
      expect(occurrences(insertSql(spec), '?'), spec.name).toBe(storedColumns(spec).length);
    }
  });
});

describe('selectExtentSql', () => {
  it('selects the declared columns only, never the extent key', () => {
    const sql = selectExtentSql(PROJECTION_TABLES.roots);
    // Re-selecting the key would hand every row two columns the row schema does
    // not declare, and `.strict()` would then reject it.
    expect(sql).toBe('SELECT "id", "path" FROM "roots" WHERE "storeRootId" = ? AND "storeTreeHash" = ?');
  });
});

describe('deleteExtentSql', () => {
  it('scopes the delete to one tree', () => {
    expect(deleteExtentSql(PROJECTION_TABLES.resources))
      .toBe('DELETE FROM "resources" WHERE "storeRootId" = ? AND "storeTreeHash" = ?');
  });
});

describe('blobKeyColumn', () => {
  it('is contentKey on the blobs table itself', () => {
    expect(blobKeyColumn(PROJECTION_TABLES.blobs)).toBe('contentKey');
  });

  it('is blob on every table that hangs off it', () => {
    expect(blobKeyColumn(PROJECTION_TABLES.blobReferences)).toBe('blob');
    expect(blobKeyColumn(PROJECTION_TABLES.blobSections)).toBe('blob');
    expect(blobKeyColumn(PROJECTION_TABLES.blobConditions)).toBe('blob');
  });
});

describe('blob-fact statements', () => {
  it('emits one placeholder per content key', () => {
    expect(selectBlobFactsSql(PROJECTION_TABLES.blobs, 3))
      .toContain('WHERE "contentKey" IN (?, ?, ?)');
  });

  it('deletes through the same key column it selects through', () => {
    expect(deleteBlobFactsSql(PROJECTION_TABLES.blobSections, 2))
      .toBe('DELETE FROM "blob_sections" WHERE "blob" IN (?, ?)');
  });

  it('refuses an empty key set rather than emitting IN () — a syntax error', () => {
    expect(() => selectBlobFactsSql(PROJECTION_TABLES.blobs, 0)).toThrow(RangeError);
    expect(() => deleteBlobFactsSql(PROJECTION_TABLES.blobs, 0)).toThrow(RangeError);
  });

  it('refuses a fractional count, which would emit a wrong placeholder run', () => {
    expect(() => selectBlobFactsSql(PROJECTION_TABLES.blobs, 1.5)).toThrow(RangeError);
  });
});

describe('the registry drives everything', () => {
  it('covers all twelve tables', () => {
    expect(allSpecs()).toHaveLength(12);
  });

  it('splits them four blob-scoped, eight extent-scoped', () => {
    const blob = allSpecs().filter((spec) => spec.scope === 'blob');
    expect(blob.map((spec) => spec.key))
      .toEqual(['blobs', 'blobReferences', 'blobSections', 'blobConditions']);
    expect(allSpecs().filter((spec) => spec.scope === 'extent')).toHaveLength(8);
  });
});
