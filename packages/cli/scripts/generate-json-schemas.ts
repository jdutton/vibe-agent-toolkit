#!/usr/bin/env tsx
/**
 * Write `schemas/<name>.json` for every command whose structured document is
 * the shared report envelope.
 *
 * The list lives in `src/report-schemas.ts`, not here: `test/report-schemas.test.ts`
 * asserts on what this script wrote, and the two must not be able to disagree
 * about what "all of them" means. The writer is the shared one every package's
 * `generate:schemas` uses, so the artifacts render identically across packages.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { isEntrypoint } from '@vibe-agent-toolkit/utils/process';

import { writeEmittedSchemas, type EmittedSchemaTarget } from '../../dev-tools/src/pin-emitted-schemas.js';
import { REPORT_SCHEMAS } from '../src/report-schemas.js';

/** The committed directory the artifacts live in. */
export const CLI_SCHEMAS_DIR = safePath.join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** The registry's `report` entries, as the shared writer takes them. */
export const CLI_SCHEMA_TARGETS: readonly EmittedSchemaTarget[] = REPORT_SCHEMAS.flatMap((entry) =>
  entry.kind === 'report' ? [{ name: entry.name, schema: entry.schema }] : [],
);

if (isEntrypoint(import.meta.url)) {
  console.log('🔨 Generating report JSON Schemas from the registry...\n');
  for (const path of writeEmittedSchemas(CLI_SCHEMAS_DIR, CLI_SCHEMA_TARGETS)) {
    console.log(`✅ Generated: ${path}`);
  }
  console.log('\n✨ Report schema generation complete!');
}
