/**
 * Shared test helpers for resources package tests
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Assertion } from 'vitest';

import { parseMarkdown } from '../src/link-parser.js';
import { validateLink } from '../src/link-validator.js';
import type { HeadingNode, ResourceLink, ValidationIssue } from '../src/types.js';

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
  let currentDir = startDir;
  while (currentDir !== path.dirname(currentDir)) {
    try {
      const pkgPath = path.join(currentDir, 'package.json');
      // eslint-disable-next-line security/detect-non-literal-require -- Dynamic path is safe in test helper, pkgPath constructed from trusted directory traversal
      const pkg = require(pkgPath);
      if (pkg.name === packageName) {
        return currentDir;
      }
    } catch {
      // Keep searching upward
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error(`Could not find package root for ${packageName}`);
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
  let currentDir = startDir;
  while (currentDir !== path.dirname(currentDir)) {
    try {
      const pkgPath = path.join(currentDir, 'package.json');
      // eslint-disable-next-line security/detect-non-literal-require -- Dynamic path is safe in test helper, pkgPath constructed from trusted directory traversal
      const pkg = require(pkgPath);
      // Check if this is the monorepo root (has workspaces)
      if (pkg.workspaces && pkg.name === 'vibe-agent-toolkit') {
        return currentDir;
      }
    } catch {
      // Keep searching upward
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error('Could not find monorepo root');
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
 * Helper to create a simple heading tree
 */
export function createHeadings(
  ...headings: Array<{ text: string; slug: string; level?: number; children?: HeadingNode[] }>
): HeadingNode[] {
  return headings.map((h) => ({
    text: h.text,
    slug: h.slug,
    level: h.level ?? 2,
    children: h.children,
  }));
}

/**
 * Options for validating a link with expected results
 */
export interface ValidateLinkOptions {
  /** Source file path */
  sourceFile: string;
  /** Link to validate */
  link: ResourceLink;
  /** Headings map for validation */
  headingsMap: Map<string, HeadingNode[]>;
  /** Expected validation result (null = valid, object = error/warning/info) */
  expected: null | {
    severity: ValidationIssue['severity'];
    type: ValidationIssue['type'];
    messageContains?: string | string[];
    hasSuggestion?: boolean;
    /** Expected link property value */
    link?: string;
  };
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
  // Assert severity and type
  expectFn(result?.severity).toBe(expected.severity);
  expectFn(result?.type).toBe(expected.type);

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
 * Validate a link and assert expected results
 * Eliminates duplication in validation test patterns
 */
export async function assertValidation(
  options: ValidateLinkOptions,
  expectFn: (_: ValidationIssue | null) => Assertion<ValidationIssue | null>,
): Promise<void> {
  const { sourceFile, link, headingsMap, expected } = options;

  const result = await validateLink(link, sourceFile, headingsMap);

  if (expected === null) {
    expectFn(result).toBeNull();
  } else {
    expectFn(result).not.toBeNull();
    assertValidationError(result, expected, expectFn as (_: unknown) => Assertion<unknown>);
  }
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
