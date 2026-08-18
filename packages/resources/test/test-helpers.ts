
/**
 * Shared test helpers for resources package tests
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GitTracker, normalizedTmpdir, resetProjectRootCaches, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, expect, type Assertion } from 'vitest';

import { ExternalLinkValidator } from '../src/external-link-validator.js';
import { parseMarkdown } from '../src/link-parser.js';
import type { FragmentIndex, ValidateLinkOptions as LinkValidatorOptions } from '../src/link-validator.js';
import { validateLink } from '../src/link-validator.js';
import type { ExtentContribution, ExtentContributor } from '../src/projection/contributor.js';
import { ProjectionBuilder } from '../src/projection/projection.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import {
  ResourceExtentRowSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
} from '../src/schemas/projection-resources.js';
import { ResolutionContextRowSchema } from '../src/schemas/projection-zones.js';
import type { HeadingNode, ResourceLink, ValidationIssue } from '../src/types.js';

/**
 * Initialize a git repository in the specified directory.
 * Required for tests that use git commands (git check-ignore, git ls-files).
 *
 * @param directory - Absolute path to directory to initialize as git repo
 * @returns The directory path (for chaining)
 *
 * @example
 * ```typescript
 * const tempDir = createTestTempDir('my-test-');
 * createGitRepo(tempDir);
 * // Now tempDir is a valid git repository
 * ```
 */
export function createGitRepo(directory: string): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  spawnSync('git', ['init'], { cwd: directory, stdio: 'pipe' });
  // `gitFindRoot()` memoizes `null` for any directory a prior walk climbed
  // through (e.g. before this repo existed). Without this reset, a later
  // crawl in the same process silently keeps answering from that stale
  // memo instead of seeing the repo we just created.
  resetProjectRootCaches();
  return directory;
}

/**
 * Walk up directories looking for package.json that matches a predicate
 *
 * @param startDir - Directory to start searching from
 * @param predicate - Function to test if package.json matches criteria
 * @param errorMessage - Error message if not found
 * @returns Absolute path to matching directory
 */
function findPackageDirectory(
  startDir: string,
  predicate: (pkg: { name: string; workspaces?: unknown }) => boolean,
  errorMessage: string,
): string {
  let currentDir = startDir;
  while (currentDir !== path.dirname(currentDir)) {
    try {
      const pkgPath = safePath.join(currentDir, 'package.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path is safe in test helper, pkgPath constructed from trusted directory traversal
      const pkgContent = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgContent) as { name: string; workspaces?: unknown };
      if (predicate(pkg)) {
        return currentDir;
      }
    } catch {
      // Keep searching upward
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error(errorMessage);
}

/**
 * Find the package root directory by looking for package.json with specific name
 *
 * @param startDir - Directory to start searching from
 * @param packageName - Expected package name (default: @vibe-agent-toolkit/resources)
 * @returns Absolute path to package root
 */
export function findPackageRoot(
  startDir: string = import.meta.dirname,
  packageName: string = '@vibe-agent-toolkit/resources',
): string {
  return findPackageDirectory(
    startDir,
    (pkg) => pkg.name === packageName,
    `Could not find package root for ${packageName}`,
  );
}

/**
 * Find the monorepo root directory (vibe-agent-toolkit)
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to monorepo root
 */
export function findMonorepoRoot(
  startDir: string = import.meta.dirname,
): string {
  return findPackageDirectory(
    startDir,
    (pkg) => Boolean(pkg.workspaces) && pkg.name === 'vibe-agent-toolkit',
    'Could not find monorepo root',
  );
}

// ============================================================================
// Test suite setup helpers
// ============================================================================

/**
 * Setup resource test suite with standard lifecycle hooks
 * Eliminates duplication of beforeEach/afterEach setup across resource tests
 *
 * Creates a temporary directory and ResourceRegistry for each test,
 * and cleans up after each test completes.
 *
 * @param testPrefix - Prefix for temp directory (e.g., 'resource-query-')
 * @returns Object with refs that will be populated during beforeEach
 *
 * @example
 * ```typescript
 * const suite = setupResourceTestSuite('resource-query-');
 *
 * describe('My test suite', () => {
 *   beforeEach(suite.beforeEach);
 *   afterEach(suite.afterEach);
 *
 *   it('should work', async () => {
 *     const resource = await createAndAddResource(
 *       suite.tempDir,
 *       'test.md',
 *       '# Test',
 *       suite.registry
 *     );
 *     expect(resource).toBeDefined();
 *   });
 * });
 * ```
 */
export function setupResourceTestSuite(testPrefix: string): {
  tempDir: string;
  registry: ResourceRegistry;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
} {
  const suite = {
    tempDir: '',
    registry: null as unknown as ResourceRegistry,
    beforeEach: async () => {
      suite.tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), testPrefix));
      suite.registry = new ResourceRegistry();
    },
    afterEach: async () => {
      await rm(suite.tempDir, { recursive: true, force: true });
    },
  };

  return suite;
}

/**
 * Setup simple temp directory test suite (no ResourceRegistry).
 *
 * For tests that only need temp directory management without registry.
 *
 * @param testPrefix - Prefix for temp directory (e.g., 'config-parser-')
 * @returns Object with tempDir ref that will be populated during beforeEach
 */
export function setupTempDirTestSuite(testPrefix: string): {
  tempDir: string;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
} {
  const suite = {
    tempDir: '',
    beforeEach: async () => {
      suite.tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), testPrefix));
    },
    afterEach: async () => {
      await rm(suite.tempDir, { recursive: true, force: true });
    },
  };

  return suite;
}

/**
 * Setup a suite-scoped temp directory with per-test subdirectories.
 *
 * Creates a single `suiteDir` once for the whole `describe` block, then
 * allocates a numbered subdirectory (`test-1`, `test-2`, …) for each test so
 * that tests are isolated without paying the cost of creating and deleting a
 * fresh top-level temp directory for every test.  The suite directory is
 * removed in `afterAll`.
 *
 * Lifecycle wiring (call inside the target `describe` block):
 * ```typescript
 * const suite = setupSubdirTestSuite('my-suite-');
 * beforeAll(suite.beforeAll);
 * afterAll(suite.afterAll);
 * beforeEach(suite.beforeEach);
 * ```
 *
 * @param suitePrefix - Prefix for the suite-level temp directory
 * @returns Object with `suiteDir`/`tempDir` refs and lifecycle hook callbacks
 */
export function setupSubdirTestSuite(suitePrefix: string): {
  suiteDir: string;
  tempDir: string;
  beforeAll: () => Promise<void>;
  afterAll: () => Promise<void>;
  beforeEach: () => Promise<void>;
} {
  let testCounter = 0;
  const suite = {
    suiteDir: '',
    tempDir: '',
    beforeAll: async () => {
      suite.suiteDir = await mkdtemp(safePath.join(normalizedTmpdir(), suitePrefix));
    },
    afterAll: async () => {
      await rm(suite.suiteDir, { recursive: true, force: true });
    },
    beforeEach: async () => {
      testCounter++;
      suite.tempDir = safePath.join(suite.suiteDir, `test-${testCounter}`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- suite.tempDir is constructed from mkdtemp output, safe in test context
      await mkdir(suite.tempDir, { recursive: true });
    },
  };

  return suite;
}

/**
 * Setup external link validator test suite with temp directory and validator.
 *
 * Used by both unit tests (with mocked HTTP) and integration tests (with real HTTP)
 * to eliminate duplication of beforeEach/afterEach setup.
 *
 * @param testPrefix - Prefix for temp directory (e.g., 'link-validator-test-')
 * @param options - ExternalLinkValidator options
 * @returns Object with refs that will be populated during beforeEach
 */
export function setupExternalLinkValidatorSuite(
  testPrefix: string,
  options: { cacheTtlHours?: number } = {},
): {
  tempDir: string;
  validator: ExternalLinkValidator;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
} {
  const resolvedOptions = { cacheTtlHours: options.cacheTtlHours ?? 24 };
  const suite = {
    tempDir: '',
    validator: null as unknown as ExternalLinkValidator,
    beforeEach: async () => {
      suite.tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), testPrefix));
      suite.validator = new ExternalLinkValidator(suite.tempDir, resolvedOptions);
    },
    afterEach: async () => {
      await rm(suite.tempDir, { recursive: true, force: true });
    },
  };

  return suite;
}

// ============================================================================
// Link validation helpers
// ============================================================================

/**
 * Helper to create a ResourceLink for testing
 */
export function createLink(
  type: ResourceLink['type'],
  href: string,
  text: string = 'Test Link',
  line?: number,
): ResourceLink {
  return {
    text,
    href,
    type,
    line,
  };
}

/**
 * Options for validating a link with expected results
 */
export interface ValidateLinkOptions {
  /** Source file path */
  sourceFile: string;
  /** Link to validate */
  link: ResourceLink;
  /** Fragment index for anchor validation (file path → set of valid fragments) */
  headingsMap: FragmentIndex;
  /** Expected validation result (null = valid, object = error) */
  expected: null | {
    code: ValidationIssue['code'];
    messageContains?: string | string[];
    hasSuggestion?: boolean;
    /** Expected link property value */
    link?: string;
  };
  /** Validation options (projectRoot, skipGitIgnoreCheck) */
  validationOptions?: LinkValidatorOptions;
}

/**
 * Assert message contains expected text fragments
 */
function assertMessageContains(
  result: ValidationIssue | null,
  messageContains: string | string[],
  expectFn: (_: unknown) => Assertion<unknown>,
): void {
  const messageFragments = Array.isArray(messageContains)
    ? messageContains
    : [messageContains];

  for (const fragment of messageFragments) {
    expectFn(result?.message).toContain(fragment);
  }
}

/**
 * Assert validation error properties
 */
function assertValidationError(
  result: ValidationIssue | null,
  expected: NonNullable<ValidateLinkOptions['expected']>,
  expectFn: (_: unknown) => Assertion<unknown>,
): void {
  // Assert code
  expectFn(result?.code).toBe(expected.code);

  // Assert message contains expected text(s)
  if (expected.messageContains !== undefined) {
    assertMessageContains(result, expected.messageContains, expectFn);
  }

  // Assert suggestion presence (avoid selector parameter anti-pattern)
  if (expected.hasSuggestion === true) {
    expectFn(result?.suggestion).toBeDefined();
  } else if (expected.hasSuggestion === false) {
    expectFn(result?.suggestion).toBeUndefined();
  }

  // Assert link property value
  if (expected.link !== undefined) {
    expectFn(result?.link).toBe(expected.link);
  }
}

/**
 * Validate a link and assert expected results.
 * Eliminates duplication in validation test patterns.
 *
 * Returns the issue it validated so callers can assert on it directly. That
 * return value is not decoration: SonarJS (and any human reader) cannot see the
 * assertions this helper makes, so a caller with no assertion of its own is
 * indistinguishable from a caller whose helper silently stopped asserting.
 * Assert on the returned issue at the call site — it is the positive control on
 * this helper.
 */
export async function assertValidation(
  options: ValidateLinkOptions,
  expectFn: (_: ValidationIssue | null) => Assertion<ValidationIssue | null>,
): Promise<ValidationIssue | null> {
  const { sourceFile, link, headingsMap, expected, validationOptions } = options;

  const result = await validateLink(link, sourceFile, headingsMap, validationOptions);

  if (expected === null) {
    expectFn(result).toBeNull();
  } else {
    expectFn(result).not.toBeNull();
    assertValidationError(result, expected, expectFn as (_: unknown) => Assertion<unknown>);
  }

  return result;
}

// ============================================================================
// Link parser helpers
// ============================================================================

/**
 * Options for writing and parsing markdown files
 */
export interface WriteAndParseOptions {
  /** File path where markdown will be written */
  filePath: string;
  /** Markdown content to write */
  content: string;
  /** Assertions to run on parse result */
  assertions: (_: Awaited<ReturnType<typeof parseMarkdown>>) => Promise<void> | void;
}

/**
 * Write markdown content to file, parse it, and run assertions
 * Eliminates duplication in parser test patterns
 */
export async function writeAndParse(
  options: WriteAndParseOptions,
): Promise<Awaited<ReturnType<typeof parseMarkdown>>> {
  const { filePath, content, assertions } = options;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is provided by test caller, safe in test context
  await writeFile(filePath, content, 'utf-8');
  const parsedResult = await parseMarkdown(filePath);
  await assertions(parsedResult);

  return parsedResult;
}

/**
 * Helper to verify heading tree structure
 * Eliminates duplication in heading structure assertions
 */
export function expectHeadingStructure(
  heading: HeadingNode,
  expected: {
    text: string;
    level?: number;
    children?: Array<{ text: string; level?: number }>;
  },
  expectFn: (_: unknown) => Assertion<unknown>,
): void {
  expectFn(heading.text).toBe(expected.text);

  if (expected.level !== undefined) {
    expectFn(heading.level).toBe(expected.level);
  }

  if (expected.children !== undefined) {
    expectFn(heading.children).toHaveLength(expected.children.length);
    for (let i = 0; i < expected.children.length; i++) {
      const child = expected.children[i];
      if (child) {
        expectFn(heading.children?.[i]?.text).toBe(child.text);
        if (child.level !== undefined) {
          expectFn(heading.children?.[i]?.level).toBe(child.level);
        }
      }
    }
  }
}

/**
 * Write markdown, parse it, and assert all links have the expected type.
 * Eliminates duplication in classification tests that check every link.
 */
export async function assertAllLinksClassifiedAs(
  tempDir: string,
  filename: string,
  content: string,
  expectedType: ResourceLink['type'],
): Promise<void> {
  await writeAndParse({
    filePath: safePath.join(tempDir, filename),
    content,
    assertions: (result) => {
      for (const link of result.links) {
        expect(link.type).toBe(expectedType);
      }
    },
  });
}

// ============================================================================
// Schema validation helpers
// ============================================================================

/**
 * Write a markdown file with optional YAML frontmatter.
 *
 * Renders each frontmatter entry as `key: <JSON-encoded value>` so strings,
 * numbers, booleans, arrays, and null all round-trip correctly through the
 * YAML parser. Pass `null` (or omit) to write a body-only file.
 *
 * @param filePath - Absolute path of the file to write
 * @param frontmatter - Frontmatter entries, or null for no frontmatter block
 * @param body - Markdown body content (defaults to a minimal placeholder)
 */
export async function writeMarkdownFileWithFrontmatter(
  filePath: string,
  frontmatter: Record<string, unknown> | null,
  body: string = '# Test\n\nContent here.',
): Promise<void> {
  let frontmatterBlock = '';
  if (frontmatter) {
    const entries = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');
    frontmatterBlock = `---\n${entries}\n---\n\n`;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is from test caller, safe in test context
  await writeFile(filePath, frontmatterBlock + body, 'utf-8');
}

/**
 * Create a JSON Schema file in the temp directory
 *
 * @param tempDir - Temporary directory path
 * @param filename - Schema filename
 * @param schema - Schema object
 */
export async function createSchemaFile(
  tempDir: string,
  filename: string,
  schema: object
): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir and filename are from test caller, safe in test context
  await writeFile(
    safePath.join(tempDir, filename),
    JSON.stringify(schema),
    'utf-8'
  );
}

/**
 * Common schema definitions for tests
 */
export const TestSchemas = {
  /**
   * Base schema requiring title field
   */
  base: {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string' },
    },
    additionalProperties: false,
  },

  /**
   * Enhanced schema requiring category field
   */
  enhanced: {
    type: 'object',
    required: ['category'],
    properties: {
      category: { type: 'string' },
    },
    additionalProperties: false,
  },

  /**
   * Schema requiring both title and description
   */
  titleAndDescription: {
    type: 'object',
    required: ['title', 'description'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
    },
  },
};

/**
 * Assert that first schema result has validation errors
 *
 * @param results - Schema validation results
 * @param expectFn - expect function from test
 */
export function expectFirstSchemaHasErrors(
  results: Array<{ valid?: boolean; errors?: unknown[] }>,
  expectFn: (_: unknown) => Assertion<unknown>,
): void {
  expectFn(results[0]?.valid).toBe(false);
  expectFn(results[0]?.errors).toBeDefined();
  expectFn(results[0]?.errors?.length).toBeGreaterThan(0);
}

/**
 * Create two markdown files with the same content in a temp directory.
 * Useful for testing checksum/dedup behavior.
 */
export async function createTwoFilesWithSameContent(
  tempDir: string,
  content: string,
): Promise<{ file1: string; file2: string }> {
  const file1 = safePath.join(tempDir, 'file1.md');
  const file2 = safePath.join(tempDir, 'file2.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper
  await writeFile(file1, content, 'utf-8');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper
  await writeFile(file2, content, 'utf-8');
  return { file1, file2 };
}

/**
 * Assert every row in an {@link ExtentContribution} parses against its shipped schema.
 *
 * Two extent-contributor test files independently wrote this same four-table
 * loop, which is the shape jscpd counts as a clone. It is a genuinely shared
 * assertion rather than a deliberate independent restatement, so it belongs in
 * one place — unlike the pipeline oracle, whose duplication of production logic
 * is the instrument itself.
 *
 * `contexts` is looped rather than indexed so a contributor declaring several
 * extents at once (the package extent emits one per package) is fully covered.
 *
 * @param contribution - The rows a contributor returned
 */
export function expectContributionRowsValid(contribution: ExtentContribution): void {
  for (const row of contribution.contexts) {
    expect(() => ResolutionContextRowSchema.parse(row)).not.toThrow();
  }
  for (const row of contribution.resources) {
    expect(() => ResourceRowSchema.parse(row)).not.toThrow();
  }
  for (const row of contribution.realizations) {
    expect(() => ResourceRealizationRowSchema.parse(row)).not.toThrow();
  }
  for (const row of contribution.memberships) {
    expect(() => ResourceExtentRowSchema.parse(row)).not.toThrow();
  }
}

/**
 * Build one extent contribution against a fixture repository.
 *
 * The tracker → builder → `contribute` sequence is identical for every extent
 * contributor, and repeating it per suite is a jscpd clone. Generic over the
 * contributor so the git and filesystem lanes share one implementation rather
 * than two near-copies. `rootId` comes back too, so a caller can derive extent
 * context ids without constructing a second builder.
 *
 * @param root - Fixture repository root
 * @param contributor - The extent contributor to run
 * @returns The rows it emitted, plus the builder's root identity
 */
export async function buildExtentContribution(
  root: string,
  contributor: ExtentContributor
): Promise<{ contribution: ExtentContribution; rootId: string }> {
  const tracker = new GitTracker(root);
  await tracker.initialize({ includeUntracked: true });
  const builder = new ProjectionBuilder(root, tracker);

  return {
    contribution: await contributor.contribute(builder.base(), null),
    rootId: builder.identities.rootId,
  };
}

/** One fixture document: where it goes under the root, and what is in it. */
export interface CorpusFile {
  /** Root-relative, forward-slashed. */
  readonly path: string;
  readonly content: string;
}

/**
 * Write a fixture corpus beneath a temp root, creating the directories it needs.
 *
 * Extracted because two suites build the same corpus the same way in the same
 * `beforeEach` — `crawl-timing.test.ts` and `projection-store-roundtrip.test.ts`
 * both measure the projection driver over a linked chain of documents, so their
 * fixtures are identical by intent rather than by accident. Sharing it is what
 * keeps them measuring the same subject when one of them is edited.
 *
 * @param root - The temp root to write beneath
 * @param directories - Directories to create first, root-relative
 * @param corpus - The documents to write
 */
export async function writeCorpusFiles(
  root: string,
  directories: readonly string[],
  corpus: readonly CorpusFile[],
): Promise<void> {
  for (const directory of directories) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture directory beneath a mkdtemp root
    await mkdir(safePath.join(root, directory), { recursive: true });
  }
  await Promise.all(
    corpus.map((file) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
      writeFile(safePath.join(root, file.path), file.content, 'utf-8'),
    ),
  );
}

/** The shape {@link setupSubdirTestSuite} hands back. */
export interface SubdirTestSuite {
  suiteDir: string;
  tempDir: string;
  beforeAll: () => Promise<void>;
  afterAll: () => Promise<void>;
  beforeEach: () => Promise<void>;
}

/**
 * Register the standard per-test temp-root lifecycle and write a corpus into it.
 *
 * Registers hooks rather than returning them, which is the point: two suites
 * were repeating the same four `beforeAll`/`afterAll`/`beforeEach` lines
 * verbatim, and boilerplate restated is boilerplate that drifts — one suite
 * gaining a fixture the other silently lacks is a difference nobody reads a
 * lifecycle block closely enough to notice.
 *
 * Each suite keeps its OWN `afterEach`, deliberately: what a suite must reset is
 * a fact about what that suite touches, and hiding it here would make a leak
 * between tests invisible at the place it has to be reasoned about.
 *
 * @param suite - The suite handle from {@link setupSubdirTestSuite}
 * @param directories - Directories to create under the temp root, root-relative
 * @param corpus - The documents to write
 */
export function useCorpusSuite(
  suite: SubdirTestSuite,
  directories: readonly string[],
  corpus: readonly CorpusFile[],
): void {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(async () => {
    await writeCorpusFiles(suite.tempDir, directories, corpus);
  });
}
