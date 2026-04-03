/**
 * Changelog parsing and stamping utilities for marketplace publish.
 *
 * Follows Keep a Changelog format: https://keepachangelog.com/
 * Parses [Unreleased] section and stamps it with version + date on publish.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regex to match the [Unreleased] heading (case-insensitive).
 */
const UNRELEASED_HEADING_RE = /^## \[unreleased\]\s*$/im;
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
 * Replace `## [Unreleased]` with `## [version] - date` in changelog text.
 * Returns the full modified changelog string.
 */
export function stampChangelog(changelog: string, version: string, date: string): string {
  return changelog.replace(UNRELEASED_HEADING_RE, `## [${version}] - ${date}`);
}

/**
 * Read a changelog file from disk.
 */
export function readChangelog(filePath: string, baseDir: string): string {
  const resolved = resolve(baseDir, filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated config
  return readFileSync(resolved, 'utf-8');
}
