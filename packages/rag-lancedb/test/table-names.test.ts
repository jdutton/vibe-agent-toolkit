import type { Connection } from '@lancedb/lancedb';
import { describe, expect, it } from 'vitest';

import { listAllTableNames } from '../src/table-names.js';

/** A connection whose `listTables` serves these pages, keyed by the token that requests them. */
function pagedConnection(pages: ReadonlyArray<{ tables: string[]; pageToken?: string }>): Connection {
  const byToken = new Map<string | undefined, (typeof pages)[number]>();
  let token: string | undefined;
  for (const page of pages) {
    byToken.set(token, page);
    token = page.pageToken;
  }
  return {
    listTables: async (options?: { pageToken?: string }) => byToken.get(options?.pageToken) ?? { tables: [] },
  } as unknown as Connection;
}

describe('listAllTableNames', () => {
  it('walks every page, including one shorter than the others that is not the last', async () => {
    const connection = pagedConnection([
      { tables: ['a', 'b'], pageToken: 't1' },
      { tables: ['c'], pageToken: 't2' },
      { tables: ['d', 'e'] },
    ]);
    expect(await listAllTableNames(connection)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns no names for an empty database', async () => {
    expect(await listAllTableNames(pagedConnection([{ tables: [] }]))).toEqual([]);
  });
});
