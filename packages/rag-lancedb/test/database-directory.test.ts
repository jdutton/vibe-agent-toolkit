import { describe, expect, it } from 'vitest';

import { foreignDatabaseEntries } from '../src/database-directory.js';

/** A listing entry as `readdirSync(dir, { withFileTypes: true })` gives it, without touching disk. */
function entry(name: string, kind: 'file' | 'dir' | 'link' = name.endsWith('.lance') && !name.startsWith('._') ? 'dir' : 'file'): { name: string; isFile(): boolean } {
  return { name, isFile: () => kind === 'file' };
}

/** `foreignDatabaseEntries` over entries of the default kind. */
function foreign(...names: string[]): string[] {
  return foreignDatabaseEntries(names.map((name) => entry(name)));
}

describe('foreignDatabaseEntries', () => {
  it('finds nothing foreign in a database: its two tables, either alone, or nothing (an index of nothing)', () => {
    expect(foreign('rag_chunks.lance', 'rag_documents.lance')).toEqual([]);
    expect(foreign('rag_chunks.lance')).toEqual([]);
    expect(foreign()).toEqual([]);
  });

  it('names every entry a database never holds — a project tree, a home directory, another table', () => {
    expect(foreign('docs', 'rag_chunks.lance', 'vibe-agent-toolkit.config.yaml')).toEqual(['docs', 'vibe-agent-toolkit.config.yaml']);
    expect(foreign('other.lance', 'rag_chunks')).toEqual(['other.lance', 'rag_chunks']);
  });

  // The OS writes these into any folder a person opens (Finder, Explorer, a copy to a FAT/SMB
  // volume). A database that holds one is still the database vat rag index wrote.
  it('ignores operating-system litter beside the tables', () => {
    expect(foreign('.DS_Store', 'rag_chunks.lance', 'Thumbs.db', 'desktop.ini', '._rag_chunks.lance')).toEqual([]);
    expect(foreign('.DS_Store', 'notes.md')).toEqual(['notes.md']);
  });

  // The OS only ever writes these as regular files. A directory or a link carrying the name is the
  // user's, and a database holding one must not be removed recursively.
  it('counts a litter name that is a directory or a link as foreign', () => {
    expect(foreignDatabaseEntries([entry('rag_chunks.lance'), entry('._notes', 'dir'), entry('.DS_Store', 'link'), entry('Thumbs.db')])).toEqual(['._notes', '.DS_Store']);
  });
});
