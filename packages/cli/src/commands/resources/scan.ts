/**
 * Resources scan command - discover markdown resources
 */

import { type ContentKey, type CrawlSourceKind, notAdmittedCount, notAdmittedFindings, notAdmittedInScope } from '@vibe-agent-toolkit/resources';
import { buildReport, toFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { reportFindings } from '../../utils/issue-rendering.js';
import { createLogger } from '../../utils/logger.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import { relativizePathEntries } from '../../utils/relativize-paths.js';
import { assertDeclaredCollection, loadResourcesWithConfig, NO_HOME_SETTLED_LISTENER, withRunContext } from '../../utils/resource-loader.js';

import type { ResourcesScanData, ResourcesScanReport } from './scan-schema.js';

interface ScanOptions {
  debug?: boolean;
  verbose?: boolean;
  collection?: string;
  /** `yaml` (default) or `json`. Same document either way. */
  format?: string;
}

/** A heading node, which may nest further headings beneath it. */
type HeadingWithChildren = { children?: HeadingWithChildren[] | undefined };

/**
 * The slice of a registry resource this payload reports on.
 *
 * Structural rather than the full `ResourceMetadata` so the builder can be
 * exercised with a literal, which is what keeps the payload's shape — field
 * names included — under unit test rather than only under a CLI spawn.
 */
interface ScanResource {
  filePath: string;
  links: readonly unknown[];
  headings: HeadingWithChildren[];
  contentKey: ContentKey;
}

export interface ScanPayloadInput {
  resources: readonly ScanResource[];
  /** The stated root: the ONE base every reported `path` is relative to. */
  root: string;
  /**
   * Which enumerator produced these resources: git or the filesystem.
   *
   * Provenance, and it sits beside `root` because it qualifies the file list the
   * same way: an A/B varying only `VAT_EXTENT_SOURCE` would otherwise produce two
   * documents that agree on every field. Derived from the crawl that ran, never
   * re-read from the environment: the environment records what was asked for,
   * which is not the same claim.
   */
  extentSource: CrawlSourceKind;
  durationMs: number;
  /**
   * Every file the crawl enumerated and did not admit — unreadable, or its parse
   * refused — in scope: how many (counted in `examined` whatever their findings
   * resolve to), and their findings at their configured severity. Required: a
   * scan that omits them reports the survivors as the whole population.
   */
  notAdmitted: { readonly count: number; readonly findings: readonly ValidationIssue[] };
  /** Resources per collection; `{}` when the project configures none. */
  collections: Record<string, { resourceCount: number }>;
  verbose: boolean;
}

/** Total headings in a tree, counting every nested level. */
function countHeadings(headings: readonly HeadingWithChildren[]): number {
  let count = headings.length;
  for (const heading of headings) {
    if (heading.children) {
      count += countHeadings(heading.children);
    }
  }
  return count;
}

/**
 * Build the scan report.
 *
 * Pure: no file system, no clock, no `process.exit`. The registry keeps
 * absolute `filePath`s because that is the identity it keys on; re-basing onto
 * the stated root happens exactly once, here, at the document boundary — the
 * same contract `vat audit` follows. A payload of `$HOME`-absolute paths names
 * the machine it ran on and cannot be diffed across two checkouts.
 *
 * `examined` is the number of files scanned — the denominator the lab's
 * population facet reads, beside `data.files`: the admitted files plus every
 * one the crawl enumerated and did not admit. Those are the scan's only
 * findings, one each at its configured severity (an error by default, so exit
 * 1); a scan of nothing gets the writer's run-integrity refusal.
 */
export function buildScanReport(input: ScanPayloadInput): ResourcesScanReport {
  const { resources, root, extentSource, durationMs, collections, verbose, notAdmitted } = input;

  const data: ResourcesScanData = {
    // Stated once, and the only absolute path in the document.
    root,
    extentSource,
    collections,
  };
  if (verbose) {
    data.files = relativizePathEntries(
      resources.map((resource) => ({
        path: resource.filePath,
        links: resource.links.length,
        anchors: countHeadings(resource.headings),
        contentKey: resource.contentKey,
      })),
      root,
    );
  }

  // `vat resources scan` offers no `--strict`; its only findings are the files it could not admit.
  return buildReport({
    examined: resources.length + notAdmitted.count,
    findings: toFindings([...notAdmitted.findings]),
    data,
    gate: { strict: false },
    durationMs,
  });
}

/**
 * Resources per collection, narrowed to the `--collection` one when filtering —
 * the same rule `resources validate` follows: the registry's stats list only
 * collections with members, so a declared collection that matched nothing is
 * absent rather than listed at 0.
 */
function collectionCounts(
  collectionStats: { collections: Record<string, { resourceCount: number }> } | undefined,
  collection: string | undefined,
): Record<string, { resourceCount: number }> {
  const counts = Object.entries(collectionStats?.collections ?? {})
    .filter(([id]) => collection === undefined || id === collection)
    .map(([id, stat]) => [id, { resourceCount: stat.resourceCount }] as const);
  return Object.fromEntries(counts);
}

/** Test seam: the per-collection counts `--collection` narrows. */
export const __internal = { collectionCounts };

export async function scanCommand(
  pathArg: string | undefined,
  options: ScanOptions
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();
  // The two formats this verb offers (Commander refuses any other).
  const format = options.format === 'json' ? 'json' : 'yaml';

  try {
    // Resolve projectRoot at the CLI boundary (spec §5/§7 — loud-cwd policy).
    const projectRoot = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);

    // One run around the whole scan: the registry is the run's view, so nothing
    // of it is read after the run closes and releases its contents and parses.
    const report = await withRunContext({ projectionStore: 'on-demand', root: projectRoot, outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, async (run) => {
      const { registry, config, population } = await loadResourcesWithConfig(pathArg, run, logger);
      assertDeclaredCollection(config, options.collection);

      // Get all resources (filtered by collection if specified)
      const { collection } = options;
      const resources = collection === undefined
        ? registry.getAllResources()
        : registry.getAllResources().filter((r) => r.collections?.includes(collection) ?? false);
      // Scoped to `--collection` by the collection's own patterns, as `resources
      // validate` scopes them, and resolved through `resources.validation`.
      const notAdmittedLog = notAdmittedInScope(
        registry.getNotAdmitted(),
        collection === undefined ? undefined : config?.resources?.collections?.[collection],
      );
      const notAdmitted = {
        count: notAdmittedCount(notAdmittedLog),
        findings: notAdmittedFindings(
          notAdmittedLog,
          { locationRoot: projectRoot, consequence: 'it is in no collection count in this report' },
          config?.resources?.validation ?? {},
        ),
      };
      reportFindings(notAdmitted.findings, { verbose: true, write: logger.warn });

      return buildScanReport({
        notAdmitted,
        resources,
        root: projectRoot,
        extentSource: population.extentSource,
        durationMs: Date.now() - startTime,
        collections: collectionCounts(registry.getCollectionStats(), collection),
        verbose: options.verbose ?? false,
      });
    });
    endWithReport('resources scan', report, format);
  } catch (error) {
    endWithRefusal('resources scan', refusalCodeOf(error), error, format, { strict: false }, NOTHING_FINISHED);
  }
}
