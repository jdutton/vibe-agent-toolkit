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

import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { crawlDirectorySync, issueLocation, safePath } from '@vibe-agent-toolkit/utils';

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
  const files = crawlDirectorySync({
    baseDir: rootDir,
    include: INCLUDE_GLOBS,
    exclude: [],
    absolute: true,
    filesOnly: true,
    respectGitignore: false,
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
  return issues;
}
