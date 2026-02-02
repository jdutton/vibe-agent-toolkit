#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from Zod schemas
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { type ZodType, type ZodTypeDef } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  ClaudeSkillFrontmatterSchema,
  VATClaudeSkillFrontmatterSchema
} from '../src/schemas/claude-skill-frontmatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, '..', 'schemas');

mkdirSyncReal(SCHEMAS_DIR, { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeJsonSchema(name: string, schema: ZodType<any, ZodTypeDef, any>): void {
  const jsonSchema = zodToJsonSchema(schema, name);
  const path = join(SCHEMAS_DIR, `${name}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(path, JSON.stringify(jsonSchema, null, 2) + '\n');
  console.log(`✅ Generated: ${name}.json`);
}

console.log('🔨 Generating JSON Schemas from Zod...\n');

writeJsonSchema('skill-frontmatter', ClaudeSkillFrontmatterSchema);
writeJsonSchema('vat-skill-frontmatter', VATClaudeSkillFrontmatterSchema);

console.log('\n✨ JSON Schema generation complete!');
