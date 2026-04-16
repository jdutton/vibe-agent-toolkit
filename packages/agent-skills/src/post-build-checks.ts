/**
 * Post-build integrity checks for packaged skills.
 *
 * Run after packageSkill() completes — all files are copied, all links rewritten.
 * Detects unreferenced files and broken links in the packaged output.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { ValidationIssue } from './validators/types.js';

/**
 * Regex matching markdown inline links: [text](href).
 * Negated character classes [^\]\\] and [^)] are non-backtracking by design.
 */
// eslint-disable-next-line sonarjs/slow-regex -- negated character classes are non-backtracking
const INLINE_LINK_REGEX = /\[(?:[^\]\\]|\\.)*\]\(([^)]*)\)/g;

/**
 * Regex matching fenced code blocks (``` ... ```), including optional language hint.
 * Non-greedy body keeps matches scoped to a single block.
 */
const FENCED_CODE_REGEX = /```[\s\S]*?```/g;

/**
 * Regex matching inline code spans (`...`). Excludes newlines so runaway
 * backticks in prose don't swallow unrelated content.
 */
const INLINE_CODE_REGEX = /`[^`\n]*`/g;

/**
 * Strip markdown code spans and fenced code blocks from content before
 * scanning for links. Link-like patterns inside code are examples/templates
 * (e.g. `[text](path.md)` or ``` ```[x]({{var}}) ``` ```), not real links.
 */
function stripCodeBlocks(content: string): string {
  return content.replaceAll(FENCED_CODE_REGEX, '').replaceAll(INLINE_CODE_REGEX, '');
}

/**
 * Recursively collect all file paths in a directory.
 */
function walkDir(dir: string): string[] {
  const files: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir from validated output path
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = safePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Extract local file link hrefs from markdown content.
 * Skips external URLs, anchor-only links, and mailto links.
 * Also skips link-like patterns inside fenced code blocks and inline code
 * spans — those are examples/templates, not real links.
 */
function extractLocalLinks(content: string): string[] {
  const stripped = stripCodeBlocks(content);
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = INLINE_LINK_REGEX.exec(stripped)) !== null) {
    const href = match[1];
    // Skip empty, external URLs, anchors, mailto
    if (!href || href.startsWith('http://') || href.startsWith('https://') ||
        href.startsWith('#') || href.startsWith('mailto:')) {
      continue;
    }
    // Strip fragment
    const [withoutFragment] = href.split('#');
    if (withoutFragment) {
      links.push(withoutFragment);
    }
  }
  return links;
}

/**
 * Walk the markdown link graph starting at SKILL.md and return the set of
 * referenced file paths (normalized to forward slashes).
 *
 * SKILL.md itself is always included as the root.
 */
async function collectReferencedPaths(
  outputDir: string,
  allFileSet: Set<string>,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const skillMdPath = safePath.join(outputDir, 'SKILL.md');
  const mdQueue: string[] = [skillMdPath];
  const visited = new Set<string>();

  // SKILL.md itself is the root — always referenced
  referenced.add(toForwardSlash(skillMdPath));

  while (mdQueue.length > 0) {
    const mdFile = mdQueue.shift();
    if (!mdFile) break;

    const normalized = toForwardSlash(mdFile);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mdFile from walkDir output
    if (!existsSync(mdFile)) continue;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mdFile validated above
    const content = await readFile(mdFile, 'utf-8');
    const links = extractLocalLinks(content);

    for (const href of links) {
      const resolved = toForwardSlash(safePath.resolve(dirname(mdFile), href));
      referenced.add(resolved);

      // If it's a markdown file in the output, traverse it transitively
      if (resolved.endsWith('.md') && allFileSet.has(resolved) && !visited.has(resolved)) {
        mdQueue.push(resolved);
      }
    }
  }

  return referenced;
}

/**
 * Check that every file in the packaged output is referenced from some markdown file.
 *
 * Walks the output directory, parses all .md files for links, and reports any file
 * not reachable from the SKILL.md link graph.
 */
export async function checkUnreferencedFiles(outputDir: string): Promise<ValidationIssue[]> {
  const allFiles = walkDir(outputDir);
  const allFileSet = new Set(allFiles.map(f => toForwardSlash(f)));
  const referenced = await collectReferencedPaths(outputDir, allFileSet);

  // Find unreferenced files
  const issues: ValidationIssue[] = [];
  for (const file of allFiles) {
    const normalized = toForwardSlash(file);
    if (!referenced.has(normalized)) {
      const relativePath = toForwardSlash(safePath.relative(outputDir, file));
      issues.push({
        severity: 'error',
        code: 'PACKAGED_UNREFERENCED_FILE',
        message: `Packaged file not referenced from any markdown: ${relativePath}`,
        location: relativePath,
        fix: 'Add a markdown link to this file from SKILL.md or a linked resource, or suppress with ignoreValidationErrors',
      });
    }
  }

  return issues;
}

/**
 * Check that every local file link in packaged markdown files resolves to a file
 * that exists in the packaged output.
 */
export async function checkBrokenPackagedLinks(outputDir: string): Promise<ValidationIssue[]> {
  const allFiles = walkDir(outputDir);
  const mdFiles = allFiles.filter(f => f.endsWith('.md'));
  const allFileSet = new Set(allFiles.map(f => toForwardSlash(f)));

  const issues: ValidationIssue[] = [];

  for (const mdFile of mdFiles) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mdFile from walkDir
    const content = await readFile(mdFile, 'utf-8');
    const links = extractLocalLinks(content);
    const relativeMdPath = toForwardSlash(safePath.relative(outputDir, mdFile));

    for (const href of links) {
      const resolved = toForwardSlash(safePath.resolve(dirname(mdFile), href));
      if (!allFileSet.has(resolved)) {
        issues.push({
          severity: 'error',
          code: 'PACKAGED_BROKEN_LINK',
          message: `Broken link in packaged output: ${href} (from ${relativeMdPath})`,
          location: relativeMdPath,
          fix: 'This indicates a link-rewriting bug — the source link was valid but the packaged link is broken',
        });
      }
    }
  }

  return issues;
}
