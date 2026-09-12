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
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { JSON_SCHEMA_TARGETS } from '../src/json-schema-targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMAS_DIR = safePath.join(__dirname, '..', 'schemas');

// Ensure schemas directory exists
mkdirSyncReal(SCHEMAS_DIR, { recursive: true });

console.log('🔨 Generating JSON Schemas from Zod...\n');

for (const { name, schema } of JSON_SCHEMA_TARGETS) {
  const jsonSchema = zodToJsonSchema(schema, name);
  const path = safePath.join(SCHEMAS_DIR, `${name}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is constructed from trusted schema name
  writeFileSync(path, JSON.stringify(jsonSchema, null, 2) + '\n');
  console.log(`✅ Generated: ${name}.json`);
}

console.log('\n✨ JSON Schema generation complete!');
