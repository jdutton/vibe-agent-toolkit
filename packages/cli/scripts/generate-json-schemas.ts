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

import { COLUMN_REQUIRES_LINE_JSON_RULE } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { isEntrypoint } from '@vibe-agent-toolkit/utils/process';

import { writeEmittedSchemas, type EmittedSchemaTarget } from '../../dev-tools/src/pin-emitted-schemas.js';
import { CHECK_FINDING_JSON_RULES } from '../src/commands/resources/check-schema.js';
import { PUBLISHED_SHAPES } from '../src/report-schemas.js';

/** The committed directory the artifacts live in. */
export const CLI_SCHEMAS_DIR = safePath.join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** Whether a rendered node's `properties` declare every one of `keys`. */
function declares(node: Record<string, unknown>, keys: readonly string[]): boolean {
  const properties = node['properties'];
  return typeof properties === 'object' && properties !== null && keys.every((key) => key in properties);
}

/** A finding (a validation issue): an object schema declaring its code, severity, message and coordinates. */
const FINDING_KEYS = ['code', 'severity', 'message', 'line', 'column'] as const;

/** A check finding: a finding that also declares `evidence` and `reason`. */
const CHECK_FINDING_KEYS = ['evidence', 'reason'] as const;

/**
 * The rules a rendered finding node carries: every finding's own ({@link COLUMN_REQUIRES_LINE_JSON_RULE},
 * which `ValidationIssueSchema` and `reportSchema` refine with), then a check finding's two
 * ({@link CHECK_FINDING_JSON_RULES}) — or none for a node that is no finding.
 */
function findingRulesOf(node: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (!declares(node, FINDING_KEYS)) return [];
  return declares(node, CHECK_FINDING_KEYS) ? [COLUMN_REQUIRES_LINE_JSON_RULE, ...CHECK_FINDING_JSON_RULES] : [COLUMN_REQUIRES_LINE_JSON_RULE];
}

/**
 * Emit the finding rules `zod-to-json-schema` drops on every finding node in a rendered document,
 * so a report that folds check findings in — `resources-check`, `orchestrator` — carries the rules
 * `CHECK_FINDING_SCHEMA` refines with, and every report the column rule. Applied to EVERY target:
 * a report that starts carrying findings inherits the rules without anyone remembering to opt it in.
 *
 * @throws Error When a finding node already carries an `allOf` — the rules cannot be emitted
 *   beside it without overwriting one, and a dropped rule is an artifact that accepts what the
 *   runtime refuses
 */
function emitFindingRules(document: Record<string, unknown>): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const rules = findingRulesOf(record);
    if (rules.length > 0) {
      if (record['allOf'] !== undefined) {
        throw new Error('A finding node already carries an allOf: the finding rules cannot be emitted beside it');
      }
      record['allOf'] = rules;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(document);
}

/** The registry's `report` entries and this package's artifact schemas, as the shared writer takes them. */
export const CLI_SCHEMA_TARGETS: readonly EmittedSchemaTarget[] = PUBLISHED_SHAPES.flatMap((entry): EmittedSchemaTarget[] => {
  if (entry.kind === 'report') return [{ name: entry.name, schema: entry.schema, postProcess: emitFindingRules }];
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
