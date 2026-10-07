/**
 * MCP list-collections command - lists available agent collections
 */

import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';

import { listKnownPackages } from './collections.js';
import type { McpListCollectionsReport } from './list-collections-schema.js';

export interface ListCollectionsOptions {
  debug?: boolean;
}

/** `vat mcp list-collections` has no `--strict` and reports no finding: the gate is fixed. */
const GATE: Gate = { strict: false };

/** The one known-package registry read: the built-in list. */
const REGISTRIES_READ = 1;

/**
 * List available MCP agent collections
 */
export function listCollectionsCommand(
  options: ListCollectionsOptions
): void {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let report: McpListCollectionsReport;
  try {
    const packages = listKnownPackages().map((p) => ({ name: p.name, description: p.description }));

    report = buildReport({
      examined: REGISTRIES_READ,
      findings: [],
      data: { packages },
      gate: GATE,
      durationMs: Date.now() - startTime,
    });

    logger.info(`\nAvailable MCP agent packages:\n`);
    for (const pkg of packages) {
      logger.info(`  ${pkg.name}`);
      logger.info(`    ${pkg.description}\n`);
    }

    logger.info(`Usage:`);
    logger.info(`  vat mcp serve <package>                 # Start MCP server`);
    logger.info(`  vat mcp serve <package> --print-config  # Show Claude Desktop config\n`);

    logger.info(`Examples:`);
    logger.info(`  vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents`);
    logger.info(`  vat mcp serve ./packages/vat-example-cat-agents  # Local development\n`);
  } catch (error) {
    return endWithRefusal('mcp list-collections', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }
  endWithReport('mcp list-collections', report, 'yaml');
}
