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
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import {
  BlobConditionRowSchema,
  BlobReferenceRowSchema,
  BlobRowSchema,
  BlobSectionRowSchema,
} from '../../resources/src/schemas/projection-blobs.js';
import {
  EdgeResolutionRowSchema,
  EdgeRowSchema,
} from '../../resources/src/schemas/projection-edges.js';
import {
  RealizationConditionRowSchema,
  ResourceExtentRowSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
  ResourceTagRowSchema,
  RootRowSchema,
} from '../../resources/src/schemas/projection-resources.js';
import {
  LensEntryPointRowSchema,
  ResolutionContextRowSchema,
  ZoneProvenanceRowSchema,
} from '../../resources/src/schemas/projection-zones.js';

import { createJsonSchemaWriter } from './json-schema-writer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = safePath.join(__dirname, '..', '..', 'resources', 'schemas');

const writeJsonSchema = createJsonSchemaWriter(SCHEMAS_DIR);

console.log('🔨 Generating projection JSON Schemas from Zod...\n');

writeJsonSchema('projection-blobs', BlobRowSchema);
writeJsonSchema('projection-blob-references', BlobReferenceRowSchema);
writeJsonSchema('projection-blob-sections', BlobSectionRowSchema);
writeJsonSchema('projection-blob-conditions', BlobConditionRowSchema);
writeJsonSchema('projection-roots', RootRowSchema);
writeJsonSchema('projection-resources', ResourceRowSchema);
writeJsonSchema('projection-resource-realizations', ResourceRealizationRowSchema);
writeJsonSchema('projection-resource-extents', ResourceExtentRowSchema);
writeJsonSchema('projection-resource-tags', ResourceTagRowSchema);
writeJsonSchema('projection-realization-conditions', RealizationConditionRowSchema);
writeJsonSchema('projection-resolution-contexts', ResolutionContextRowSchema);
writeJsonSchema('projection-lens-entry-points', LensEntryPointRowSchema);
writeJsonSchema('projection-zone-provenance', ZoneProvenanceRowSchema);
writeJsonSchema('projection-edges', EdgeRowSchema);
writeJsonSchema('projection-edge-resolutions', EdgeResolutionRowSchema);

console.log('\n✨ Projection JSON Schema generation complete!');
