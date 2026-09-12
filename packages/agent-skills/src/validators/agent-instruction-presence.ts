/**
 * Presence-side detection for repo-internal agent-instruction files.
 *
 * `LINK_TO_AGENT_INSTRUCTION_FILE` catches the *reference* — a packaged doc
 * linking a `CLAUDE.md` — and the walker then keeps that file out of the
 * bundle. It cannot catch the other half: a file that arrives in the
 * distributed artifact without any link at all. The plugin lane tree-copies its
 * `source:` directory verbatim, so a `CLAUDE.md` sitting beside `plugin.json`
 * ships to every consumer, and the orphan check does not object because plugin
 * artifacts are exempt from skill reachability rules by design.
 *
 * This detector reads the built tree directly, so it is blind to how the file
 * got there. That is the point: link-following, `files:` globs, and verbatim
 * tree-copies are three routes into a bundle, and only the first is visible to
 * the walker.
 */

import { existsSync } from 'node:fs';

import { type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { issueLocation, safePath, transientRefusalClause } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync, type DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';

import { normalizeRelPath } from '../files-config.js';

import { materializeIssue } from './rule-engine/index.js';
import { AGENT_INSTRUCTION_FILE_PATTERNS, toAnyDepthGlobs } from './validation-rules.js';

/**
 * Match each basename at the tree root AND at any depth — the root is the case
 * that matters most (a `CLAUDE.md` beside `plugin.json` is the observed defect).
 */
const INCLUDE_GLOBS = toAnyDepthGlobs(AGENT_INSTRUCTION_FILE_PATTERNS);

/**
 * Report every repo-internal agent-instruction file present in a distributed
 * tree.
 *
 * @param rootDir Absolute path to the tree to scan (a packaged skill output
 *   directory, or a plugin directory about to be published).
 * @param locationRoot Anchor base for reported locations. Pass the run's stated
 *   root, not `rootDir`, when the two differ — a location the reader cannot
 *   open is worse than no location.
 * @param declaredDests Skill-output-relative dests named by EXPLICIT (non-glob)
 *   `files:` entries — {@link explicitFilesConfigDests}. Such a dest is NOT
 *   reported: naming a file in config is an unambiguous instruction to ship it,
 *   and this finding's remediation is "remove the file", i.e. undo what the
 *   config sanctioned. Callers that cannot know the config (an installed
 *   third-party bundle, a plugin tree with no `files:` block) pass `[]` — the
 *   honest answer, since intent is genuinely unknowable there.
 *
 *   REQUIRED, not defaulted: every caller must state its answer, or a lane that
 *   silently inherits `[]` re-opens the contradiction for the population it
 *   governs. Matching is EXACT membership, never a prefix test — a directory-ish
 *   dest must not launder its whole subtree (see {@link explicitFilesConfigDests}).
 */
export function detectPackagedAgentInstructionFiles(
  rootDir: string,
  locationRoot: string,
  declaredDests: readonly string[],
): ValidationIssue[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- rootDir is a validated build-output path
  if (!existsSync(rootDir)) return [];

  const declared = new Set(declaredDests.map((d) => normalizeRelPath(d)));

  // `respectGitignore: false` and an empty `exclude` are both load-bearing: the
  // subject is BUILT output, which normally lives under a gitignored `dist/`
  // that the crawler's defaults would skip entirely — the scan would pass by
  // scanning nothing.
  //
  // `onUnreadable` DEGRADES rather than stops: this detector is a backstop
  // appended to a larger report (audit, verify, build), and one directory it
  // cannot list must not destroy every finding beside it. The gap is not
  // dropped either — each refusal becomes a `SCAN_PATH_UNREADABLE` finding
  // below, anchored like the others, so a reader sees exactly which subtree
  // this pass never saw. The crawler used to hand back the shorter list here
  // with nothing said; that was the defect, not the throw.
  const refusals: DirectoryRefusal[] = [];
  const files = crawlDirectorySync({
    baseDir: rootDir,
    include: INCLUDE_GLOBS,
    exclude: [],
    absolute: true,
    filesOnly: true,
    respectGitignore: false,
    onUnreadable: (refusal) => refusals.push(refusal),
  });

  const issues: ValidationIssue[] = [];
  for (const file of files) {
    // The declaration is expressed relative to the SCANNED tree (a `files:` dest is
    // skill-output-relative), while the reported location is relative to
    // `locationRoot` — the two roots differ whenever a batching caller anchors
    // elsewhere, so the exemption test must use rootDir and never the location.
    if (declared.has(normalizeRelPath(safePath.relative(rootDir, file)))) continue;
    const location = issueLocation(file, locationRoot);
    issues.push(materializeIssue('PACKAGED_AGENT_INSTRUCTION_FILE', { location, detail: location }));
  }
  for (const refusal of refusals) {
    issues.push(unlistableDirectoryIssue(refusal, locationRoot));
  }
  return issues;
}

/**
 * The finding for one directory this pass could not list.
 *
 * `SCAN_PATH_UNREADABLE` is the registry's existing code for exactly this shape
 * ("was not scanned; findings from every readable sibling are still reported"),
 * kept at its default `warning` — a second code for the same gap on a second
 * lane would only split the count a reader greps for. The detail names the
 * errno, which is what distinguishes a permissions problem from a descriptor
 * shortage, and the location is anchored against `locationRoot` like every
 * other finding here — `.` rather than `''` when the scanned tree itself
 * refused, for the same reason `unreadablePathResult` in the audit command
 * gives: an empty location reached the report as `location: ""` and rendered
 * the detail as a bare `": EACCES …"`.
 *
 * ⚠️ Callers that ALSO walk this tree themselves (the audit command's
 * directory scan) will meet the same refusal twice. That overlap is theirs to
 * collapse, keyed on what this issue carries — code and location — because
 * only the caller knows which of its lanes reached the directory; see
 * `dedupeUnreadablePathResults` in the audit command.
 */
function unlistableDirectoryIssue(refusal: DirectoryRefusal, locationRoot: string): ValidationIssue {
  const location = issueLocation(refusal.directory, locationRoot) || '.';
  const clause = refusal.transient
    ? `${transientRefusalClause(refusal.code)} — re-run before investigating anything`
    : `listing was refused with ${refusal.code}`;
  return materializeIssue('SCAN_PATH_UNREADABLE', {
    location,
    detail: `${location}: ${clause}; every agent-instruction file beneath it is unreported`,
  });
}
