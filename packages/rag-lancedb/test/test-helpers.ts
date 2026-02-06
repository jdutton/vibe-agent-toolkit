
/**
 * Shared test utilities for rag-lancedb tests.
 *
 * Provides common helpers for creating test fixtures, temporary directories,
 * and resource metadata to avoid duplication across test files.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';

import type { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

/**
 * Create a temporary directory for test database.
 *
 * @returns Absolute path to the temporary directory
 *
 * @example
 * const tempDir = await createTempDir();
 * const dbPath = join(tempDir, 'db');
 */
export async function createTempDir(): Promise<string> {
  return await mkdtemp(join(normalizedTmpdir(), 'rag-lancedb-test-'));
}

/**
 * Create test ResourceMetadata from a file path.
 *
 * Parses the markdown file to extract metadata (headings, size, tokens, etc.)
 * and constructs a complete ResourceMetadata object.
 *
 * @param filePath - Absolute path to the markdown file
 * @param resourceId - Optional custom resource ID (defaults to 'test-1')
 * @returns Complete ResourceMetadata object with all required fields
 *
 * @example
 * const resource = await createTestResource('/tmp/test.md', 'my-doc');
 */
export async function createTestResource(
  filePath: string,
  resourceId = 'test-1'
): Promise<ResourceMetadata> {
  const parseResult = await parseMarkdown(filePath);
  return {
    id: resourceId,
    filePath,
    links: [],
    headings: parseResult.headings,
    frontmatter: parseResult.frontmatter, // Include frontmatter from parsing
    sizeBytes: parseResult.sizeBytes,
    estimatedTokenCount: parseResult.estimatedTokenCount,
    modifiedAt: new Date(),
    checksum: 'test-checksum-sha256', // Placeholder checksum for tests
  };
}

/**
 * Create a test markdown file with content.
 *
 * Writes a markdown file to the specified directory and returns the full path.
 * Useful for creating test fixtures with specific content.
 *
 * @param tempDir - Directory where the file should be created
 * @param filename - Name of the file (e.g., 'test.md')
 * @param content - Markdown content to write
 * @returns Absolute path to the created file
 *
 * @example
 * const filePath = await createTestMarkdownFile(
 *   tempDir,
 *   'test.md',
 *   '# Title\n\nContent'
 * );
 */
export async function createTestMarkdownFile(
  tempDir: string,
  filename: string,
  content: string
): Promise<string> {
  const filePath = join(tempDir, filename);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is controlled temp path
  await writeFile(filePath, content);
  return filePath;
}

/**
 * Setup helper for LanceDB integration/system tests
 *
 * Provides common beforeEach/afterEach setup for tests that need
 * temporary directories and LanceDB providers.
 *
 * @returns Suite helper with tempDir, dbPath, provider, and lifecycle hooks
 *
 * @example
 * const suite = setupLanceDBTestSuite();
 *
 * describe('My tests', () => {
 *   beforeEach(suite.beforeEach);
 *   afterEach(suite.afterEach);
 *
 *   it('should work', async () => {
 *     suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });
 *     // ... test code
 *   });
 * });
 */
export function setupLanceDBTestSuite(): {
  tempDir: string;
  dbPath: string;
  provider: LanceDBRAGProvider | null;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
} {
  const suite = {
    tempDir: '',
    dbPath: '',
    provider: null as LanceDBRAGProvider | null,
    beforeEach: async () => {
      suite.tempDir = await createTempDir();
      suite.dbPath = join(suite.tempDir, 'db');
    },
    afterEach: async () => {
      if (suite.provider) {
        await suite.provider.close();
      }
      await rm(suite.tempDir, { recursive: true, force: true });
    },
  };
  return suite;
}
