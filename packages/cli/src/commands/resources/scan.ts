/**
 * Resources scan command - discover markdown resources
 */

import type { CrawlSourceKind } from '@vibe-agent-toolkit/resources';

import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger } from '../../utils/logger.js';
import { writeJsonOutput, writeYamlOutput } from '../../utils/output.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import { relativizePathEntries } from '../../utils/relativize-paths.js';
import { loadResourcesWithConfig, type ResourceCrawlLane } from '../../utils/resource-loader.js';

import { handleCommandError } from './command-helpers.js';

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
  collections: Record<string, { resourceCount: number }> | undefined;
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
 * Build the scan payload.
 *
 * Pure: no file system, no clock, no `process.exit`. The registry keeps
 * absolute `filePath`s because that is the identity it keys on; re-basing onto
 * the stated root happens exactly once, here, at the document boundary — the
 * same contract `vat audit` follows. A payload of `$HOME`-absolute paths names
 * the machine it ran on and cannot be diffed across two checkouts.
 */
export function buildScanOutputData(input: ScanPayloadInput): Record<string, unknown> {
  const { resources, root, lane, extentSource, durationMs, collections, verbose } = input;

  const files = resources.map((resource) => ({
    path: resource.filePath,
    links: resource.links.length,
    anchors: countHeadings(resource.headings),
    checksum: resource.checksum,
  }));

  return {
    status: 'success',
    // Stated once, and the only absolute path in the document.
    root,
    lane,
    // Always present, `null` included: a field that vanishes for the walk is
    // indistinguishable from a build too old to report it, which is the same
    // absence-vs-old-build ambiguity the two lane markers exist to avoid.
    extentSource,
    filesScanned: resources.length,
    linksFound: resources.reduce((sum, r) => sum + r.links.length, 0),
    anchorsFound: files.reduce((sum, f) => sum + f.anchors, 0),
    durationSecs: formatDurationSecs(durationMs),
    ...(collections ? { collections } : {}),
    ...(verbose ? { files: relativizePathEntries(files, root) } : {}),
  };
}

export async function scanCommand(
  pathArg: string | undefined,
  options: ScanOptions
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
    // Resolve projectRoot at the CLI boundary (spec §5/§7 — loud-cwd policy).
    const projectRoot = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);

    // Load resources with config support
    const { registry, lane, extentSource } = await loadResourcesWithConfig(pathArg, projectRoot, logger);

    // Get all resources (filtered by collection if specified)
    let allResources = registry.getAllResources();
    if (options.collection) {
      const { collection } = options;
      allResources = allResources.filter(r => {
        return collection ? r.collections?.includes(collection) ?? false : false;
      });
    }

    // Build collection stats (filtered or all)
    let collectionsOutput: Record<string, { resourceCount: number }> | undefined;
    if (options.collection) {
      // When filtering by collection, only show that collection
      collectionsOutput = { [options.collection]: { resourceCount: allResources.length } };
    } else {
      // Show all collections
      const collectionStats = registry.getCollectionStats();
      collectionsOutput = collectionStats
        ? Object.fromEntries(
            Object.entries(collectionStats.collections).map(([id, stat]) => [
              id,
              { resourceCount: stat.resourceCount },
            ])
          )
        : undefined;
    }

    const payload = buildScanOutputData({
      resources: allResources,
      root: projectRoot,
      lane,
      extentSource,
      durationMs: Date.now() - startTime,
      collections: collectionsOutput,
      verbose: options.verbose ?? false,
    });
    if (options.format === 'json') {
      writeJsonOutput(payload);
    } else {
      writeYamlOutput(payload);
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Scan');
  }
}
