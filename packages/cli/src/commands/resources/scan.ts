/**
 * Resources scan command - discover markdown resources
 */

import type { CrawlSourceKind } from '@vibe-agent-toolkit/resources';
import { buildReport } from '@vibe-agent-toolkit/schema';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import { relativizePathEntries } from '../../utils/relativize-paths.js';
import { assertDeclaredCollection, loadResourcesWithConfig, type ResourceCrawlLane } from '../../utils/resource-loader.js';

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
  checksum: string;
}

export interface ScanPayloadInput {
  resources: readonly ScanResource[];
  /** The stated root: the ONE base every reported `path` is relative to. */
  root: string;
  /**
   * Which enumerator produced these resources.
   *
   * Provenance, and it sits beside `root` because it qualifies the file list the
   * same way: two scans of one tree that report different populations are only
   * interpretable if each says which lane enumerated it. Derived from the load
   * that ran, never re-read from the environment — the environment records what
   * was asked for, which is not the same claim.
   */
  lane: ResourceCrawlLane;
  /**
   * Which enumerator the projection lane used, or `null` for the walk.
   *
   * `lane` alone cannot qualify a projection population: the lane has two
   * enumerators and reports the same word for both, so an A/B varying only
   * `VAT_EXTENT_SOURCE` produces two documents that agree on every field. This
   * is the field that makes the arms distinguishable, which is what makes the
   * comparison mean anything.
   */
  extentSource: CrawlSourceKind | null;
  durationMs: number;
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
 * population facet reads, beside `data.files`. A scan has no findings of its
 * own; a scan of nothing gets the writer's run-integrity refusal.
 */
export function buildScanReport(input: ScanPayloadInput): ResourcesScanReport {
  const { resources, root, lane, extentSource, durationMs, collections, verbose } = input;

  const data: ResourcesScanData = {
    // Stated once, and the only absolute path in the document.
    root,
    lane,
    // Always present, `null` included: a field that vanishes for the walk is
    // indistinguishable from a build too old to report it, which is the same
    // absence-vs-old-build ambiguity the two lane markers exist to avoid.
    extentSource,
    collections,
  };
  if (verbose) {
    data.files = relativizePathEntries(
      resources.map((resource) => ({
        path: resource.filePath,
        links: resource.links.length,
        anchors: countHeadings(resource.headings),
        checksum: resource.checksum,
      })),
      root,
    );
  }

  // `vat resources scan` offers no `--strict`, and reports no finding of its own.
  return buildReport({ examined: resources.length, findings: [], data, gate: { strict: false }, durationMs });
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

    // Load resources with config support
    const { registry, config, lane, extentSource } = await loadResourcesWithConfig(pathArg, projectRoot, logger);
    assertDeclaredCollection(config, options.collection);

    // Get all resources (filtered by collection if specified)
    const { collection } = options;
    const resources = collection === undefined
      ? registry.getAllResources()
      : registry.getAllResources().filter((r) => r.collections?.includes(collection) ?? false);

    const report = buildScanReport({
      resources,
      root: projectRoot,
      lane,
      extentSource,
      durationMs: Date.now() - startTime,
      collections: collectionCounts(registry.getCollectionStats(), collection),
      verbose: options.verbose ?? false,
    });
    endWithReport('resources scan', report, format);
  } catch (error) {
    endWithRefusal('resources scan', refusalCodeOf(error), error, format, { strict: false }, NOTHING_FINISHED);
  }
}
