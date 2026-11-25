/**
 * `parse.cache.written`: the parent's count of parse-cache entries that reached
 * their final path, which a later check reads to prove the parent filed nothing
 * after a point. Counted once per entry, on the parent side: by `setByKey` when
 * the parent wrote it, by the pool when a worker answered `stored`.
 */

import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath , readWorkCounters } from '@vibe-agent-toolkit/utils';
import {
  __resetWorkCountersForTest,
  __throwOnForbiddenWorkCountForTest,
  removeScratchDir,
} from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeContentKey } from '../../src/content-key.js';
import { parseMarkdownContent } from '../../src/link-parser.js';
import { ParseCache } from '../../src/parse-cache.js';
import { createParsePool } from '../../src/parse-pool.js';

const CONTENT = '# Title\n\nSee [other](./other.md).\n';
const BYTES = Buffer.from(CONTENT, 'utf-8');

let root: string;

beforeEach(async () => {
  __resetWorkCountersForTest();
  root = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-cache-written-'));
});

afterEach(async () => {
  __resetWorkCountersForTest();
  await removeScratchDir(root);
});

describe('parse.cache.written', () => {
  it('counts one parse.cache.written per setByKey that persisted', async () => {
    const cache = new ParseCache({ cacheDir: root, enabled: true });
    const key = computeContentKey(BYTES, 'markdown');

    const persisted = await cache.setByKey(key, parseMarkdownContent(CONTENT, BYTES.length));

    expect(persisted).toBe(true);
    expect(readWorkCounters()['parse.cache.written']).toBe(1);
  });

  it('counts nothing for a setByKey that persisted nothing', async () => {
    const cache = new ParseCache({ cacheDir: root, enabled: false });

    const persisted = await cache.setByKey(computeContentKey(BYTES, 'markdown'), parseMarkdownContent(CONTENT, BYTES.length));

    expect(persisted).toBe(false);
    expect(readWorkCounters()['parse.cache.written']).toBe(0);
  });

  it('counts a worker stored reply in the parent, once, and the worker counts none', async () => {
    // With the throw on, a count made on the worker thread fails its parse.
    __throwOnForbiddenWorkCountForTest();
    const pool = createParsePool({ size: 1, cacheDir: root });
    try {
      const answered = await pool.parseIntoCache('markdown', CONTENT, BYTES.length, computeContentKey(BYTES, 'markdown'));

      expect(answered).toBeNull();
      expect(readWorkCounters()['parse.cache.written']).toBe(1);
    } finally {
      await pool.shutdown();
    }
  });
});
