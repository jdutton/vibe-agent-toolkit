/**
 * Changelog parsing utilities for marketplace publish.
 *
 * Follows Keep a Changelog format: https://keepachangelog.com/
 *
 * Used by publish-tree.ts to extract release-note content for the publish commit body.
 * VAT does NOT modify the user's CHANGELOG.md file — the published copy is byte-identical
 * to the source. These helpers only extract content for the commit message.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Regex to match the [Unreleased] heading (case-insensitive).
 */
const UNRELEASED_HEADING_RE = /^## \[unreleased\]\s*$/im;

/**
 * Regex to match any stamped version heading (e.g. `## [1.2.0]` or `## [1.2.0-rc.1]`).
 * Used to find where a section ends (= where the next version heading begins).
 */
const VERSION_HEADING_RE = /^## \[\d+\.\d+/m;

/**
 * Extract the content of the [Unreleased] section from a changelog string.
 * Returns the content between [Unreleased] heading and the next version heading (or EOF).
 * Returns empty string if no [Unreleased] section or it has no content.
 */
export function parseUnreleasedSection(changelog: string): string {
  const unreleasedMatch = UNRELEASED_HEADING_RE.exec(changelog);
  if (!unreleasedMatch) {
    return '';
  }

  const startIndex = unreleasedMatch.index + unreleasedMatch[0].length;
  const rest = changelog.slice(startIndex);

  const nextVersionMatch = VERSION_HEADING_RE.exec(rest);
  const content = nextVersionMatch
    ? rest.slice(0, nextVersionMatch.index)
    : rest;

  return content.trimEnd();
}

/**
 * Extract the content of a specific stamped version section (e.g. `## [1.2.0] - 2026-04-09`).
 *
 * Supports the "pre-stamped" workflow: a repo that promotes `[Unreleased]` to `[X.Y.Z]`
 * in its release commit before tagging, leaving `[Unreleased]` empty per the Keep a
 * Changelog canonical post-release state.
 *
 * Matches headings of the form `## [<version>]` with any trailing content (date, etc.)
 * on the same line. Requires an exact version match — `1.2` will NOT match `[1.2.0]`.
 *
 * Returns the trimmed content between the matching heading and the next `## [` version
 * heading (or EOF). Returns empty string if the version section does not exist.
 */
export function parseVersionSection(changelog: string, version: string): string {
  // Escape regex metacharacters in the version string (dots, hyphens, plus signs cover semver).
  const escaped = version.replaceAll(/[.+-]/g, String.raw`\$&`);
  // `## [<version>]` followed by any trailing content on the line (typically ` - date`).
  // eslint-disable-next-line security/detect-non-literal-regexp -- input escaped above
  const heading = new RegExp(String.raw`^## \[${escaped}\][^\n]*$`, 'm');
  const match = heading.exec(changelog);
  if (!match) {
    return '';
  }

  const startIndex = match.index + match[0].length;
  const rest = changelog.slice(startIndex);

  const nextVersionMatch = VERSION_HEADING_RE.exec(rest);
  const content = nextVersionMatch ? rest.slice(0, nextVersionMatch.index) : rest;

  return content.trim();
}

/**
 * Read a changelog file from disk.
 */
export function readChangelog(filePath: string, baseDir: string): string {
  const resolved = safePath.resolve(baseDir, filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
  return readFileSync(resolved, 'utf-8');
}
