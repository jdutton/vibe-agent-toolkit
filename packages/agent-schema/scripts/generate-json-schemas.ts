#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from Zod schemas
 *
 * Converts Zod schemas to JSON Schema format for use by external tools,
 * documentation generators, and other non-TypeScript consumers.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Import all Zod schemas
import { AgentManifestSchema } from '../src/agent-manifest.js';
import { AgentInterfaceSchema } from '../src/interface.js';
import { LLMConfigSchema } from '../src/llm.js';
import { AgentMetadataSchema } from '../src/metadata.js';
import { VatPackageMetadataSchema } from '../src/package-metadata.js';
import { ResourceRegistrySchema } from '../src/resource-registry.js';
import { ToolSchema } from '../src/tool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMAS_DIR = join(__dirname, '..', 'schemas');

// Ensure schemas directory exists
mkdirSyncReal(SCHEMAS_DIR, { recursive: true });

/**
 * Write JSON Schema to file
 */
function writeJsonSchema(name: string, schema: Parameters<typeof zodToJsonSchema>[0]): void {
  const jsonSchema = zodToJsonSchema(schema, name);
  const path = join(SCHEMAS_DIR, `${name}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is constructed from trusted schema name
  writeFileSync(path, JSON.stringify(jsonSchema, null, 2) + '\n');
  console.log(`✅ Generated: ${name}.json`);
}

// Generate all JSON Schemas
console.log('🔨 Generating JSON Schemas from Zod...\n');

writeJsonSchema('agent-manifest', AgentManifestSchema);
writeJsonSchema('agent-metadata', AgentMetadataSchema);
writeJsonSchema('llm-config', LLMConfigSchema);
writeJsonSchema('agent-interface', AgentInterfaceSchema);
writeJsonSchema('tool', ToolSchema);
writeJsonSchema('resource-registry', ResourceRegistrySchema);
writeJsonSchema('vat-package-metadata', VatPackageMetadataSchema);

console.log('\n✨ JSON Schema generation complete!');
