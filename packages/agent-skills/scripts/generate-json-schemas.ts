#!/usr/bin/env tsx
/**
 * Generate JSON Schema files from Zod schemas.
 *
 * The target list is exported: `packages/dev-tools/test/emitted-schemas-drift.test.ts`
 * reads each committed `schemas/*.json` back and compares it to a fresh render
 * of the same list, so a Zod edit that forgets `git add` fails a unit test
 * rather than shipping a stale artifact. See `dev-tools/src/pin-emitted-schemas.ts`.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { isEntrypoint } from '@vibe-agent-toolkit/utils/process';

import { writeEmittedSchemas, type EmittedSchemaTarget } from '../../dev-tools/src/pin-emitted-schemas.js';
import {
  AgentSkillFrontmatterSchema,
  VATAgentSkillFrontmatterSchema
} from '../src/schemas/agent-skill-frontmatter.js';
import { MarketplaceManifestSchema } from '../src/schemas/marketplace-manifest.js';
import { FrictionReportSchema } from '../src/skill-test/friction-schema.js';

/** Where this package commits its artifacts. */
export const AGENT_SKILLS_SCHEMAS_DIR = safePath.join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/**
 * Post-process marketplace-manifest schema to add path traversal constraint.
 *
 * zodToJsonSchema cannot encode Zod's .refine() calls, so we manually inject
 * a JSON Schema `not: { pattern }` constraint onto the string source option.
 *
 * Pattern "\.\." rejects any string containing literal ".." (directory traversal).
 * This catches "../plugins/foo" and "./foo/../bar" — both rejected by Claude Code.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking the emitted JSON Schema document
function addPathTraversalConstraint(schema: Record<string, any>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking the emitted JSON Schema document
  const defs: Record<string, any> = schema['definitions'] ?? schema['$defs'] ?? {};
  const pluginEntry = defs['marketplace-manifest']?.['properties']?.['plugins']?.['items'] as Record<string, unknown> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking the emitted JSON Schema document
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

/** Every JSON Schema this package ships under `schemas/`. */
export const AGENT_SKILLS_SCHEMA_TARGETS: readonly EmittedSchemaTarget[] = [
  { name: 'skill-frontmatter', schema: AgentSkillFrontmatterSchema },
  { name: 'vat-skill-frontmatter', schema: VATAgentSkillFrontmatterSchema },
  { name: 'marketplace-manifest', schema: MarketplaceManifestSchema, postProcess: addPathTraversalConstraint },
  { name: 'friction-report', schema: FrictionReportSchema },
];

if (isEntrypoint(import.meta.url)) {
  console.log('🔨 Generating JSON Schemas from Zod...\n');
  for (const path of writeEmittedSchemas(AGENT_SKILLS_SCHEMAS_DIR, AGENT_SKILLS_SCHEMA_TARGETS)) {
    console.log(`✅ Generated: ${path}`);
  }
  console.log('\n✨ JSON Schema generation complete!');
}
