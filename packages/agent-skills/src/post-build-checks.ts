/**
 * Post-build integrity checks for packaged skills.
 *
 * Run after packageSkill() completes — all files are copied, all links rewritten.
 * Detects unreferenced files and broken links in the packaged output.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseFileCached } from '@vibe-agent-toolkit/resources';
import { type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { normalizeRelPath } from './files-config.js';
import { evaluate, makeRuleContext, materializeIssue } from './validators/rule-engine/index.js';

/**
 * Regex matching markdown inline links: [text](href).
 *
 * The negated character classes were once documented here as "non-backtracking
 * by design". That was wrong, and it is why this regex sat quadratic behind a
 * disable comment for so long: they backtrack, each step just fails fast — and
 * the cost was never inside one match attempt, it was the scan RESTARTING at
 * every bracket of a run. See the note on the lookbehind below.
 */
// The `(?<!\[)` is load-bearing, not cosmetic. Without it a run of `[` with no
// closing bracket makes the engine restart the `[^\]]*` scan at EVERY bracket,
// which is quadratic: measured 2,632 ms on 40k brackets. Because any match
// starting at the second `[` of a run is also matchable from the first (the
// negated class admits `[`), skipping non-initial brackets loses no match and
// makes the scan linear — the same input drops to 0.1 ms.
const INLINE_LINK_REGEX = /(?<!\[)\[(?:[^\]\\]|\\.)*\]\(([^)]*)\)/g;

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
 * For HTML/HTM: uses the parse5-based HTML parser and returns `local_file` hrefs only.
 * Fragments are stripped from all returned hrefs.
 */
async function extractLocalHrefs(filePath: string): Promise<string[]> {
  if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
    const result = await parseFileCached(filePath, 'html');
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
 * Remediation for a link broken because a glob `files:` entry's never-package
 * filter refused its target.
 *
 * The registry `fix` for `PACKAGED_BROKEN_LINK` says to report a VAT bug. That is
 * right for the population it was written for and actively wrong here — VAT
 * dropped the file deliberately, by policy — so the issue is re-fixed rather than
 * re-coded. Deliberately NOT a new code: the finding is the same one (a link in
 * the output resolves to nothing, still an error, still blocking), and `code` is
 * what adopters key `validation.severity` / `validation.allow` on, so splitting it
 * would silently orphan every existing `PACKAGED_BROKEN_LINK` override.
 */
const NEVER_PACKAGED_LINK_FIX =
  'Nothing to report — VAT dropped this file on purpose (a `files:` glob never packages ' +
  'agent-instruction or navigation files). Ship it by adding an explicit `files:` entry that ' +
  'names it (`source: <path>`), point the link at content that does ship, or drop the link.';

/**
 * Extra detail (with a leading space) when a broken link's target is a file a
 * glob `files:` entry actually dropped in THIS build, otherwise `''`.
 *
 * Keyed on the drop, never on the basename. A basename test claimed a glob had
 * refused the file in builds where no glob ran at all — a false story on a
 * build-BLOCKING error, whose prescribed remedy ("declare it explicitly") is not
 * even satisfiable when the link resolves outside the skill output dir, since
 * `dest` is schema-guarded to stay inside it.
 */
function neverPackagedClause(href: string, wasDropped: boolean): string {
  if (!wasDropped) return '';
  const name = href.slice(href.lastIndexOf('/') + 1);
  return (
    ` — '${name}' was matched by a glob 'files:' entry and dropped: it is never packaged` +
    ` into a skill bundle. Declare it explicitly (source: <path>/${name}) to ship it, or drop the link.`
  );
}

/**
 * Check hrefs from a content file against allFileSet and return PACKAGED_BROKEN_LINK
 * issues for any that don't resolve to a file in the packaged output.
 *
 * Shared by markdown and HTML broken-link checks to eliminate duplicate resolve/emit logic.
 *
 * `droppedDestSet` holds skill-output-relative dests a glob `files:` entry dropped
 * (from `applyFilesConfig`). Empty for callers with no files-config context, which
 * is the honest answer for them: they cannot know that anything was dropped, so
 * they must not claim it was.
 */
function collectBrokenLinkIssues(
  sourceFile: string,
  hrefs: string[],
  allFileSet: Set<string>,
  outputDir: string,
  droppedDestSet: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const relativeSourcePath = toForwardSlash(safePath.relative(outputDir, sourceFile));
  for (const href of hrefs) {
    const resolved = toForwardSlash(safePath.resolve(dirname(sourceFile), href));
    if (!allFileSet.has(resolved)) {
      // A link whose target is a directory that EXISTS in the output is valid —
      // walkDir populates allFileSet with FILES only, so directory paths are never
      // in the set. Reached today only for a directory the packager materialized
      // itself (a `files:` dest tree); an AUTHORED directory link never survives
      // this far, because the packager flattens bundled resources into `resources/`
      // and so strips any link that has no packaged counterpart (skill-packager.ts
      // `bundledLinkTemplate`). Before that strip existed, the slash spelling
      // (`concepts/`) survived rewrite verbatim and landed here pointing at a
      // directory the output does not have — failing the build under
      // PACKAGED_BROKEN_LINK, whose remediation text blames a VAT bug.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved is a normalized path from a validated output directory
      const isExistingDirectory = statSync(resolved, { throwIfNoEntry: false })?.isDirectory() === true;
      if (isExistingDirectory) {
        continue;
      }
      // Built-path edge extraction: a link whose target is absent from the
      // packaged output. The engine resolves this to PACKAGED_BROKEN_LINK
      // (a link-rewriter bug) rather than LINK_MISSING_TARGET via phase: 'built'.
      const code = evaluate(makeRuleContext({ subject: 'edge', phase: 'built', existsAtSource: false }));
      if (code !== null) {
        const wasDropped = droppedDestSet.has(toForwardSlash(safePath.relative(outputDir, resolved)));
        const issue = materializeIssue(code, {
          location: relativeSourcePath,
          detail: `link: ${href} from ${relativeSourcePath}${neverPackagedClause(href, wasDropped)}`,
        });
        issues.push(wasDropped ? { ...issue, fix: NEVER_PACKAGED_LINK_FIX } : issue);
      }
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
 *
 * A third way to not be an orphan is to be DECLARED: `filesConfigDests` carries
 * the `files:` dests the packager just materialized (the return value of
 * `applyFilesConfig`). Naming a `source`/`dest` pair in config is proof of intent
 * on equal footing with a link or a mention — the rule engine has always modeled
 * it as a peer clause (`ctx.inFilesConfig`) — so the caller MUST pass the list.
 * Omitting it makes every `files:`-injected file (a vendored engine, a generated
 * schema, a data pack — none of them meant for a human reader) fail the build as
 * a file the author forgot to document. The parameter defaults to empty only so a
 * check against an output dir with no `files:` config reads cleanly.
 *
 * @param outputDir Absolute path to the packaged skill output.
 * @param filesConfigDests Skill-output-relative dests declared in `files:`, as
 *   returned by `applyFilesConfig`. Normalized here so a hand-built list spelled
 *   `./x` or with backslashes still matches.
 */
export async function checkUnreferencedFiles(
  outputDir: string,
  filesConfigDests: readonly string[] = [],
): Promise<ValidationIssue[]> {
  const declaredDests = new Set(filesConfigDests.map(d => normalizeRelPath(d)));
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
      // Built-path file extraction: a packaged file reachable by neither link
      // nor mention nor files: declaration. The engine resolves this to
      // PACKAGED_UNREFERENCED_FILE for a skill-bundled copy at the built phase —
      // and to nothing at all when the file is declared, which is why the
      // declaration must be reported here rather than assumed false.
      const code = evaluate(makeRuleContext({
        subject: 'file',
        phase: 'built',
        copyRole: 'skill-bundled',
        reachableFromSkillMd: false,
        referencedHow: 'none',
        inFilesConfig: declaredDests.has(relativePath),
      }));
      if (code !== null) {
        issues.push(materializeIssue(code, { location: relativePath, detail: relativePath }));
      }
    }
  }

  return issues;
}

/**
 * Check that every local file link in packaged markdown and HTML files resolves to a file
 * that exists in the packaged output.
 *
 * @param outputDir Absolute path to the packaged skill output.
 * @param droppedDests Skill-output-relative dests a glob `files:` entry matched
 *   and the never-package list refused — `applyFilesConfig(...).dropped`, mapped
 *   to `.dest`. A link resolving to one of THESE is broken by deliberate policy,
 *   and gets a remediation that says so instead of the generic "report a VAT bug".
 *   Defaults to none for callers that never ran a files config (e.g.
 *   `validateShippedPluginSkillLinks`, which inspects an already-built plugin
 *   tree): they cannot know a drop happened, so they correctly claim no cause.
 */
export async function checkBrokenPackagedLinks(
  outputDir: string,
  droppedDests: readonly string[] = [],
): Promise<ValidationIssue[]> {
  const droppedDestSet = new Set(droppedDests.map(d => normalizeRelPath(d)));
  const allFiles = walkDir(outputDir);
  const linkableFiles = allFiles.filter(f =>
    f.endsWith('.md') || f.endsWith('.html') || f.endsWith('.htm')
  );
  const allFileSet = new Set(allFiles.map(f => toForwardSlash(f)));

  const issues: ValidationIssue[] = [];

  for (const sourceFile of linkableFiles) {
    const hrefs = await extractLocalHrefs(sourceFile);
    issues.push(...collectBrokenLinkIssues(sourceFile, hrefs, allFileSet, outputDir, droppedDestSet));
  }

  return issues;
}
