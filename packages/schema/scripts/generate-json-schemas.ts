#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from Zod schemas
 *
 * Converts Zod schemas to JSON Schema format for use by external tools,
 * documentation generators, and other non-TypeScript consumers.
 *
 * The set of schemas generated lives in `src/json-schema-targets.ts` rather than
 * here, because `test/emitted-json-schemas.test.ts` asserts on what this script
 * wrote and the two must not be able to disagree about what "all of them" means.
 * The writer is the shared one every package's `generate:schemas` uses, so the
 * three packages' artifacts are rendered identically.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import { writeEmittedSchemas } from '../../dev-tools/src/pin-emitted-schemas.js';
import { JSON_SCHEMA_TARGETS } from '../src/json-schema-targets.js';

const SCHEMAS_DIR = safePath.join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

console.log('🔨 Generating JSON Schemas from Zod...\n');

for (const path of writeEmittedSchemas(SCHEMAS_DIR, JSON_SCHEMA_TARGETS)) {
  console.log(`✅ Generated: ${path}`);
}

console.log('\n✨ JSON Schema generation complete!');
