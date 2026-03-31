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
  AgentSkillFrontmatterSchema,
  VATAgentSkillFrontmatterSchema
} from '../src/schemas/agent-skill-frontmatter.js';
import { MarketplaceManifestSchema } from '../src/schemas/marketplace-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, '..', 'schemas');

mkdirSyncReal(SCHEMAS_DIR, { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeJsonSchema(name: string, schema: ZodType<any, ZodTypeDef, any>, postProcess?: (s: Record<string, unknown>) => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonSchema = zodToJsonSchema(schema, name) as Record<string, any>;
  if (postProcess) postProcess(jsonSchema);
  const path = join(SCHEMAS_DIR, `${name}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(path, JSON.stringify(jsonSchema, null, 2) + '\n');
  console.log(`✅ Generated: ${name}.json`);
}

/**
 * Post-process marketplace-manifest schema to add path traversal constraint.
 *
 * zodToJsonSchema cannot encode Zod's .refine() calls, so we manually inject
 * a JSON Schema `not: { pattern }` constraint onto the string source option.
 *
 * Pattern "\.\." rejects any string containing literal ".." (directory traversal).
 * This catches "../plugins/foo" and "./foo/../bar" — both rejected by Claude Code.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addPathTraversalConstraint(schema: Record<string, any>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defs: Record<string, any> = schema['definitions'] ?? schema['$defs'] ?? {};
  const pluginEntry = defs['marketplace-manifest']?.['properties']?.['plugins']?.['items'] as Record<string, unknown> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceAnyOf = (pluginEntry?.['properties'] as Record<string, any> | undefined)?.['source']?.['anyOf'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(sourceAnyOf)) return;

  const strEntry = sourceAnyOf.find((o) => o['type'] === 'string');
  if (strEntry) {
    // \.\. in ECMAScript regex = two literal dots = matches any ".." occurrence.
    // In JSON the pattern string "\\.\\.": JSON parses \\ as \ giving regex string "\.\.".
    // Build pattern string programmatically: backslash + dot + backslash + dot
    const pathTraversalPattern = ['\\', '.', '\\', '.'].join('');
    strEntry['not'] = { pattern: pathTraversalPattern };
  }
}

console.log('🔨 Generating JSON Schemas from Zod...\n');

writeJsonSchema('skill-frontmatter', AgentSkillFrontmatterSchema);
writeJsonSchema('vat-skill-frontmatter', VATAgentSkillFrontmatterSchema);
writeJsonSchema('marketplace-manifest', MarketplaceManifestSchema, addPathTraversalConstraint);

console.log('\n✨ JSON Schema generation complete!');
