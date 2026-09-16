/**
 * Evaluating the always-loaded context chain over a tree, so SQL can ask what
 * the harness loads where.
 *
 * 🚨 **This lens POPULATES. It is the only one that does, and that is the whole
 * reason lens evaluation had to become lazy.** Its relations cannot be derived
 * from the projection the query lane already holds, so it runs the real lane —
 * a second population, which is why `projection-lenses.ts` evaluates a lens only
 * when a statement names its relations. Why that is not a choice, and why the
 * second population is a store hit rather than a competitor for the resources
 * lane's entry: `docs/architecture/zones.md` §2, "The claude-context lens
 * POPULATES".
 */

import {
  buildClaudeContextPopulation,
  claudeContextRelations,
  type ClaudeContextRelations,
  type PopulationCache,
} from '@vibe-agent-toolkit/resources';

import { gitTrackerForProjectRoot } from '../commands/audit/distributed-tree.js';

import type { Logger } from './logger.js';
import { populationWiring } from './population-wiring.js';

/**
 * Populate the Claude-context lane and flatten its chains into the two
 * relations.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root. Rooted HERE and nowhere else: a
 *   chain is a property of a position in the tree, and a population rooted at a
 *   subdirectory computes one against a corpus whose ancestors are missing
 * @param options.logger - Where blob-stage refusals go (stderr, so a parseable
 *   document on stdout stays parseable)
 * @param options.cache - The run's projection store, or undefined to re-derive
 * @returns The rows, ready for `writeDerived`
 */
export async function evaluateClaudeContextLens(options: {
  root: string;
  logger: Logger;
  cache: PopulationCache | undefined;
}): Promise<ClaudeContextRelations> {
  const { root, logger, cache } = options;
  const gitTracker = await gitTrackerForProjectRoot(root);
  const projection = await buildClaudeContextPopulation({
    root,
    ...populationWiring(logger, gitTracker, cache, root),
  });
  return claudeContextRelations(projection);
}
