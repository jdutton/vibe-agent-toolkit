/**
 * Post-build integrity checks for packaged skills.
 *
 * Run after packageSkill() completes — all files are copied, all links rewritten.
 * Detects unreferenced files and broken links in the packaged output.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { parseHtml } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
 * Extract local file hrefs from a content file — markdown or HTML.
 *
 * For markdown: regex-matches `[text](href)` links, skipping code blocks.
 * For HTML/HTM: uses `parseHtml` (parse5-based) and returns `local_file` hrefs only.
 * Fragments are stripped from all returned hrefs.
 */
async function extractLocalHrefs(filePath: string): Promise<string[]> {
  if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
    const result = await parseHtml(filePath);
    return result.links
      .filter(link => link.type === 'local_file')
      .map(link => {
        const [withoutFragment] = link.href.split('#');
        return withoutFragment ?? '';
      })
      .filter(href => href.length > 0);
  }
  // Markdown: read content and regex-match
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath from walkDir
  const content = await readFile(filePath, 'utf-8');
  return extractLocalLinks(content);
}

/**
 * Check hrefs from a content file against allFileSet and return PACKAGED_BROKEN_LINK
 * issues for any that don't resolve to a file in the packaged output.
 *
 * Shared by markdown and HTML broken-link checks to eliminate duplicate resolve/emit logic.
 */
function collectBrokenLinkIssues(
  sourceFile: string,
  hrefs: string[],
  allFileSet: Set<string>,
  outputDir: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const relativeSourcePath = toForwardSlash(safePath.relative(outputDir, sourceFile));
  for (const href of hrefs) {
    const resolved = toForwardSlash(safePath.resolve(dirname(sourceFile), href));
    if (!allFileSet.has(resolved)) {
      issues.push({
        severity: CODE_REGISTRY.PACKAGED_BROKEN_LINK.defaultSeverity,
        code: 'PACKAGED_BROKEN_LINK',
        message: `Broken link in packaged output: ${href} (from ${relativeSourcePath})`,
        location: relativeSourcePath,
        fix: CODE_REGISTRY.PACKAGED_BROKEN_LINK.fix,
        reference: CODE_REGISTRY.PACKAGED_BROKEN_LINK.reference,
      });
    }
  }
  return issues;
}

/**
 * Walk the markdown and HTML link graph starting at SKILL.md and return the set of
 * referenced file paths (normalized to forward slashes).
 *
 * SKILL.md itself is always included as the root. Traversal follows `.md`, `.html`,
 * and `.htm` links transitively so an HTML file referenced only by another HTML file
 * is not reported as unreferenced.
 */
async function collectReferencedPaths(
  outputDir: string,
  allFileSet: Set<string>,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const skillMdPath = safePath.join(outputDir, 'SKILL.md');
  const fileQueue: string[] = [skillMdPath];
  const visited = new Set<string>();

  // SKILL.md itself is the root — always referenced
  referenced.add(toForwardSlash(skillMdPath));

  while (fileQueue.length > 0) {
    const filePath = fileQueue.shift();
    if (!filePath) break;

    const normalized = toForwardSlash(filePath);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath from walkDir output
    if (!existsSync(filePath)) continue;

    const hrefs = await extractLocalHrefs(filePath);

    for (const href of hrefs) {
      const resolved = toForwardSlash(safePath.resolve(dirname(filePath), href));
      referenced.add(resolved);

      // Traverse .md, .html, and .htm files transitively
      const isTraversable =
        (resolved.endsWith('.md') || resolved.endsWith('.html') || resolved.endsWith('.htm')) &&
        allFileSet.has(resolved) &&
        !visited.has(resolved);
      if (isTraversable) {
        fileQueue.push(resolved);
      }
    }
  }

  return referenced;
}

/**
 * Record packaged files whose output-relative path appears anywhere in any
 * packaged content file (markdown or HTML) — inside code blocks, inline code
 * spans, or prose — as "documented" references.
 *
 * A file that a skill author chose to bundle but never documents is the real
 * problem this check exists to catch; documentation by code-block invocation
 * is still documentation. By contrast, `collectReferencedPaths` is intentionally
 * strict (only formal link syntax) because it also walks the transitive link
 * graph, which would be unbounded if we followed substring hits.
 */
async function addMentionReferences(
  outputDir: string,
  referenced: Set<string>,
  candidates: string[],
  contentFiles: string[],
): Promise<void> {
  if (candidates.length === 0 || contentFiles.length === 0) {
    return;
  }

  const contents = await Promise.all(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- contentFile from walkDir
    contentFiles.map(f => readFile(f, 'utf-8')),
  );
  const haystack = contents.join('\n');

  for (const candidate of candidates) {
    const relativePath = toForwardSlash(safePath.relative(outputDir, candidate));
    if (haystack.includes(relativePath)) {
      referenced.add(toForwardSlash(candidate));
    }
  }
}

/**
 * Check that every file in the packaged output is referenced from some markdown or HTML file.
 *
 * Two-pass detection:
 * 1. Walk formal link graph from SKILL.md (strict, transitive, covers .md and .html/.htm).
 * 2. For files not covered by pass 1, check whether their output-relative path
 *    is mentioned anywhere in packaged content files (markdown or HTML).
 *    Authors often document CLI scripts via invocation examples rather than
 *    formal links, and that counts as documented.
 */
export async function checkUnreferencedFiles(outputDir: string): Promise<ValidationIssue[]> {
  const allFiles = walkDir(outputDir);
  const allFileSet = new Set(allFiles.map(f => toForwardSlash(f)));
  const referenced = await collectReferencedPaths(outputDir, allFileSet);

  // Second pass: treat any path mention in packaged content files as documentation.
  const candidates = allFiles.filter(f => !referenced.has(toForwardSlash(f)));
  const contentFiles = allFiles.filter(f =>
    f.endsWith('.md') || f.endsWith('.html') || f.endsWith('.htm')
  );
  await addMentionReferences(outputDir, referenced, candidates, contentFiles);

  // Find unreferenced files
  const issues: ValidationIssue[] = [];
  for (const file of allFiles) {
    const normalized = toForwardSlash(file);
    if (!referenced.has(normalized)) {
      const relativePath = toForwardSlash(safePath.relative(outputDir, file));
      issues.push({
        severity: CODE_REGISTRY.PACKAGED_UNREFERENCED_FILE.defaultSeverity,
        code: 'PACKAGED_UNREFERENCED_FILE',
        message: `Packaged file not referenced from any content file (markdown or HTML): ${relativePath}`,
        location: relativePath,
        fix: CODE_REGISTRY.PACKAGED_UNREFERENCED_FILE.fix,
        reference: CODE_REGISTRY.PACKAGED_UNREFERENCED_FILE.reference,
      });
    }
  }

  return issues;
}

/**
 * Check that every local file link in packaged markdown and HTML files resolves to a file
 * that exists in the packaged output.
 */
export async function checkBrokenPackagedLinks(outputDir: string): Promise<ValidationIssue[]> {
  const allFiles = walkDir(outputDir);
  const linkableFiles = allFiles.filter(f =>
    f.endsWith('.md') || f.endsWith('.html') || f.endsWith('.htm')
  );
  const allFileSet = new Set(allFiles.map(f => toForwardSlash(f)));

  const issues: ValidationIssue[] = [];

  for (const sourceFile of linkableFiles) {
    const hrefs = await extractLocalHrefs(sourceFile);
    issues.push(...collectBrokenLinkIssues(sourceFile, hrefs, allFileSet, outputDir));
  }

  return issues;
}
