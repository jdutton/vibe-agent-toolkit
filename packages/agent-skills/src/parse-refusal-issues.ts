/**
 * The two ways a skill lane meets a document it could not parse, as findings.
 *
 * 1. **A refusal by the crawl.** The registry parses on the bounded route (a
 *    worker, under its limits) and a file it refused is in no list but
 *    `getParseRefusedResources()`: not admitted, so a link walk that reaches it
 *    finds it on disk and ships it as an opaque asset — its links never walked,
 *    nothing checked, exit 0. {@link parseRefusedIssues} names every such file
 *    the skill reaches.
 * 2. **A stack overflow in an in-process parse.** `parseFileCached` and
 *    `parseMarkdown` called on this thread run unbounded; a deep enough
 *    document (nested frontmatter or markdown) overflows the stack, and the
 *    error escaped as a crash or was demoted to a warning.
 *    {@link stackOverflowIssue} classifies it.
 *
 * Both are `error` severity under the codes the resources lane reports them
 * with, so one pathological document gets one answer whichever lane found it.
 */

import { isStackOverflow, type ParseRefusedResource } from '@vibe-agent-toolkit/resources';
import { createRegistryIssue, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { issueLocation, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** One spelling per file, whatever separators or relative segments the caller used. */
function pathKey(filePath: string): string {
  return toForwardSlash(safePath.resolve(filePath));
}

/**
 * The refusals among `paths`, in refusal-log order.
 *
 * @param refused - A registry's `getParseRefusedResources()` (or several, concatenated)
 * @param paths - The files a skill reaches: its SKILL.md and everything its walk bundles
 * @returns The refused entries for those files
 */
export function refusedAmong(
  refused: readonly ParseRefusedResource[],
  paths: readonly string[],
): ParseRefusedResource[] {
  const wanted = new Set(paths.map(pathKey));
  return refused.filter((entry) => wanted.has(pathKey(entry.filePath)));
}

/**
 * The message for one refused file a skill reaches.
 *
 * @param entry - The refusal
 * @param location - Where to say it is
 * @returns The sentence every skill lane reports it with
 */
export function parseRefusedMessage(entry: ParseRefusedResource, location: string): string {
  return `'${location}' is reached by the skill's links but ${entry.reason}, so it was neither checked nor walked. Nothing was stored for it: the next run parses it again.`;
}

/**
 * One error finding per file the skill reaches whose parse the crawl refused.
 *
 * @param refused - A registry's `getParseRefusedResources()` (or several, concatenated)
 * @param reached - The files the skill reaches
 * @param locationRoot - The base every location is relative to
 * @returns `RESOURCE_PARSE_LIMIT_EXCEEDED` / `RESOURCE_PARSE_WORKER_DIED` issues
 */
export function parseRefusedIssues(
  refused: readonly ParseRefusedResource[],
  reached: readonly string[],
  locationRoot: string,
): ValidationIssue[] {
  return refusedAmong(refused, reached).map((entry) => {
    const location = issueLocation(entry.filePath, locationRoot);
    return createRegistryIssue(entry.code, parseRefusedMessage(entry, location), { location });
  });
}

/**
 * The finding for an in-process parse that overflowed the stack, or `undefined`
 * for any other error (which the caller handles as it did).
 *
 * @param error - What the parse threw
 * @param location - The document's location, as the caller reports it
 * @returns A `RESOURCE_PARSE_LIMIT_EXCEEDED` error issue, or `undefined`
 */
export function stackOverflowIssue(error: unknown, location: string): ValidationIssue | undefined {
  if (!isStackOverflow(error)) return undefined;
  return createRegistryIssue(
    'RESOURCE_PARSE_LIMIT_EXCEEDED',
    `'${location}' could not be parsed: its parse overflowed the stack (its frontmatter or markdown nests too deeply), so it was not checked.`,
    { location },
  );
}
