import { describe, expect, it } from 'vitest';

import { foreignDatabaseEntries } from '../src/database-directory.js';

describe('foreignDatabaseEntries', () => {
  it('finds nothing foreign in a database: its two tables, either alone, or nothing (an index of nothing)', () => {
    expect(foreignDatabaseEntries(['rag_chunks.lance', 'rag_documents.lance'])).toEqual([]);
    expect(foreignDatabaseEntries(['rag_chunks.lance'])).toEqual([]);
    expect(foreignDatabaseEntries([])).toEqual([]);
  });

  it('names every entry a database never holds — a project tree, a home directory, another table', () => {
    expect(foreignDatabaseEntries(['docs', 'rag_chunks.lance', 'vibe-agent-toolkit.config.yaml'])).toEqual(['docs', 'vibe-agent-toolkit.config.yaml']);
    expect(foreignDatabaseEntries(['other.lance', 'rag_chunks'])).toEqual(['other.lance', 'rag_chunks']);
  });
});
