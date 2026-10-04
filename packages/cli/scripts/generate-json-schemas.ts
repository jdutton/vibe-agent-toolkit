#!/usr/bin/env tsx
/**
 * Write `schemas/<name>.json` for every `report` entry of the published-shape
 * registry, and for every `artifact` entry whose committed schema file lives
 * in this package.
 *
 * The list lives in `src/report-schemas.ts`, not here: `test/published-shapes.test.ts`
 * asserts on what this script wrote, and the two must not be able to disagree
 * about what "all of them" means. An artifact whose `schemaFile` is another
 * package's (a projection relation, the friction report) is emitted by THAT
 * package's generator — one file per shape. The writer is the shared one every
 * package's `generate:schemas` uses, so the artifacts render identically.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { isEntrypoint } from '@vibe-agent-toolkit/utils/process';

import { writeEmittedSchemas, type EmittedSchemaTarget } from '../../dev-tools/src/pin-emitted-schemas.js';
import { PUBLISHED_SHAPES } from '../src/report-schemas.js';

/** The committed directory the artifacts live in. */
export const CLI_SCHEMAS_DIR = safePath.join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** The registry's `report` entries and this package's artifact schemas, as the shared writer takes them. */
export const CLI_SCHEMA_TARGETS: readonly EmittedSchemaTarget[] = PUBLISHED_SHAPES.flatMap((entry): EmittedSchemaTarget[] => {
  if (entry.kind === 'report') return [{ name: entry.name, schema: entry.schema }];
  // An artifact is this script's to write only when its schema file is the one this script writes.
  if (entry.kind === 'artifact' && entry.channel !== 'export' && entry.schema !== null && entry.schemaFile === `packages/cli/schemas/${entry.name}.json`) {
    return [{ name: entry.name, schema: entry.schema }];
  }
  return [];
});

if (isEntrypoint(import.meta.url)) {
  console.log('🔨 Generating report JSON Schemas from the registry...\n');
  for (const path of writeEmittedSchemas(CLI_SCHEMAS_DIR, CLI_SCHEMA_TARGETS)) {
    console.log(`✅ Generated: ${path}`);
  }
  console.log('\n✨ Report schema generation complete!');
}
