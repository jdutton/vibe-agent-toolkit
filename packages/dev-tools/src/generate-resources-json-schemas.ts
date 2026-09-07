#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from resources' projection Zod schemas.
 *
 * Lives in dev-tools rather than packages/resources/scripts/ because this
 * repo's structure validation restricts /scripts directories to dev-tools,
 * schema, and agent-skills (see validate-repo-structure.ts) — every
 * other package's generation utilities live here instead. Invoked by
 * resources' own `generate:schemas` script via a relative tsx path, the same
 * pattern resources already uses for `build` (tsx ../dev-tools/src/tsc-clean-build.ts).
 *
 * The **twelve table** schemas are not listed here: they come from
 * `PROJECTION_TABLES`, the single registry that also supplies `exportProjection`
 * its primary keys. This file used to enumerate fifteen schemas in one
 * undifferentiated list, which is how three non-tables came to sit
 * indistinguishably among twelve tables — see below.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import { PROJECTION_TABLES } from '../../resources/src/projection/table-registry.js';
import { OkfConceptFrontmatterSchema } from '../../resources/src/schemas/okf-concept.js';
import {
  EdgeResolutionRowSchema,
  EdgeRowSchema,
} from '../../resources/src/schemas/projection-edges.js';
import { LensEntryPointRowSchema } from '../../resources/src/schemas/projection-zones.js';

import { createJsonSchemaWriter } from './json-schema-writer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = safePath.join(__dirname, '..', '..', 'resources', 'schemas');

const writeJsonSchema = createJsonSchemaWriter(SCHEMAS_DIR);

/**
 * Row schemas that are **not** projection tables, and their schema filenames.
 *
 * `edges`, `edge_resolutions` and `lens_entry_points` are absent from
 * {@link PROJECTION_TABLES} on purpose — zones.md §3.2 places them in the
 * derived-per-lens column, so they are the output of evaluating a lens rather
 * than rows anything populates, and nothing under `projection/` references them.
 * They still have committed JSON Schemas, so they are still generated; the list
 * is separate so that "generated but not a table" is a visible, deliberate
 * category rather than three entries indistinguishable from the twelve.
 *
 * Adding a schema here is therefore a claim: *this row shape is published but
 * no projection table holds it.* Anything that IS a table belongs in the
 * registry, where the compiler checks it against `Projection`.
 */
const NON_TABLE_ROW_SCHEMAS = [
  ['projection-edges', EdgeRowSchema],
  ['projection-edge-resolutions', EdgeResolutionRowSchema],
  ['projection-lens-entry-points', LensEntryPointRowSchema],
] as const;

console.log('🔨 Generating projection JSON Schemas from Zod...\n');

for (const spec of Object.values(PROJECTION_TABLES)) {
  writeJsonSchema(`projection-${spec.name.replaceAll('_', '-')}`, spec.schema);
}

for (const [name, schema] of NON_TABLE_ROW_SCHEMAS) {
  writeJsonSchema(name, schema);
}

/**
 * Schemas that describe an EXTERNAL format rather than one of VAT's own rows.
 *
 * `okf-concept-frontmatter` is the OKF v0.2 concept-document shape. It is
 * generated here alongside the projection schemas because the mechanism is the
 * same — Zod is the single source of truth, the `.json` sibling is committed —
 * but it belongs to a different category, and the categories must stay visible:
 * a projection schema is `.strict()` because VAT writes those rows, and this one
 * is `.passthrough()` because an adopter writes it and OKF §4.1 forbids
 * rejecting unknown keys. Filing it with the rows would invite someone to
 * "tighten it for consistency".
 *
 * It ships as a committed artifact so an adopter can point a collection's
 * `frontmatterSchema` at it through `resolveAssetReference` — which is also why
 * tracking a future OKF revision is a file swap rather than a code change.
 */
const EXTERNAL_FORMAT_SCHEMAS = [
  ['okf-concept-frontmatter', OkfConceptFrontmatterSchema],
] as const;

for (const [name, schema] of EXTERNAL_FORMAT_SCHEMAS) {
  writeJsonSchema(name, schema);
}

console.log('\n✨ Projection JSON Schema generation complete!');
