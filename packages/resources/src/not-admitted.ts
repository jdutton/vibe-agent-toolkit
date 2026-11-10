/**
 * The ONE contract for a file a crawl enumerated and did not admit — unreadable,
 * or its parse refused for this run (a limit, a dead worker) — as findings, and
 * as a count.
 *
 * Such a file is in no list a registry keeps but its two logs: not in
 * `getAllResources()`, so a verb that reports only what was admitted calls a
 * population with a hole in it complete, at exit 0. Every consumer reads it
 * here, so one pathological document gets one code, one message shape, one
 * severity and one place in `examined` whichever verb met it:
 *
 * - {@link parseRefusedEntry} turns a per-run refusal — logged by a crawl, or
 *   thrown at a single-file add — into the log entry;
 * - {@link notAdmittedIssues} turns the log into findings at their default
 *   severity, for a lane that runs the validation framework itself
 *   (`ResourceRegistry.validate()`, a skill's packaging validation);
 * - {@link notAdmittedFindings} also resolves them through that framework's
 *   allow filter and severity (`resolveFindings`), for a verb that reports them
 *   beside no framework run (`vat resources scan`, `vat rag index`), so
 *   `validation.severity.RESOURCE_PARSE_LIMIT_EXCEEDED` means the same thing in
 *   every verb;
 * - {@link notAdmittedInScope} and {@link notAdmittedCount} are how a verb
 *   counts them in `examined`: every one, scoped to a `--collection` by the
 *   collection's own patterns, as the registry assigns membership.
 */

import { createRegistryIssue, resolveFindings, type ValidationConfig, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { issueLocation } from '@vibe-agent-toolkit/utils';

import { matchesCollection } from './collection-matcher.js';
import { isParseLimitError, isPerRunParseRefusal, isStackOverflow, type PerRunParseRefusal } from './parse-limits.js';
import type { ParseRefusedResource, UnreadableResource } from './resource-registry.js';
import type { CollectionConfig } from './schemas/project-config.js';

/** A registry's two logs of files it enumerated and did not admit. */
export interface NotAdmittedLog {
  readonly unreadable: readonly UnreadableResource[];
  readonly parseRefused: readonly ParseRefusedResource[];
}

/** Where a verb reports its not-admitted files, and what not admitting one cost it. */
export interface NotAdmittedWording {
  /** The base every `location` is relative to. */
  readonly locationRoot: string;
  /** What the file's absence cost this verb, e.g. `it is not in the index`. */
  readonly consequence: string;
}

/**
 * What stopped a parse, as the clause every lane reports it with — and, path-free,
 * as the message of the per-blob refusal row a projection lane reads it back from
 * (`parseRefusedRealizations`), so a blob two files share names neither.
 *
 * @param error - What refused it
 * @returns The finding code, and the clause naming the limit and its bound or the cause of death
 */
export function parseRefusal(error: PerRunParseRefusal): Pick<ParseRefusedResource, 'code' | 'reason'> {
  return isParseLimitError(error)
    ? { code: 'RESOURCE_PARSE_LIMIT_EXCEEDED', reason: `its parse was stopped at its ${error.limit} limit (${error.bound})` }
    : { code: 'RESOURCE_PARSE_WORKER_DIED', reason: `the parse worker holding it died (${error.message})` };
}

/**
 * @param filePath - The refused file
 * @param error - What refused it
 * @returns The log entry every consumer reads
 */
export function parseRefusedEntry(filePath: string, error: PerRunParseRefusal): ParseRefusedResource {
  return { filePath, ...parseRefusal(error) };
}

/**
 * The entry for whatever an IN-PROCESS parse threw that refuses the file: a
 * per-run refusal (the bounded fallback `parseFileCached` takes on an overflow),
 * or a stack overflow in a parse that has no bounded route (the SKILL.md
 * frontmatter parser) — `undefined` for anything else, which the caller
 * handles as it did.
 *
 * @param filePath - The document
 * @param error - What its parse threw
 * @returns The log entry, or `undefined` when the error is not a refusal
 */
export function inProcessRefusalEntry(filePath: string, error: unknown): ParseRefusedResource | undefined {
  if (isPerRunParseRefusal(error)) return parseRefusedEntry(filePath, error);
  if (!isStackOverflow(error)) return undefined;
  return {
    filePath,
    code: 'RESOURCE_PARSE_LIMIT_EXCEEDED',
    reason: 'its parse overflowed the stack of the thread it ran on (its frontmatter or markdown nests too deeply)',
  };
}

/**
 * The sentence every consumer reports one refused file with.
 *
 * @param entry - The refusal
 * @param location - Where to say the file is
 * @param consequence - What its absence cost the verb
 * @returns The message
 */
export function parseRefusedMessage(entry: ParseRefusedResource, location: string, consequence: string): string {
  return `'${location}' was enumerated but ${entry.reason}, so ${consequence}. Nothing was stored for it: the next run parses it again.`;
}

/**
 * One error finding per file not admitted, at its registry default severity:
 * `RESOURCE_UNREADABLE`, then `RESOURCE_PARSE_LIMIT_EXCEEDED` /
 * `RESOURCE_PARSE_WORKER_DIED`, each in the order the crawl met them.
 *
 * An unreadable file's raw fs message is never in it: Node's fs errors embed
 * the absolute path, which would leak a home directory into CI logs; the errno
 * code is named instead.
 *
 * @param log - The registry's logs
 * @param wording - Where to locate them, and what their absence cost
 * @returns The findings, unresolved — for a lane that runs the framework itself
 */
export function notAdmittedIssues(log: NotAdmittedLog, wording: NotAdmittedWording): ValidationIssue[] {
  const unreadable = log.unreadable.map(({ filePath, code }) => {
    const location = issueLocation(filePath, wording.locationRoot);
    const errno = code === undefined ? '' : ` (${code})`;
    return createRegistryIssue(
      'RESOURCE_UNREADABLE',
      `'${location}' was enumerated but could not be read${errno}, so ${wording.consequence}.`,
      { location },
    );
  });
  const refused = log.parseRefused.map((entry) => {
    const location = issueLocation(entry.filePath, wording.locationRoot);
    return createRegistryIssue(entry.code, parseRefusedMessage(entry, location, wording.consequence), { location });
  });
  return [...unreadable, ...refused];
}

/**
 * {@link notAdmittedIssues}, resolved through the validation framework's allow
 * filter and severity — for a verb that reports them beside no framework run.
 *
 * @param log - The registry's logs
 * @param wording - Where to locate them, and what their absence cost
 * @param validation - The project's `resources.validation` (`{}` when none)
 * @returns The findings left after the allow filter, each at its resolved severity
 */
export function notAdmittedFindings(
  log: NotAdmittedLog,
  wording: NotAdmittedWording,
  validation: ValidationConfig,
): ValidationIssue[] {
  return resolveFindings(notAdmittedIssues(log, wording), validation);
}

/**
 * The not-admitted files a `--collection` covers: those its own include and
 * exclude patterns match — the same `matchesCollection` the registry assigns
 * membership with, since a file never admitted has no membership of its own.
 *
 * @param log - The registry's logs
 * @param collection - The collection named, or `undefined` for the whole run
 * @returns The log narrowed to it
 */
export function notAdmittedInScope(log: NotAdmittedLog, collection: CollectionConfig | undefined): NotAdmittedLog {
  if (collection === undefined) return log;
  return {
    unreadable: log.unreadable.filter((entry) => matchesCollection(entry.filePath, collection)),
    parseRefused: log.parseRefused.filter((entry) => matchesCollection(entry.filePath, collection)),
  };
}

/**
 * How many files a verb counts in `examined` beside the admitted ones: every
 * one enumerated and not admitted, whatever severity its finding resolves to.
 *
 * @param log - The (scoped) logs
 * @returns Unreadable plus parse-refused files
 */
export function notAdmittedCount(log: NotAdmittedLog): number {
  return log.unreadable.length + log.parseRefused.length;
}
