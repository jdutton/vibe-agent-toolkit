#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from resources' Zod schemas.
 *
 * Lives in dev-tools rather than packages/resources/scripts/ because this
 * repo's structure validation restricts /scripts directories to a short list
 * (see validate-repo-structure.ts) — every other package's generation
 * utilities live here instead. Invoked by resources' own `generate:schemas`
 * script via a relative tsx path, the same pattern resources already uses for
 * `build` (tsx ../dev-tools/src/tsc-clean-build.ts).
 *
 * The target list is exported: `test/emitted-schemas-drift.test.ts` reads the
 * committed `packages/resources/schemas/*.json` back and compares each to a
 * fresh render of the same list, so a Zod edit that forgets `git add` — or a
 * target added here and never generated — fails a unit test rather than
 * shipping a stale artifact. See `pin-emitted-schemas.ts`.
 *
 * The **thirteen table** schemas are not listed by hand: they come from
 * `PROJECTION_TABLES`, the single registry that also supplies `exportProjection`
 * its primary keys. This file used to enumerate fifteen schemas in one
 * undifferentiated list, which is how three non-tables came to sit
 * indistinguishably among thirteen tables — see below.
 */

import { PROJECTION_TABLES } from '../../resources/src/projection/table-registry.js';
import { OkfConceptFrontmatterSchema } from '../../resources/src/schemas/okf-concept.js';
import { ProjectConfigSchema } from '../../resources/src/schemas/project-config.js';
import {
  ClaudeContextChainRowSchema,
  ClaudeContextLoadRowSchema,
} from '../../resources/src/schemas/projection-claude-context.js';
import {
  EdgeResolutionRowSchema,
  EdgeRowSchema,
} from '../../resources/src/schemas/projection-edges.js';
import { LensEntryPointRowSchema } from '../../resources/src/schemas/projection-zones.js';

import { isEntrypoint, PROJECT_ROOT } from './common.js';
import { writeEmittedSchemas, type EmittedSchemaTarget } from './pin-emitted-schemas.js';

/** Where resources commits its artifacts, relative to the repo root. */
export const RESOURCES_SCHEMAS_DIR = `${PROJECT_ROOT}/packages/resources/schemas`;

/**
 * Row schemas that are **not** projection tables, and their schema filenames.
 *
 * `edges`, `edge_resolutions` and `lens_entry_points` are absent from
 * {@link PROJECTION_TABLES} on purpose — zones.md §2 places them in the
 * derived-per-lens column, so they are the output of evaluating a lens rather
 * than rows anything materialises. ⚠️ They ARE referenced under `projection/`
 * now: `derived-table-registry.ts` imports `EdgeRowSchema` and
 * `EdgeResolutionRowSchema` to declare the derived relations. This docstring
 * used to say nothing did.
 * They still have committed JSON Schemas, so they are still generated; the list
 * is separate so that "generated but not a table" is a visible, deliberate
 * category rather than three entries indistinguishable from the thirteen.
 *
 * Adding a schema here is therefore a claim: *this row shape is published but
 * no projection table holds it.* Anything that IS a table belongs in the
 * registry, where the compiler checks it against `Projection`.
 */
const NON_TABLE_ROW_SCHEMAS: readonly EmittedSchemaTarget[] = [
  { name: 'projection-edges', schema: EdgeRowSchema },
  { name: 'projection-edge-resolutions', schema: EdgeResolutionRowSchema },
  { name: 'projection-lens-entry-points', schema: LensEntryPointRowSchema },
  { name: 'projection-claude-context-chains', schema: ClaudeContextChainRowSchema },
  { name: 'projection-claude-context-loads', schema: ClaudeContextLoadRowSchema },
];

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
const EXTERNAL_FORMAT_SCHEMAS: readonly EmittedSchemaTarget[] = [
  { name: 'okf-concept-frontmatter', schema: OkfConceptFrontmatterSchema },
];

/**
 * The adopter-facing config file, `vibe-agent-toolkit.config.yaml`.
 *
 * Emitted so an editor or a CI step can validate an adopter's config against
 * the same Zod that `loadConfig` runs — and so a key the runtime accepts can
 * never be one the published schema refuses, or the reverse.
 */
const CONFIG_SCHEMAS: readonly EmittedSchemaTarget[] = [
  { name: 'project-config', schema: ProjectConfigSchema },
];

/** Every JSON Schema `packages/resources` ships under `schemas/`. */
export const RESOURCES_SCHEMA_TARGETS: readonly EmittedSchemaTarget[] = [
  ...Object.values(PROJECTION_TABLES).map((spec) => ({
    name: `projection-${spec.name.replaceAll('_', '-')}`,
    schema: spec.schema,
  })),
  ...NON_TABLE_ROW_SCHEMAS,
  ...EXTERNAL_FORMAT_SCHEMAS,
  ...CONFIG_SCHEMAS,
];

if (isEntrypoint(import.meta.url)) {
  console.log('🔨 Generating resources JSON Schemas from Zod...\n');
  for (const path of writeEmittedSchemas(RESOURCES_SCHEMAS_DIR, RESOURCES_SCHEMA_TARGETS)) {
    console.log(`✅ Generated: ${path}`);
  }
  console.log('\n✨ Resources JSON Schema generation complete!');
}
