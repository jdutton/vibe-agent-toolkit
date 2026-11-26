// Test file - duplicated test paths are acceptable for clarity
import { mkdir, writeFile } from 'node:fs/promises';

import { readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileCollectionMatcher, compileCollectionMembership } from '../src/collection-matcher.js';
import { createCollectionMimeResolver } from '../src/projection/router.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { CollectionConfig } from '../src/schemas/project-config.js';

import { setupTempDirTestSuite } from './test-helpers.js';

// Test constants
const TEST_PATH_DOCS_GUIDE = '/project/docs/guide.md';
const TEST_PATH_DOCS_README = '/project/docs/README.md';
const TEST_PATH_DOCS_API_README = '/project/docs/api/README.md';
const TEST_PATTERN_DOCS = 'docs';

describe('compileCollectionMatcher', () => {
  it('should match files in included paths', () => {
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
    };

    expect(compileCollectionMatcher(collection)(TEST_PATH_DOCS_GUIDE)).toBe(true);
    expect(compileCollectionMatcher(collection)('/project/docs/api/reference.md')).toBe(true);
  });

  it('should not match files outside included paths', () => {
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
    };

    expect(compileCollectionMatcher(collection)('/project/src/index.ts')).toBe(false);
    expect(compileCollectionMatcher(collection)('/project/README.md')).toBe(false);
  });

  it('should exclude files matching exclude patterns', () => {
    const excludeReadmePattern = '**/README.md';
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
      exclude: [excludeReadmePattern],
    };

    expect(compileCollectionMatcher(collection)(TEST_PATH_DOCS_GUIDE)).toBe(true);
    expect(compileCollectionMatcher(collection)(TEST_PATH_DOCS_README)).toBe(false);
    expect(compileCollectionMatcher(collection)(TEST_PATH_DOCS_API_README)).toBe(false);
  });

  it('should apply exclude-wins precedence', () => {
    const collection: CollectionConfig = {
      include: ['docs/**/*.md'],
      exclude: ['docs/internal/**'],
    };

    expect(compileCollectionMatcher(collection)('/project/docs/public.md')).toBe(true);
    expect(compileCollectionMatcher(collection)('/project/docs/internal/secret.md')).toBe(false);
  });

  it('should match glob patterns in include', () => {
    const collection: CollectionConfig = {
      include: ['**/*.schema.json'],
    };

    expect(compileCollectionMatcher(collection)('/project/schemas/user.schema.json')).toBe(true);
    expect(compileCollectionMatcher(collection)('/project/docs/api.schema.json')).toBe(true);
    expect(compileCollectionMatcher(collection)('/project/data/config.json')).toBe(false);
  });

  it('should handle multiple include patterns (OR logic)', () => {
    const testPathDocsFile = '/project/docs/file.md';
    const testPathGuidesFile = '/project/guides/tutorial.md';
    const testPathSrcFile = '/project/src/code.ts';

    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS, 'guides'],
    };

    expect(compileCollectionMatcher(collection)(testPathDocsFile)).toBe(true);
    expect(compileCollectionMatcher(collection)(testPathGuidesFile)).toBe(true);
    expect(compileCollectionMatcher(collection)(testPathSrcFile)).toBe(false);
  });

  it('should handle multiple exclude patterns', () => {
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
      exclude: ['**/README.md', '**/*.draft.md'],
    };

    expect(compileCollectionMatcher(collection)(TEST_PATH_DOCS_GUIDE)).toBe(true);
    expect(compileCollectionMatcher(collection)(TEST_PATH_DOCS_README)).toBe(false);
    expect(compileCollectionMatcher(collection)('/project/docs/wip.draft.md')).toBe(false);
  });

  it('should match paths with trailing slashes in config', () => {
    const collection: CollectionConfig = {
      include: ['docs/'],
    };

    expect(compileCollectionMatcher(collection)(TEST_PATH_DOCS_GUIDE)).toBe(true);
  });
});

describe('compileCollectionMembership', () => {
  // Test collection definitions (shared across tests)
  const RAG_KB_COLLECTION = { include: [TEST_PATTERN_DOCS] };
  const SKILLS_COLLECTION = { include: ['**/SKILL.md'] };

  it('should return empty array when file matches no collections', () => {
    const collections = {
      'rag-kb': RAG_KB_COLLECTION,
      'skills': SKILLS_COLLECTION,
    };

    const result = compileCollectionMembership(collections)('/project/src/index.ts');
    expect(result).toEqual([]);
  });

  it('should return single collection when file matches one', () => {
    const collections = {
      'rag-kb': RAG_KB_COLLECTION,
      'skills': SKILLS_COLLECTION,
    };

    const result = compileCollectionMembership(collections)(TEST_PATH_DOCS_GUIDE);
    expect(result).toEqual(['rag-kb']);
  });

  it('should return multiple collections when file matches several', () => {
    const collections = {
      'rag-kb': RAG_KB_COLLECTION,
      'skills': SKILLS_COLLECTION,
      'all-docs': { include: ['**/*.md'] },
    };

    const compareStrings = (a: string, b: string): number => a.localeCompare(b);

    const result = compileCollectionMembership(collections)('/project/docs/SKILL.md');
    const expected = ['all-docs', 'rag-kb', 'skills'];
    expect([...result].sort(compareStrings)).toEqual([...expected].sort(compareStrings));
  });

  it('should respect exclude rules', () => {
    const collections = {
      'rag-kb': { include: [TEST_PATTERN_DOCS], exclude: ['**/README.md'] },
      'all-md': { include: ['**/*.md'] },
    };

    const result = compileCollectionMembership(collections)(TEST_PATH_DOCS_README);
    expect(result).toEqual(['all-md']);
  });

  it('should handle empty collections object', () => {
    const result = compileCollectionMembership({})(TEST_PATH_DOCS_GUIDE);
    expect(result).toEqual([]);
  });
});

describe('a holder of the config compiles each collection once, not once per file', () => {
  const suite = setupTempDirTestSuite('collection-matcher-compile-');
  beforeEach(async () => {
    await suite.beforeEach();
    __resetWorkCountersForTest();
  });
  afterEach(async () => {
    __resetWorkCountersForTest();
    await suite.afterEach();
  });

  it('compiles C matchers for N admitted files, never N x C', async () => {
    const fileCount = 5;
    const collections: Record<string, CollectionConfig> = {
      docs: { include: [TEST_PATTERN_DOCS], exclude: ['**/README.md'] },
      markdown: { include: ['*.md'] },
      skills: { include: ['**/SKILL.md'] },
    };
    const docsDir = safePath.join(suite.tempDir, TEST_PATTERN_DOCS);
    await mkdir(docsDir, { recursive: true });
    const registry = new ResourceRegistry({ baseDir: suite.tempDir, config: { resources: { collections } } });
    for (let i = 0; i < fileCount; i++) {
      const filePath = safePath.join(docsDir, `doc-${i}.md`);
      await writeFile(filePath, `# Doc ${i}\n`, 'utf-8');
      await registry.addResource(filePath);
    }

    expect(registry.size()).toBe(fileCount);
    expect(registry.getAllResources().map((resource) => resource.collections)).toEqual(
      Array.from({ length: fileCount }, () => ['docs', 'markdown']),
    );
    expect(readWorkCounters()['collection.matchers.compiled']).toBe(Object.keys(collections).length);
  });

  it('a MIME resolver compiles each declaring collection once, however many paths it types', () => {
    const resolver = createCollectionMimeResolver({
      prose: { include: [TEST_PATTERN_DOCS], mimeType: 'text/markdown' },
      untyped: { include: ['**/*.md'] },
    });
    for (let i = 0; i < 5; i++) {
      expect(resolver.mimeFor(`/project/docs/doc-${i}.md`, `docs/doc-${i}.md`)).toBe('text/markdown');
    }
    expect(readWorkCounters()['collection.matchers.compiled']).toBe(1);
  });
});
