/**
 * The document `vat inventory` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `data.inventory` is the structural inventory as agent-skills publishes it —
 * the full inventory, or its shallow projection under `projection: shallow`
 * (`--shallow`). A manifest that does not parse stays in the inventory's own
 * `parseErrors[]`: inventory runs no detectors, and judging the subject is
 * `vat audit`'s job. A path the OS refused was not inventoried, which is a fact
 * about the run, so each is also a `SCAN_PATH_UNREADABLE` finding.
 */

import { InventorySerializedSchema, type InventorySerialized } from '@vibe-agent-toolkit/agent-skills';
import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../utils/run-integrity.js';

/** What `examined` counts for `vat inventory`, and the remedy when it is zero. */
export const INVENTORY_EXAMINED: ExaminedDeclaration = {
  unit: 'components inventoried',
  whenZero: 'Nothing was inventoried — point the command at a plugin, marketplace or install directory, or a SKILL.md.',
};

const InventoryDataSchema = z.object({
  inventory: InventorySerializedSchema,
}).strict();

/** The command's `data`, typed by the inventory model agent-skills owns. */
export interface InventoryData {
  readonly inventory: InventorySerialized;
}

/** The document this command publishes. */
export const INVENTORY_REPORT_SCHEMA = reportSchema(InventoryDataSchema, FindingSchema);

export type InventoryReport = Report<InventoryData>;
