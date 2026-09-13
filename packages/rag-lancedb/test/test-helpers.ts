
/**
 * Shared test utilities for rag-lancedb tests.
 *
 * Provides common helpers for creating test fixtures, temporary directories,
 * and resource metadata to avoid duplication across test files.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';


import type { EmbeddingProvider } from '@vibe-agent-toolkit/rag';
import type { ContentTransformOptions, LinkType, ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

/**
 * Create a temporary directory for test database.
 *
 * @returns Absolute path to the temporary directory
 *
 * @example
 * const tempDir = await createTempDir();
 * const dbPath = safePath.join(tempDir, 'db');
 */
export async function createTempDir(): Promise<string> {
  return await mkdtemp(safePath.join(normalizedTmpdir(), 'rag-lancedb-test-'));
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
    links: parseResult.links,
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
  const filePath = safePath.join(tempDir, filename);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is controlled temp path
  await writeFile(filePath, content);
  return filePath;
}

/**
 * Create a ContentTransformOptions with a single link rewrite rule for local files.
 *
 * @param template - Handlebars template for rewritten links (e.g. '{{link.text}} (see: {{link.href}})')
 * @param matchType - Link type to match (defaults to 'local_file')
 * @returns ContentTransformOptions ready to pass to LanceDBRAGProvider.create()
 */
export function createLinkRewriteTransform(
  template: string,
  matchType: LinkType = 'local_file'
): ContentTransformOptions {
  return {
    linkRewriteRules: [
      {
        match: { type: matchType },
        template,
      },
    ],
  };
}

/**
 * Create a markdown file with links and return a complete ResourceMetadata.
 *
 * Combines createTestMarkdownFile + createTestResource into a single call.
 * Useful for tests that need resources with parsed link metadata.
 *
 * @param tempDir - Temporary directory for the file
 * @param filename - Filename to create
 * @param content - Markdown content (typically containing links)
 * @param resourceId - Optional resource ID (defaults to 'test-1')
 * @returns ResourceMetadata with populated links array
 */
export async function createResourceWithLinks(
  tempDir: string,
  filename: string,
  content: string,
  resourceId = 'test-1',
): Promise<ResourceMetadata> {
  const filePath = await createTestMarkdownFile(tempDir, filename, content);
  return createTestResource(filePath, resourceId);
}

/**
 * Query a provider and return all chunk content joined as a single string.
 *
 * Encapsulates the common pattern of querying, extracting chunk content,
 * and joining for assertion.
 *
 * @param provider - LanceDB provider to query
 * @param text - Search query text
 * @param limit - Max results (defaults to 10)
 * @returns All chunk content concatenated with newlines
 */
export async function queryAllContent(
  provider: LanceDBRAGProvider,
  text: string,
  limit = 10,
): Promise<string> {
  const result = await provider.query({ text, limit });
  return result.chunks.map((c) => c.content).join('\n');
}

/**
 * Setup helper for LanceDB integration/system tests
 *
 * Provides common beforeEach/afterEach setup for tests that need
 * temporary directories and LanceDB providers.
 *
 * @param autoCreateProvider - If true, automatically create provider in beforeEach
 * @returns Suite helper with tempDir, dbPath, provider, and lifecycle hooks
 *
 * @example
 * // Manual provider creation:
 * const suite = setupLanceDBTestSuite();
 * beforeEach(async () => {
 *   await suite.beforeEach();
 *   suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });
 * });
 *
 * // Automatic provider creation:
 * const suite = setupLanceDBTestSuite(true);
 * beforeEach(suite.beforeEach);
 */
/**
 * An embedding provider that returns fixed-width vectors without a runtime.
 *
 * Lets a unit test drive the indexing lane without loading ONNX/WASM. Shared
 * rather than copied: two suites need the same thing, and a second copy would
 * be a duplication finding rather than a convenience.
 *
 * `maxInputTokens` is REQUIRED, not decoration: chunk sizing reads it, and a
 * provider that omits it fails every document with "leaves no room for
 * content" — which lands as an ordinary per-resource error, so a suite counting
 * errors would read a broken stub as an extra broken document. 256 matches the
 * local all-MiniLM-L6-v2 limit; any positive number would do, since no suite
 * using this asserts chunk boundaries against a real model.
 *
 * @returns A deterministic, runtime-free embedding provider
 */
export function createStubEmbeddingProvider(): EmbeddingProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    dimensions: 4,
    maxInputTokens: 256,
    embed: async () => [0, 0, 0, 1],
    embedBatch: async (texts: string[]) => texts.map(() => [0, 0, 0, 1]),
  };
}

/**
 * Minimal resource metadata pointing at `filePath`, with nothing parsed.
 *
 * Hand-built rather than derived by parsing, because callers deliberately name
 * files that do not exist (deriving the metadata would have to read them) or
 * want the indexing lane, rather than the fixture, to be the thing under test.
 *
 * @param id - The resource id chunks and errors will be filed under
 * @param filePath - Absolute path the indexer will read and parse
 * @returns Metadata the indexing lane accepts
 */
export function createBareResource(id: string, filePath: string): ResourceMetadata {
  return {
    id,
    filePath,
    links: [],
    headings: [],
    frontmatter: {},
    sizeBytes: 0,
    estimatedTokenCount: 0,
    modifiedAt: new Date(0),
    checksum: `${id}-checksum`,
  };
}

export function setupLanceDBTestSuite(autoCreateProvider = false): {
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
      suite.dbPath = safePath.join(suite.tempDir, 'db');
      if (autoCreateProvider) {
        suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });
      }
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

