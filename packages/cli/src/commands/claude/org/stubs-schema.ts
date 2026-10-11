/**
 * The document a not-implemented `claude org` leaf publishes, apart from the
 * command.
 *
 * A sibling module because the published-shape registry imports it and the
 * stubs import the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * A stub only ever publishes the envelope's error branch — `NOT_IMPLEMENTED`,
 * nothing examined, no data — so `data` is `null` on every branch.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for a stub (always 0: it refuses before any work), and the remedy. */
export const ORG_NOT_IMPLEMENTED_EXAMINED: ExaminedDeclaration = {
  unit: 'Admin API writes',
  whenZero: 'This command is not implemented. Use the Anthropic Console or call the Admin API directly.',
};

/** A stub has no data: it did nothing. */
const OrgNotImplementedDataSchema = z.null();

/** The document every not-implemented `claude org` leaf publishes. */
export const ORG_NOT_IMPLEMENTED_REPORT_SCHEMA = reportSchema(OrgNotImplementedDataSchema, FindingSchema);
