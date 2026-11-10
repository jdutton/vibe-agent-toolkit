/**
 * The files a resources crawl enumerated and did not admit, as findings — for the
 * verbs that crawl and never call `ResourceRegistry.validate()` (which reports both
 * logs itself).
 *
 * Such a file is in no other list the registry keeps: not in `getAllResources()`,
 * so a verb that reports only what was admitted calls a population with a hole in
 * it complete, at exit 0.
 */

import type { ParseRefusedResource, UnreadableResource } from '@vibe-agent-toolkit/resources';
import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** A file's location relative to `root`, forward-slashed. */
function locationOf(filePath: string, root: string): string {
  return toForwardSlash(safePath.relative(root, filePath));
}

/**
 * One error finding per file whose parse this run refused, under the code the
 * registry assigned it (`RESOURCE_PARSE_LIMIT_EXCEEDED` or
 * `RESOURCE_PARSE_WORKER_DIED`).
 *
 * @param refused - `registry.getParseRefusedResources()`
 * @param root - The base every reported location is relative to
 * @param consequence - What the refusal cost this verb, e.g. `it is not in the index`
 * @returns One issue per refused file, in the order the crawl met them
 */
export function parseRefusedIssues(
  refused: readonly ParseRefusedResource[],
  root: string,
  consequence: string,
): ValidationIssue[] {
  return refused.map((entry) => {
    const location = locationOf(entry.filePath, root);
    return createRegistryIssue(
      entry.code,
      `'${location}' was enumerated but ${entry.reason}, so ${consequence}. Nothing was stored for it: the next run parses it again.`,
      { location },
    );
  });
}

/**
 * One `RESOURCE_UNREADABLE` error finding per file the crawl enumerated and could
 * not read.
 *
 * @param unreadable - `registry.getUnreadableResources()`
 * @param root - The base every reported location is relative to
 * @returns One issue per unreadable file, in the order the crawl met them
 */
export function unreadableResourceIssues(
  unreadable: readonly UnreadableResource[],
  root: string,
): ValidationIssue[] {
  return unreadable.map((entry) => {
    const location = locationOf(entry.filePath, root);
    return createRegistryIssue(
      'RESOURCE_UNREADABLE',
      `'${location}' was enumerated but could not be read: ${entry.reason}`,
      { location },
    );
  });
}
