/* eslint-disable sonarjs/no-duplicate-string */
// Test file - duplicated test paths are acceptable for clarity
import { describe, expect, it } from 'vitest';

import { getCollectionsForFile, matchesCollection } from '../src/collection-matcher.js';
import type { CollectionConfig } from '../src/schemas/project-config.js';

// Test constants
const TEST_PATH_DOCS_GUIDE = '/project/docs/guide.md';
const TEST_PATH_DOCS_README = '/project/docs/README.md';
const TEST_PATH_DOCS_API_README = '/project/docs/api/README.md';
const TEST_PATTERN_DOCS = 'docs';

describe('matchesCollection', () => {
  it('should match files in included paths', () => {
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
    };

    expect(matchesCollection(TEST_PATH_DOCS_GUIDE, collection)).toBe(true);
    expect(matchesCollection('/project/docs/api/reference.md', collection)).toBe(true);
  });

  it('should not match files outside included paths', () => {
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
    };

    expect(matchesCollection('/project/src/index.ts', collection)).toBe(false);
    expect(matchesCollection('/project/README.md', collection)).toBe(false);
  });

  it('should exclude files matching exclude patterns', () => {
    const excludeReadmePattern = '**/README.md';
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
      exclude: [excludeReadmePattern],
    };

    expect(matchesCollection(TEST_PATH_DOCS_GUIDE, collection)).toBe(true);
    expect(matchesCollection(TEST_PATH_DOCS_README, collection)).toBe(false);
    expect(matchesCollection(TEST_PATH_DOCS_API_README, collection)).toBe(false);
  });

  it('should apply exclude-wins precedence', () => {
    const collection: CollectionConfig = {
      include: ['docs/**/*.md'],
      exclude: ['docs/internal/**'],
    };

    expect(matchesCollection('/project/docs/public.md', collection)).toBe(true);
    expect(matchesCollection('/project/docs/internal/secret.md', collection)).toBe(false);
  });

  it('should match glob patterns in include', () => {
    const collection: CollectionConfig = {
      include: ['**/*.schema.json'],
    };

    expect(matchesCollection('/project/schemas/user.schema.json', collection)).toBe(true);
    expect(matchesCollection('/project/docs/api.schema.json', collection)).toBe(true);
    expect(matchesCollection('/project/data/config.json', collection)).toBe(false);
  });

  it('should handle multiple include patterns (OR logic)', () => {
    const testPathDocsFile = '/project/docs/file.md';
    const testPathGuidesFile = '/project/guides/tutorial.md';
    const testPathSrcFile = '/project/src/code.ts';

    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS, 'guides'],
    };

    expect(matchesCollection(testPathDocsFile, collection)).toBe(true);
    expect(matchesCollection(testPathGuidesFile, collection)).toBe(true);
    expect(matchesCollection(testPathSrcFile, collection)).toBe(false);
  });

  it('should handle multiple exclude patterns', () => {
    const collection: CollectionConfig = {
      include: [TEST_PATTERN_DOCS],
      exclude: ['**/README.md', '**/*.draft.md'],
    };

    expect(matchesCollection(TEST_PATH_DOCS_GUIDE, collection)).toBe(true);
    expect(matchesCollection(TEST_PATH_DOCS_README, collection)).toBe(false);
    expect(matchesCollection('/project/docs/wip.draft.md', collection)).toBe(false);
  });

  it('should match paths with trailing slashes in config', () => {
    const collection: CollectionConfig = {
      include: ['docs/'],
    };

    expect(matchesCollection(TEST_PATH_DOCS_GUIDE, collection)).toBe(true);
  });
});

describe('getCollectionsForFile', () => {
  // Test collection definitions (shared across tests)
  const RAG_KB_COLLECTION = { include: [TEST_PATTERN_DOCS] };
  const SKILLS_COLLECTION = { include: ['**/SKILL.md'] };

  it('should return empty array when file matches no collections', () => {
    const collections = {
      'rag-kb': RAG_KB_COLLECTION,
      'skills': SKILLS_COLLECTION,
    };

    const result = getCollectionsForFile('/project/src/index.ts', collections);
    expect(result).toEqual([]);
  });

  it('should return single collection when file matches one', () => {
    const collections = {
      'rag-kb': RAG_KB_COLLECTION,
      'skills': SKILLS_COLLECTION,
    };

    const result = getCollectionsForFile(TEST_PATH_DOCS_GUIDE, collections);
    expect(result).toEqual(['rag-kb']);
  });

  it('should return multiple collections when file matches several', () => {
    const collections = {
      'rag-kb': RAG_KB_COLLECTION,
      'skills': SKILLS_COLLECTION,
      'all-docs': { include: ['**/*.md'] },
    };

    const compareStrings = (a: string, b: string): number => a.localeCompare(b);

    const result = getCollectionsForFile('/project/docs/SKILL.md', collections);
    const expected = ['all-docs', 'rag-kb', 'skills'];
    expect([...result].sort(compareStrings)).toEqual([...expected].sort(compareStrings));
  });

  it('should respect exclude rules', () => {
    const collections = {
      'rag-kb': { include: [TEST_PATTERN_DOCS], exclude: ['**/README.md'] },
      'all-md': { include: ['**/*.md'] },
    };

    const result = getCollectionsForFile(TEST_PATH_DOCS_README, collections);
    expect(result).toEqual(['all-md']);
  });

  it('should handle empty collections object', () => {
    const result = getCollectionsForFile(TEST_PATH_DOCS_GUIDE, {});
    expect(result).toEqual([]);
  });
});
