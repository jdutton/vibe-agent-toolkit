#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from Zod schemas
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import { createJsonSchemaWriter } from '../../dev-tools/src/json-schema-writer.js';
import {
  AgentSkillFrontmatterSchema,
  VATAgentSkillFrontmatterSchema
} from '../src/schemas/agent-skill-frontmatter.js';
import { MarketplaceManifestSchema } from '../src/schemas/marketplace-manifest.js';
import { FrictionReportSchema } from '../src/skill-test/friction-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = safePath.join(__dirname, '..', 'schemas');

const writeJsonSchema = createJsonSchemaWriter(SCHEMAS_DIR);

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
writeJsonSchema('friction-report', FrictionReportSchema);

console.log('\n✨ JSON Schema generation complete!');
