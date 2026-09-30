/**
 * `vat rag query` over an index with nothing in it has ONE outcome.
 *
 * Two routes reach "nothing to search": a database with no chunk table (the
 * provider's query throws `RAG_INDEX_EMPTY`) and a table holding zero chunks
 * (the query returns nothing, and the writer's zero-examined refusal would
 * publish a finding at exit 1). They are one situation — the index the query
 * must read holds nothing — so both refuse as the provider does, before the
 * query runs, and the command maps that code to INPUT_UNREADABLE (exit 2).
 */

import { RAG_INDEX_EMPTY_CODE } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { assertIndexHoldsChunks } from '../../../src/commands/rag/query-command.js';
import { refusalCodeOf } from '../../../src/utils/command-refusal.js';

describe('assertIndexHoldsChunks', () => {
  it('refuses a zero-chunk index with the same code as a database with no table', () => {
    let thrown: unknown;
    try {
      assertIndexHoldsChunks(0, '/srv/project/.rag-db');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: RAG_INDEX_EMPTY_CODE });
    expect(refusalCodeOf(thrown)).toBe('INPUT_UNREADABLE');
    expect((thrown as Error).message).toContain('No data indexed yet');
    expect((thrown as Error).message).toContain('/srv/project/.rag-db');
  });

  it('lets a populated index through', () => {
    expect(() => assertIndexHoldsChunks(1, '/srv/project/.rag-db')).not.toThrow();
  });
});
