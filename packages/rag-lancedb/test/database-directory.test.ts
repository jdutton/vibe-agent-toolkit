import { describe, expect, it } from 'vitest';

import { foreignDatabaseEntries } from '../src/database-directory.js';

/** A listing entry as `readdirSync(dir, { withFileTypes: true })` gives it, without touching disk. */
function entry(name: string, kind: 'file' | 'dir' | 'link' = name.endsWith('.lance') && !name.startsWith('._') ? 'dir' : 'file'): { name: string; isFile(): boolean } {
  return { name, isFile: () => kind === 'file' };
}

/**
 * A directory no test creates: a litter-named FILE is read from it and, absent,
 * is not proven litter. Litter told apart by its bytes is the integration test's.
 */
const NOWHERE = '/vat-no-such-database-directory';

/** `foreignDatabaseEntries` over entries of the default kind. */
function foreign(...names: string[]): string[] {
  return foreignDatabaseEntries(NOWHERE, names.map((name) => entry(name)));
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

  // Explorer writes desktop.ini into any folder a person customises; it is INI text with no
  // signature, so its name and being a regular file are the whole rule.
  it('ignores desktop.ini beside the tables, and still names what is foreign', () => {
    expect(foreign('desktop.ini', 'rag_chunks.lance')).toEqual([]);
    expect(foreign('desktop.ini', 'notes.md')).toEqual(['notes.md']);
  });

  // The other litter names carry a signature: a file that cannot be read cannot show it.
  it('counts a signed litter name whose bytes it cannot read as foreign', () => {
    expect(foreign('.DS_Store', 'Thumbs.db', '._rag_chunks.lance')).toEqual(['.DS_Store', 'Thumbs.db', '._rag_chunks.lance']);
  });

  // The OS only ever writes these as regular files. A directory or a link carrying the name is the
  // user's, and a database holding one must not be removed recursively.
  it('counts a litter name that is a directory or a link as foreign', () => {
    expect(foreignDatabaseEntries(NOWHERE, [entry('rag_chunks.lance'), entry('._notes', 'dir'), entry('.DS_Store', 'link'), entry('desktop.ini')])).toEqual(['._notes', '.DS_Store']);
  });
});
