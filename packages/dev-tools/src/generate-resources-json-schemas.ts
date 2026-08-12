#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from resources' projection Zod schemas.
 *
 * Lives in dev-tools rather than packages/resources/scripts/ because this
 * repo's structure validation restricts /scripts directories to dev-tools,
 * agent-schema, and agent-skills (see validate-repo-structure.ts) — every
 * other package's generation utilities live here instead. Invoked by
 * resources' own `generate:schemas` script via a relative tsx path, the same
 * pattern resources already uses for `build` (tsx ../dev-tools/src/tsc-clean-build.ts).
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import {
  BlobConditionRowSchema,
  BlobLinkRowSchema,
  BlobRowSchema,
  BlobSectionRowSchema,
} from '../../resources/src/schemas/projection-blobs.js';
import {
  EdgeRowSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
  ResourceTagRowSchema,
  ResourceZoneRowSchema,
  RootRowSchema,
} from '../../resources/src/schemas/projection-resources.js';

import { createJsonSchemaWriter } from './json-schema-writer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = safePath.join(__dirname, '..', '..', 'resources', 'schemas');

const writeJsonSchema = createJsonSchemaWriter(SCHEMAS_DIR);

console.log('🔨 Generating projection JSON Schemas from Zod...\n');

writeJsonSchema('projection-blobs', BlobRowSchema);
writeJsonSchema('projection-blob-links', BlobLinkRowSchema);
writeJsonSchema('projection-blob-sections', BlobSectionRowSchema);
writeJsonSchema('projection-blob-conditions', BlobConditionRowSchema);
writeJsonSchema('projection-roots', RootRowSchema);
writeJsonSchema('projection-resources', ResourceRowSchema);
writeJsonSchema('projection-resource-realizations', ResourceRealizationRowSchema);
writeJsonSchema('projection-resource-zones', ResourceZoneRowSchema);
writeJsonSchema('projection-resource-tags', ResourceTagRowSchema);
writeJsonSchema('projection-edges', EdgeRowSchema);

console.log('\n✨ Projection JSON Schema generation complete!');
