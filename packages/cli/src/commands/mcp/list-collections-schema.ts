/**
 * The document `vat mcp list-collections` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the known-package registries read — one, the built-in list.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat mcp list-collections`, and the remedy when it is zero. */
export const MCP_LIST_COLLECTIONS_EXAMINED: ExaminedDeclaration = {
  unit: 'package registries read',
  whenZero: 'No package registry was read, which is a defect in VAT — report it with the output of vat mcp list-collections --debug.',
};

const McpListCollectionsDataSchema = z.object({
  packages: z.array(z.object({ name: z.string(), description: z.string() }).strict()),
}).strict();

export type McpListCollectionsData = z.infer<typeof McpListCollectionsDataSchema>;

/** The document this command publishes. */
export const MCP_LIST_COLLECTIONS_REPORT_SCHEMA = reportSchema(McpListCollectionsDataSchema, FindingSchema);

export type McpListCollectionsReport = Report<McpListCollectionsData>;
