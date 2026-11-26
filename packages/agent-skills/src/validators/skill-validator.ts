import * as fs from 'node:fs';
import { basename, dirname } from 'node:path';

import {
  classifyParseFailure,
  isLocalFileLink,
  type NotAdmittedRoots,
  partitionNotAdmitted,
  resolveLocalHref,
  type LinkType,
  type RunContentCache,
} from '@vibe-agent-toolkit/resources';
import {
  anchoredAt,
  createRegistryIssue,
  runSingleUnitValidation,
  type ValidationConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import {
  everywhere,
  findProjectRoot,
  followedKindSync,
  type FollowedPathKind,
  forEachInOrder,
  type FsFaultFacts,
  isPathAbsentError,
  issueLocation,
  linkResolutionFault,
  pathPresent,
  relativeEscapesRoot,
  safePath,
  appendAll,
} from '@vibe-agent-toolkit/utils';


import type { EvidenceRecord } from '../evidence/index.js';
import { parseRefusalIssue } from '../parse-refusal-issues.js';
import { frontmatterVerdictOf } from '../parsers/frontmatter-parser.js';
import { linkedFileSkillText, rawUtf8Text, readSkillDocument, type SkillDocument, type SkillTextRun, withSkillTextRun } from '../skill-text-lane.js';

import { detectBundledResourceWithoutLinks } from './bundled-resource-link-detection.js';
import { observationToIssue, runCompatDetectors } from './compat-detectors.js';
import { detectUndeclaredCrossSkillAuth } from './cross-skill-dependency-detection.js';
import { describeIssues } from './describe-issues.js';
import { validateFrontmatterRules, validateFrontmatterSchema } from './frontmatter-validation.js';
import { detectNonImperativeBody } from './imperative-body-detection.js';
import { detectKebabCaseViolation } from './kebab-case-detection.js';
import { collectUnqualifiedMcpToolIssues } from './mcp-tool-qualification.js';
import type { LinkedFileValidationResult, ValidateOptions, ValidationResult } from './types.js';
import { isNeverPackagedBasename } from './validation-rules.js';

/**
 * Validate an Agent Skill (SKILL.md file)
 *
 * Uses ResourceRegistry for markdown/link validation
 * Adds skill-specific validation (frontmatter schema, skill rules)
 *
 * @see https://code.claude.com/docs/en/skills — Official Claude Code skill spec
 * @param options - Validation options
 * @returns Validation result with all validation issues
 */
export function validateSkill(options: ValidateOptions): Promise<ValidationResult> {
  // One run for every read this validation makes — the SKILL.md and the whole
  // link walk — the caller's when it holds one.
  return withSkillTextRun((run) => validateSkillOn(options, run), options.run);
}

/**
 * The SKILL.md's document for {@link validateSkillOn}, read once for the whole
 * validation (its frontmatter, its record and the link walk's root): the run's
 * store's facts when it serves the file, else its bounded read and parse. A
 * refusal of the read or the parse (a limit, a dead worker) is the result's one
 * issue; any other failure propagates.
 *
 * @param skillPath - The SKILL.md
 * @param run - The run
 * @param where - The caller's side, and the root the refusal's location is relative to
 * @returns The document, or the refusal
 */
async function readRootDocument(
  skillPath: string,
  run: SkillTextRun,
  where: { readonly side: ValidateOptions['side']; readonly locationRoot: string },
): Promise<{ readonly document: SkillDocument } | { readonly refused: ValidationIssue }> {
  try {
    return { document: await readSkillDocument(skillPath, run, where.side) };
  } catch (error) {
    const refused = parseRefusalIssue(error, skillPath, where.locationRoot);
    if (refused === undefined) throw error;
    return { refused };
  }
}

/**
 * {@link validateSkill}, on a run.
 *
 * @param options - Validation options
 * @param run - Where every read and parse goes
 * @returns Validation result with all validation issues
 */
async function validateSkillOn(options: ValidateOptions, run: SkillTextRun): Promise<ValidationResult> {
  const { skillPath } = options;

  // Root every emitted location is relative to. A batching caller supplies its
  // scan root; otherwise fall back to the same chain
  // `validateSkillForPackaging` uses (config root -> git root -> skill dir) so
  // the two skills-lane entry points cannot disagree about the coordinate
  // system their issues are expressed in.
  const projectRoot = findProjectRoot(dirname(skillPath)) ?? dirname(skillPath);
  const locationRoot = options.locationRoot ?? projectRoot;
  const skillLocation = issueLocation(skillPath, locationRoot);
  const policy: ResultPolicy = {
    validation: options.validation,
    resourcesValidation: options.resourcesValidation,
    roots: { locationRoot, projectRoot },
  };

  const issues: ValidationIssue[] = [];
  const allEvidence: EvidenceRecord[] = [];

  // Validate file exists. The skill's directory is the tree: the SKILL.md entry's link chain is read
  // by text before the kernel follows it, and a refused probe is the caller's side's fault — never "does not exist".
  if (!pathPresent(skillPath, { follow: dirname(skillPath) }, everywhere(options.side), 'probe')) {
    issues.push({
      severity: 'error',
      code: 'SKILL_MISSING_FRONTMATTER',
      message: 'File does not exist',
      location: skillLocation,
    });
    return buildResult(skillPath, issues, policy);
  }

  const read = await readRootDocument(skillPath, run, { side: options.side, locationRoot });
  if ('refused' in read) return buildResult(skillPath, [read.refused], policy);
  const { document } = read;
  const { skillText } = document;
  const lineCount = skillText.lineCount;
  // Worded from the document's facts, never a second read of the file.
  const parseResult = frontmatterVerdictOf(skillText.frontmatterFence, document);

  if (!parseResult.success) {
    issues.push({
      severity: 'error',
      code: 'SKILL_MISSING_FRONTMATTER',
      message: parseResult.error,
      location: skillLocation,
      line: 1,
      fix: 'Add YAML frontmatter with name and description fields',
    });

    return buildResult(skillPath, issues, policy, { lineCount });
  }

  const { frontmatter } = parseResult;

  // Surface kebab-case name violations as a named info code in addition
  // to the schema-level error.
  if (typeof frontmatter['name'] === 'string') {
    const kebabIssue = detectKebabCaseViolation(
      'skill',
      frontmatter['name'],
      skillLocation,
    );
    if (kebabIssue) {
      issues.push(kebabIssue);
    }
  }

  // Frontmatter validation (schema + rules), the cross-skill dependency
  // smell that looks at body prose requiring tokens the description omits,
  // and the gray-zone second-person-opener heuristic from the plugin-dev
  // cross-walk (info severity).
  appendAll(issues, [
    ...validateFrontmatterSchema(frontmatter, skillLocation),
    ...validateFrontmatterRules(frontmatter, skillLocation),
    ...detectUndeclaredCrossSkillAuth(frontmatter, skillText, 'crossSkillAuthBody', skillLocation),
    ...detectNonImperativeBody(skillText, skillLocation),
  ]);

  // Validate warning-level rules (skill-specific)
  validateWarningRules(lineCount, skillLocation, issues);

  // Compat capability detection: collect raw evidence, derive observations,
  // surface each observation as an issue (severity comes from CODE_REGISTRY).
  const { evidence: rootEvidence, observations: rootObservations } =
    runCompatDetectors(skillText, skillPath, locationRoot, frontmatter);
  appendAll(allEvidence, rootEvidence);
  for (const obs of rootObservations) {
    issues.push(observationToIssue(obs, skillLocation));
  }

  // Unqualified MCP tool names. This lane needs its OWN call: the detector is
  // not one of `runCompatDetectors`, and until this line its only call sites
  // were inside `validateSkillForPackaging`. That made the check structurally
  // unreachable for every skill audited without a governing VAT config — which
  // is every INSTALLED skill under `~/.claude/plugins/**`, the exact corpus the
  // detector's precision table was measured on. `vat audit --user` before and
  // after, over 851 installed skills: 0 occurrences -> 11 in 7 documents, with
  // no other code's count moving — which is exactly the row
  // docs/validation-codes.md already published from a DIRECT run of the
  // detector. The command now reproduces the number the docs quote. See the
  // sibling call in the linked-file walk below, and the two in
  // packaging-validator.ts that this pair mirrors.
  collectUnqualifiedMcpToolIssues(skillText, skillLocation, issues);

  // Transitive link traversal (BFS)
  const skillDir = options.rootDir ?? dirname(skillPath);
  const linkedFiles = await traverseLinks(document, skillPath, skillDir, { locationRoot, side: options.side }, issues, allEvidence, run);

  // Bundled-resource link detection — fires after link traversal so the
  // linkedFiles set reflects everything reachable from SKILL.md.
  const bundled = await bundledResourceIssues(document.text, skillDir, linkedFiles, { locationRoot, side: options.side, skillPath });
  if ('refused' in bundled) return buildResult(skillPath, [bundled.refused], policy);
  appendAll(issues, bundled.issues);

  // Unreferenced file detection
  if (options.checkUnreferencedFiles) {
    await detectUnreferencedFiles(skillPath, skillDir, locationRoot, linkedFiles, issues, run.content);
  }

  // Build metadata
  const metadata = buildMetadata(frontmatter, lineCount);

  const result = buildResult(skillPath, issues, policy, metadata);

  if (linkedFiles.length > 0) {
    // Derived from the RESOLVED issues, so an ignored finding cannot resurface here.
    result.linkedFiles = linkedFiles.map((lf) => {
      const location = issueLocation(lf.path, locationRoot);
      return { ...lf, issues: result.issues.filter((issue) => issue.location === location) };
    });
  }

  if (allEvidence.length > 0) {
    result.evidence = allEvidence;
  }

  return result;
}


/**
 * {@link detectBundledResourceWithoutLinks} for {@link validateSkillOn}. Only a
 * store-served SKILL.md's body is read here, and the parse limit refuses that
 * read only when the file grew past the cap during the run (after the store's
 * record of it). The refusal is then the result's ONE finding (`refused`): the
 * caller returns it alone, as the cold path returns its own first read's
 * refusal, before any finding made from the stored facts. Any other failure
 * propagates.
 *
 * @param readBody - The SKILL.md's text, read lazily
 * @param skillDir - The skill directory
 * @param linkedFiles - What the link walk reached
 * @param where - Where findings are located, the caller's side, and the SKILL.md
 * @returns The findings, or the refusal that replaces every finding
 */
async function bundledResourceIssues(
  readBody: () => Promise<string>,
  skillDir: string,
  linkedFiles: readonly LinkedFileWalkRecord[],
  where: { readonly locationRoot: string; readonly side: ValidateOptions['side']; readonly skillPath: string },
): Promise<{ readonly issues: ValidationIssue[] } | { readonly refused: ValidationIssue }> {
  try {
    return { issues: await detectBundledResourceWithoutLinks(readBody, skillDir, linkedFiles.map((lf) => lf.path), where.locationRoot, where.side) };
  } catch (error) {
    const refused = parseRefusalIssue(error, where.skillPath, where.locationRoot);
    if (refused === undefined) throw error;
    return { refused };
  }
}

// ============================================================================
// Link Traversal (BFS)
// ============================================================================

/**
 * Files to never flag as unreferenced.
 *
 * The skill's own entry point, plus everything VAT never packages into a skill
 * bundle (agent-instruction files and navigation files). Delegates to the shared
 * CASE-INSENSITIVE matcher rather than a Set of literal spellings: a `Readme.md`
 * is as unreferenceable as a `README.md`, and a Set can only ever know the
 * spellings someone thought to enumerate.
 */
function isExemptFromUnreferencedCheck(fileName: string): boolean {
  return fileName === 'SKILL.md' || isNeverPackagedBasename(fileName);
}

/**
 * What a link target resolves to, beneath the skill directory `within`: its link chain is read by
 * text before the kernel follows it. A probe the OS refused, or a chain VAT will not hand the kernel
 * (a link to a network or device path), is that ONE target's fault — returned for the caller to
 * report, never read as "not found" and never the end of the walk.
 */
function linkTargetKind(target: string, within: string): { kind: FollowedPathKind; fault: FsFaultFacts | undefined } {
  try {
    return { kind: followedKindSync(target, within), fault: undefined };
  } catch (error) {
    const fault = linkResolutionFault(error);
    return { kind: 'absent', fault };
  }
}

/**
 * Validate a single local_file link: boundary check, existence check.
 *
 * @returns 'boundary' | 'broken' | 'valid' indicating the link status
 */
function validateLocalLink(
  link: { href: string; line?: number | undefined },
  currentPath: string,
  skillDir: string,
  locationRoot: string,
  issues: ValidationIssue[],
): { status: 'skip' | 'boundary' | 'broken' | 'valid'; resolvedPath: string } {
  // Resolve href to filesystem path (strips anchor, decodes percent-encoding).
  // Skill validation is a single-skill bounded walk — leading-/ links are
  // treated as unresolved (skipped) here. The resources-validate / audit paths
  // surface the project-boundary-aware cases as LINK_BROKEN_FILE (resources-validate)
  // or LINK_MISSING_TARGET (audit/packaging) issues.
  const resolved = resolveLocalHref(link.href, currentPath);
  if (resolved.kind !== 'resolved') {
    return { status: 'skip', resolvedPath: '' };
  }

  const resolvedPath = resolved.resolvedPath;
  const relativeToBoundary = safePath.relative(skillDir, resolvedPath);
  const escapesBoundary = relativeEscapesRoot(relativeToBoundary);

  // Check existence BEFORE boundary classification — a link that both
  // escapes the skill directory boundary and is missing must surface as a
  // broken link (error), not be silently swallowed as a boundary warning.
  // LINK_OUTSIDE_SKILL_DIR (below) only applies when the target actually
  // exists outside the boundary.
  // A target VAT could not check: reported, never bundled, never parsed.
  const unreadable = (why: string): { status: 'broken'; resolvedPath: string } => {
    issues.push(createRegistryIssue('LINK_TARGET_UNREADABLE', `${why}: ${link.href}`, {
      location: issueLocation(currentPath, locationRoot),
      ...(link.line !== undefined && { line: link.line }),
      link: link.href,
    }));
    return { status: 'broken', resolvedPath };
  };
  const { kind, fault } = linkTargetKind(resolvedPath, skillDir);
  if (fault !== undefined) {
    return unreadable(`Link target could not be examined (${fault.errno}), so it has not been checked`);
  }
  if (kind === 'absent') {
    issues.push({
      severity: 'error',
      code: 'LINK_INTEGRITY_BROKEN',
      ...anchoredAt(`Link target not found: ${link.href}`, issueLocation(currentPath, locationRoot)),
      ...(link.line !== undefined && { line: link.line }),
      link: link.href,
      fix: 'Fix link path or restore missing file',
    });
    return { status: 'broken', resolvedPath };
  }

  // A named pipe, socket or device has no content to check or bundle, and opening
  // a pipe blocks until a writer appears — so it is refused here, before the walk
  // would parse it or the packager copy it (a non-markdown one used to be dropped
  // from the bundle silently, leaving the packaged link dangling).
  if (kind === 'other') {
    return unreadable('Link target is not a regular file (a named pipe, socket or device), so it has no content to check or bundle');
  }

  if (escapesBoundary) {
    // The skill-directory boundary; the project-root escape is the walker's `LINK_OUTSIDE_PROJECT`.
    issues.push(createRegistryIssue('LINK_OUTSIDE_SKILL_DIR', `Link points outside skill directory: ${link.href}`, {
      location: issueLocation(currentPath, locationRoot),
      ...(link.line !== undefined && { line: link.line }),
      link: link.href,
    }));
    return { status: 'boundary', resolvedPath };
  }

  return { status: 'valid', resolvedPath };
}

/** Result of processing a single file's links */
interface FileProcessResult {
  localLinkCount: number;
  linksValidated: number;
  newPaths: string[];
}

/**
 * Process all local links in a parsed markdown file.
 * Returns link validation results and newly discovered paths for BFS.
 */
function processFileLinks(
  links: SkillDocument['links'],
  currentPath: string,
  skillDir: string,
  locationRoot: string,
  issues: ValidationIssue[],
  visited: Set<string>,
): FileProcessResult {
  const localLinks = links.filter(link => isLocalFileLink(link.type as LinkType));
  const newPaths: string[] = [];
  let linksValidated = 0;

  for (const link of localLinks) {
    const { status, resolvedPath } = validateLocalLink(link, currentPath, skillDir, locationRoot, issues);

    if (status === 'skip') {
      continue;
    }

    linksValidated++;

    if (status === 'valid' && resolvedPath.endsWith('.md') && !visited.has(resolvedPath)) {
      visited.add(resolvedPath);
      newPaths.push(resolvedPath);
    }
  }

  return { localLinkCount: localLinks.length, linksValidated, newPaths };
}

/** A linked file's walk record before its issues are resolved — see {@link validateSkill}. */
type LinkedFileWalkRecord = Omit<LinkedFileValidationResult, 'issues'>;

/**
 * Traverse links from SKILL.md using BFS, validating each link target.
 *
 * - Missing file -> LINK_INTEGRITY_BROKEN error
 * - Outside skill directory -> LINK_OUTSIDE_SKILL_DIR (default `ignore`; the
 *   adopter's `validation.severity` decides)
 * - Existing .md file -> recurse (add to BFS queue)
 * - Non-markdown asset -> existence check only
 *
 * The root's document is the one the caller read: the SKILL.md is read once
 * per validation.
 *
 * @throws {ParserUnavailableError} If the markdown parser module cannot be
 *   loaded — a broken install fails the validation rather than being demoted to
 *   a per-document finding
 */
async function traverseLinks(
  root: SkillDocument,
  skillPath: string,
  skillDir: string,
  { locationRoot, side }: { readonly locationRoot: string; readonly side: ValidateOptions['side'] },
  issues: ValidationIssue[],
  allEvidence: EvidenceRecord[],
  run: SkillTextRun,
): Promise<LinkedFileWalkRecord[]> {
  const resolvedSkillPath = safePath.resolve(skillPath);
  const visited = new Set<string>([resolvedSkillPath]);
  const linkedFiles: LinkedFileWalkRecord[] = [];
  const queue: string[] = [resolvedSkillPath];

  // In order: a breadth-first worklist growing from its own results, guarded by
  // `visited`, whose parses share one cache.
  await forEachInOrder(queue, async (currentPath) => {
    // Each file's links, frontmatter and record: the run's store's when it holds
    // the file, else its parse, a counted miss.
    let document: SkillDocument;
    try {
      // The SKILL.md is the document the caller already read; every other file is read here.
      document = currentPath === resolvedSkillPath ? root : await readSkillDocument(currentPath, run, side);
    } catch (error) {
      // A broken INSTALL, not a broken document. The parser loads in the
      // worker — lazily, only on a cache miss, so a fully warm validation loads
      // no parser at all — which puts a loader failure in this catch. Unguarded
      // it minted one `LINK_INTEGRITY_BROKEN` per file, blamed every innocent
      // document, never walked the link graph, and still exited 0. The
      // classifier is an allowlist: it rethrows that, and every other VAT
      // defect, untouched.
      classifyParseFailure(error);

      // A document the worker refused (a limit, a dead worker) is not "could
      // not be parsed, so skipped": nothing in it was checked, and it is the
      // author's to simplify — an error, under the code and sentence the crawl
      // lanes use.
      const limit = parseRefusalIssue(error, currentPath, locationRoot);
      if (limit !== undefined) {
        issues.push(limit);
        return;
      }

      issues.push({
        severity: 'warning',
        code: 'LINK_INTEGRITY_BROKEN',
        ...anchoredAt(`File exists but could not be parsed: ${issueLocation(currentPath, locationRoot)}`, issueLocation(currentPath, locationRoot)),
      });
      return;
    }

    const processed = processFileLinks(document.links, currentPath, skillDir, locationRoot, issues, visited);
    appendAll(queue, processed.newPaths);

    // Compat capability detection for linked files (root SKILL.md handled by
    // the top-level invocation), over the file's record: the core's output over
    // its whole text, fenced code blocks intact.
    if (currentPath !== resolvedSkillPath) {
      // The raw text this lane has always scanned: the record when the file is plain UTF-8, else a read.
      const linkedText = await linkedFileSkillText(currentPath, document, run);
      const { evidence: linkedEvidence, observations: linkedObservations } =
        runCompatDetectors(linkedText, currentPath, locationRoot, document.frontmatter);
      appendAll(allEvidence, linkedEvidence);
      appendAll(issues, linkedObservations.map(obs => observationToIssue(obs, issueLocation(currentPath, locationRoot))));
      // Same detector on each linked file, mirroring the per-bundled-file call
      // in packaging-validator.ts. Without it the two lanes disagree about what
      // they scan: a skill naming its tools bare in a referenced resource file
      // is a finding when packaged and silence when audited. On the installed
      // corpus it adds 4 occurrences in 1 document (11/7 -> 15/8).
      // ⚠️ That is the ONLY linked-file sample the corpus offers, so this lane's
      // precision rests on n=1 — and one of its four occurrences is a section
      // HEADING naming the tool, a weaker shape than the step-an-agent-copies
      // case the SKILL.md measurement was built from. Warning severity and the
      // per-identifier `link` waiver are what make that acceptable to ship;
      // re-measure here first if this code is ever proposed for `error`.
      // Whole-file bytes, frontmatter included: the detector strips leading
      // frontmatter itself, so an `allowed-tools:` list cannot seed the
      // vocabulary it then fires against.
      collectUnqualifiedMcpToolIssues(linkedText, issueLocation(currentPath, locationRoot), issues);
    }

    // Record linked file result (skip SKILL.md itself — it's the root)
    if (currentPath !== resolvedSkillPath) {
      linkedFiles.push({
        path: currentPath,
        lineCount: document.skillText.lineCount,
        linksFound: processed.localLinkCount,
        linksValidated: processed.linksValidated,
      });
    }
  });

  return linkedFiles;
}

/**
 * Detect .md files in the skill directory that are not reachable from SKILL.md.
 *
 * Excludes SKILL.md, CLAUDE.md, and navigation file patterns (README.md, etc.).
 */
async function detectUnreferencedFiles(
  skillPath: string,
  skillDir: string,
  locationRoot: string,
  linkedFiles: readonly LinkedFileWalkRecord[],
  issues: ValidationIssue[],
  content: RunContentCache,
): Promise<void> {
  // Collect all visited paths (SKILL.md + linked files)
  const visitedPaths = new Set<string>([safePath.resolve(skillPath)]);
  for (const lf of linkedFiles) {
    visitedPaths.add(lf.path);
  }

  // Glob all .md files in the skill directory
  const allMdFiles = fs.globSync('**/*.md', { cwd: skillDir });

  const unreferencedFiles: string[] = [];

  for (const relPath of allMdFiles) {
    const absPath = safePath.resolve(skillDir, relPath);
    const fileName = basename(relPath);

    // Skip excluded patterns
    if (isExemptFromUnreferencedCheck(fileName)) {
      continue;
    }

    // Skip files that were visited during traversal
    if (visitedPaths.has(absPath)) {
      continue;
    }

    unreferencedFiles.push(relPath);
  }

  // Check for implicit references among unreferenced files
  const implicitRefs = await extractImplicitReferences(skillDir, unreferencedFiles, visitedPaths, content);

  for (const relPath of unreferencedFiles) {
    const absPath = safePath.resolve(skillDir, relPath);

    const ref = implicitRefs.find((r) => r.referencedFile === relPath);
    if (ref) {
      issues.push({
        severity: 'info',
        code: 'SKILL_IMPLICIT_REFERENCE',
        ...anchoredAt(`File implicitly referenced (not via markdown link) in ${basename(ref.foundIn)}: ${ref.matchedText}`, issueLocation(absPath, locationRoot)),
        fix: 'Consider using a standard markdown link [text](path) for better tooling support',
      });
    } else {
      issues.push({
        severity: 'info',
        code: 'SKILL_UNREFERENCED_FILE',
        ...anchoredAt(`Markdown file not referenced from SKILL.md link graph: ${relPath}`, issueLocation(absPath, locationRoot)),
        fix: 'Add a link to this file from SKILL.md or a linked document, or remove the file',
      });
    }
  }
}

// ============================================================================
// Implicit Reference Detection
// ============================================================================

/** Result of finding an implicit (non-markdown-link) reference to a file */
export interface ImplicitReference {
  /** Relative path of the referenced file (e.g., "references/domain-template.md") */
  referencedFile: string;
  /** Absolute path of the file containing the reference */
  foundIn: string;
  /** The matched text snippet (for diagnostics) */
  matchedText: string;
  /** Line number where found (1-based) */
  line: number;
}

/** Characters that can appear immediately before/after a file path in text */
const BOUNDARY_CHARS = new Set([
  ' ', '\t',        // whitespace
  '`',              // backtick (inline code)
  '(', ')',         // parentheses
  '"', "'",         // quotes
  '@',              // Claude force-load prefix
  '*',              // bold/italic markers
  '[', ']',         // brackets
  ':', ',', ';',    // punctuation (colon, comma, semicolon)
  '.', '!', '?',   // sentence-ending punctuation after "see filename.md."
]);

/**
 * Check if a candidate path appears as a self-contained reference at position `index` in `line`.
 * The character before and after the candidate must be a boundary character, or BOL/EOL.
 */
function isSelfContainedMatch(line: string, index: number, candidateLength: number): boolean {
  // Check character before (BOL is ok)
  if (index > 0 && !BOUNDARY_CHARS.has(line.charAt(index - 1))) {
    return false;
  }

  // Check character after (EOL is ok)
  const afterIndex = index + candidateLength;
  if (afterIndex < line.length && !BOUNDARY_CHARS.has(line.charAt(afterIndex))) {
    return false;
  }

  return true;
}

/**
 * Check if the match is inside a URL (contains :// nearby)
 */
function isInsideUrl(line: string, index: number): boolean {
  // Look for :// pattern before the match (within reasonable distance)
  const lookback = line.slice(Math.max(0, index - 100), index);
  return lookback.includes('://');
}

/**
 * Build a map of candidate search strings to their source file paths.
 * Each unreferenced file generates 2-3 candidate strings.
 */
function buildCandidateMap(
  unreferencedFiles: readonly string[],
): Map<string, string> {
  const candidates = new Map<string, string>();

  // Count basenames to detect ambiguity
  const basenameCounts = new Map<string, number>();
  for (const relPath of unreferencedFiles) {
    const base = basename(relPath);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }

  for (const relPath of unreferencedFiles) {
    // Always add the relative path as-is
    candidates.set(relPath, relPath);

    // Add ./prefixed variant
    candidates.set(`./${relPath}`, relPath);

    // Add basename only if unambiguous
    const base = basename(relPath);
    if (base !== relPath && (basenameCounts.get(base) ?? 0) <= 1) {
      candidates.set(base, relPath);
    }
  }

  return candidates;
}

/**
 * Find the first self-contained, non-URL occurrence of `candidate` in `line`.
 * Returns the match index or -1 if no valid match found.
 */
function findBoundedMatch(line: string, candidate: string): number {
  let searchFrom = 0;
  let matchIndex: number;

  while ((matchIndex = line.indexOf(candidate, searchFrom)) !== -1) {
    searchFrom = matchIndex + 1;

    if (isSelfContainedMatch(line, matchIndex, candidate.length) && !isInsideUrl(line, matchIndex)) {
      return matchIndex;
    }
  }

  return -1;
}

/**
 * Scan a single file's lines for implicit references to unreferenced files: its raw UTF-8 text,
 * read through the run's one content reader (the read the BFS's parse was made from, so no second
 * read of the file).
 */
async function scanFileForReferences(
  visitedPath: string,
  candidates: Map<string, string>,
  results: ImplicitReference[],
  reader: RunContentCache,
): Promise<void> {
  let content: string;
  try {
    content = await rawUtf8Text(visitedPath, reader);
  } catch (error) {
    // The BFS already read this file, so "not there now" is a race with nothing
    // left to scan. A refusal is not that: skipping it silently dropped every
    // implicit reference the file carried, and the unreferenced-file finding
    // it would have cleared fired instead.
    if (isPathAbsentError(error)) return;
    throw error;
  }

  const lines = content.split('\n');
  for (const [lineIndex, line] of lines.entries()) {
    for (const [candidate, referencedFile] of candidates) {
      const matchIndex = findBoundedMatch(line, candidate);
      if (matchIndex === -1) {
        continue;
      }

      // Extract a reasonable snippet around the match
      const snippetStart = Math.max(0, matchIndex - 20);
      const snippetEnd = Math.min(line.length, matchIndex + candidate.length + 20);
      const matchedText = line.slice(snippetStart, snippetEnd).trim();

      results.push({
        referencedFile,
        foundIn: visitedPath,
        matchedText,
        line: lineIndex + 1,
      });
    }
  }
}

/**
 * Scan BFS-visited files for implicit (non-markdown-link) references to unreferenced files.
 *
 * "Implicit reference" means the file path appears in the text bounded by delimiter
 * characters (backticks, parens, whitespace, etc.) but NOT as a standard markdown link.
 *
 * @param skillDir - Absolute path to the skill directory
 * @param unreferencedFiles - Relative paths of .md files not found by BFS traversal
 * @param visitedFiles - Absolute paths of files visited during BFS (to scan for references)
 * @param content - The run's one content reader, which each visited file's text is read through
 * @returns Array of implicit references found
 */
export async function extractImplicitReferences(
  _skillDir: string,
  unreferencedFiles: readonly string[],
  visitedFiles: ReadonlySet<string>,
  content: RunContentCache,
): Promise<ImplicitReference[]> {
  if (unreferencedFiles.length === 0) {
    return [];
  }

  const candidates = buildCandidateMap(unreferencedFiles);
  const results: ImplicitReference[] = [];

  // In order: the results keep the visited files' order.
  await forEachInOrder([...visitedFiles], (visitedPath) => scanFileForReferences(visitedPath, candidates, results, content));

  return results;
}

function validateWarningRules(
  lineCount: number,
  skillLocation: string,
  issues: ValidationIssue[]
): void {
  // Check if skill is too long (>5000 lines)
  const MAX_SKILL_LINES = 5000;
  if (lineCount > MAX_SKILL_LINES) {
    issues.push({
      severity: 'warning',
      code: 'SKILL_TOO_LONG',
      message: `Skill exceeds recommended length (${lineCount} > ${MAX_SKILL_LINES} lines)`,
      location: skillLocation,
      fix: 'Consider breaking skill into multiple smaller skills or using reference files',
    });
  }
}

function buildMetadata(
  frontmatter: Record<string, unknown>,
  lineCount: number
): ValidationResult['metadata'] {
  const metadata: ValidationResult['metadata'] = { lineCount };

  if (frontmatter['name'] && typeof frontmatter['name'] === 'string') {
    metadata.name = frontmatter['name'];
  }

  if (frontmatter['description'] && typeof frontmatter['description'] === 'string') {
    metadata.description = frontmatter['description'];
  }

  return metadata;
}

/** What resolves this lane's findings: the skill's `validation`, and the project's `resources.validation` for a file not admitted. */
interface ResultPolicy {
  readonly validation: ValidationConfig;
  readonly resourcesValidation: ValidationConfig;
  readonly roots: NotAdmittedRoots;
}

/**
 * The ONE exit for this lane: resolves every issue against `validation`, except
 * a file not admitted — that is `resources.validation`'s alone (`partitionNotAdmitted`).
 */
function buildResult(
  skillPath: string,
  rawIssues: readonly ValidationIssue[],
  policy: ResultPolicy,
  metadata?: ValidationResult['metadata']
): ValidationResult {
  const { rest, notAdmitted } = partitionNotAdmitted(rawIssues, policy.resourcesValidation, policy.roots);
  const issues = [...runSingleUnitValidation(rest, policy.validation).emitted, ...notAdmitted];
  const result: ValidationResult = {
    path: skillPath,
    type: 'agent-skill',
    ...describeIssues(issues, 'agent-skill'),
    issues,
  };

  if (metadata) {
    result.metadata = metadata;
  }

  return result;
}
