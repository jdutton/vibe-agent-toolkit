/**
 * A resource keyed by its git object is indexed from that object, without refusal.
 *
 * A store-on run admits a git member under `<kind>.git-sha1.<oid>`. The indexer re-keys the bytes
 * it reads and refuses a resource whose bytes no longer key to the admitted key, so it must read
 * the object the key names: under `core.autocrlf=true` the checkout holds CRLF while git holds
 * LF, and hashing the disk would key other bytes and refuse a file nobody changed.
 */

import { readFileSync, rmSync } from 'node:fs';

import { parseContentKey } from '@vibe-agent-toolkit/resources';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import {
  createStubEmbeddingProvider,
  createTestMarkdownFile,
  createTestResource,
  queryAllContent,
  setupLanceDBTestSuite,
} from '../test-helpers.js';


const suite = setupLanceDBTestSuite();
beforeEach(suite.beforeEach);
afterEach(suite.afterEach);

const DOCUMENT = '# Keyed by git\n\nProse the checkout writes with CRLF line ends.\n';

/** Run git in the suite's directory with a throwaway identity. */
function git(...args: string[]): string {
  return runGitOrThrow(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: suite.tempDir }).trim();
}

describe('indexing a git-keyed member', () => {
  it('reads the object its key names, LF as git holds it, under a CRLF checkout, and refuses nothing', async () => {
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    const path = await createTestMarkdownFile(suite.tempDir, 'doc.md', DOCUMENT);
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('config', 'core.autocrlf', 'true');
    rmSync(path);
    git('checkout', '--', 'doc.md');
    expect(readFileSync(path, 'utf-8'), 'the checkout holds CRLF').toContain('\r\n');
    const oid = git('rev-parse', 'HEAD:doc.md');

    const contentKey = parseContentKey(`markdown.git-sha1.${oid}`);
    if (contentKey === undefined) throw new Error(`not a content key: ${oid}`);
    const resource = { ...(await createTestResource(path, 'doc')), contentKey };
    const provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, embeddingProvider: createStubEmbeddingProvider() });
    try {
      const result = await provider.indexResources([resource], suite.objects);
      expect(result.errors, 'no resource refused').toEqual([]);
      expect(result.resourcesIndexed).toBe(1);
      const content = await queryAllContent(provider, 'Prose');
      expect(content, 'the indexed text').toContain('Prose the checkout writes');
      expect(content, 'the text is git\'s LF bytes, not the checkout\'s CRLF').not.toContain('\r');
    } finally {
      await provider.close();
    }
  });
});
