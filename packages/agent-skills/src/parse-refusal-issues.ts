/**
 * The two ways a skill lane meets a document it could not parse, as findings —
 * both through resources' one not-admitted contract (`not-admitted.ts`), so one
 * pathological document gets one code and one sentence whichever lane found it.
 *
 * 1. **A refusal by the crawl.** The registry parses on the bounded route (a
 *    worker, under its limits) and a file it refused is in no list but
 *    `getParseRefusedResources()`: not admitted, so a link walk that reaches it
 *    finds it on disk and ships it as an opaque asset — its links never walked,
 *    nothing checked, exit 0. {@link parseRefusedIssues} names every such file
 *    the skill reaches.
 * 2. **A refusal of an in-process parse.** `parseFileCached` falls back to one
 *    bounded parse through the pool when this thread's stack overflows, so its
 *    refusal is the worker's; a parse with no bounded route (the SKILL.md
 *    frontmatter parser, `parseMarkdown`) overflows this thread's stack.
 *    {@link inProcessRefusalIssue} classifies either.
 */

import {
  inProcessRefusalEntry,
  notAdmittedIssues,
  type ParseRefusedResource,
} from '@vibe-agent-toolkit/resources';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
 * What a refused file costs every skill lane, in the one sentence resources'
 * `parseRefusedMessage` reports a refusal with.
 */
export const SKILL_REACHED_REFUSAL_CONSEQUENCE = "the skill's links reach it but it was neither checked nor walked";

/**
 * The findings for refused files, each at its location under `locationRoot`.
 *
 * @param refused - The refusals
 * @param locationRoot - The base every location is relative to
 * @returns `RESOURCE_PARSE_LIMIT_EXCEEDED` / `RESOURCE_PARSE_WORKER_DIED` issues
 */
function refusalIssues(refused: readonly ParseRefusedResource[], locationRoot: string): ValidationIssue[] {
  return notAdmittedIssues(
    { unreadable: [], parseRefused: refused },
    { locationRoot, consequence: SKILL_REACHED_REFUSAL_CONSEQUENCE },
  );
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
  return refusalIssues(refusedAmong(refused, reached), locationRoot);
}

/**
 * The finding for an in-process parse that refused its document, or
 * `undefined` for any other error (which the caller handles as it did).
 *
 * @param error - What the parse threw
 * @param filePath - The document
 * @param locationRoot - The base its location is relative to
 * @returns A `RESOURCE_PARSE_LIMIT_EXCEEDED` / `RESOURCE_PARSE_WORKER_DIED` error issue, or `undefined`
 */
export function inProcessRefusalIssue(error: unknown, filePath: string, locationRoot: string): ValidationIssue | undefined {
  const entry = inProcessRefusalEntry(filePath, error);
  return entry === undefined ? undefined : refusalIssues([entry], locationRoot)[0];
}
