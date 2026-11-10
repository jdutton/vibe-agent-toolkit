/**
 * A check finding's two cross-field rules hold in BOTH contracts: the Zod schema every document is
 * re-parsed against at publish, and the committed JSON Schemas a consumer validates against.
 *
 * - `evidence` is a check's row, so a finding carrying it names its `check`.
 * - `reason` explains why a check is broken, so only a `RESOURCE_CHECK_BROKEN` finding carries it.
 *
 * Beside them, every published finding's own rule: a `column` carries its `line`.
 *
 * `zod-to-json-schema` drops refinements, so the generator emits them through `presenceImplies`; the
 * committed-file cases compile the COMMITTED schema and fail the day it stops.
 */

import { readFileSync } from 'node:fs';

import { createAjvWithUriFormats } from '@vibe-agent-toolkit/resources';
import { COLUMN_REQUIRES_LINE_JSON_RULE, presenceImplies } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { CHECK_FINDING_SCHEMA } from '../../src/commands/resources/check-schema.js';
import { buildCheckOutputData, runProjectChecks } from '../../src/commands/resources/check.js';
import { NO_COLUMNS } from '../helpers/no-columns.js';

const BROKEN = { code: 'RESOURCE_CHECK_BROKEN', severity: 'error', message: 'm', check: 'c' };
const VIOLATION = { code: 'CUSTOM:c', severity: 'error', message: 'm', check: 'c', evidence: { n: 1 } };

describe('CHECK_FINDING_SCHEMA', () => {
  it('accepts a violation with evidence and a broken check with a reason (positive control)', () => {
    expect(CHECK_FINDING_SCHEMA.safeParse(VIOLATION).success).toBe(true);
    expect(CHECK_FINDING_SCHEMA.safeParse({ ...BROKEN, reason: { refusal: 'USAGE_INVALID' } }).success).toBe(true);
  });

  it('refuses evidence on a finding that names no check', () => {
    const unnamed = Object.fromEntries(Object.entries(VIOLATION).filter(([key]) => key !== 'check'));
    expect(CHECK_FINDING_SCHEMA.safeParse(unnamed).success).toBe(false);
  });

  it('refuses a reason on any finding but RESOURCE_CHECK_BROKEN', () => {
    expect(CHECK_FINDING_SCHEMA.safeParse({ ...VIOLATION, reason: { refusal: 'USAGE_INVALID' } }).success).toBe(false);
  });
});

/** The rules the generator emits on a check finding's items node: the finding's own, then the check's two. */
const EMITTED_RULES = [
  COLUMN_REQUIRES_LINE_JSON_RULE,
  presenceImplies('evidence', { required: ['check'] }),
  presenceImplies('reason', { required: ['code'], properties: { code: { const: 'RESOURCE_CHECK_BROKEN' } } }),
];

/** A committed schema under `packages/cli/schemas/`, parsed. */
function committed(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(safePath.join(import.meta.dirname, '..', '..', 'schemas', `${name}.json`), 'utf8')) as Record<string, unknown>;
}

describe.each(['resources-check', 'orchestrator'])('the committed %s.json', (name) => {
  it('carries every rule on its findings', () => {
    const document = committed(name) as {
      definitions: Record<string, { anyOf: { properties: { findings: { items: { allOf?: unknown } } } }[] }>;
    };
    const items = document.definitions[name]?.anyOf[0]?.properties.findings.items;

    expect(items?.allOf).toStrictEqual(EMITTED_RULES);
  });
});

/** A real `status: findings` document of `vat resources check`: one violation, at a line and column. */
function findingsDocument(): Record<string, unknown> {
  const { issues, costs } = runProjectChecks({
    warn: () => undefined,
    columnsOf: NO_COLUMNS,
    builtins: [],
    checks: { c: { description: 'd', sql: 'V' } },
    only: undefined,
    ask: () => [{ path: 'a.md', finding_line: 2, finding_column: 3, n: 1 }],
    validation: undefined,
    membersEnumerated: 1,
  });
  const populated = { population: 'derived', lensPopulation: 'none', populationMs: 1, lensMs: 0, lensesEvaluated: [], membersEnumerated: 1 } as const;
  // Through JSON text, as the run publishes it: an `undefined` field is absent, not present-and-undefined.
  const published = JSON.stringify(buildCheckOutputData({ root: '/corpus', durationMs: 3, issues, costs, populated }));
  return JSON.parse(published) as Record<string, unknown>;
}

describe('the committed resources-check.json, compiled', () => {
  const validate = createAjvWithUriFormats({}).compile(committed('resources-check'));
  const document = findingsDocument();
  const [violation] = document['findings'] as Record<string, unknown>[];
  /** The document with its one finding replaced. */
  const withFinding = (finding: Record<string, unknown>): Record<string, unknown> => ({ ...document, findings: [finding] });
  const without = (key: string): Record<string, unknown> => Object.fromEntries(Object.entries(violation ?? {}).filter(([at]) => at !== key));

  it('accepts a full status: findings document (positive control)', () => {
    expect(document['status']).toBe('findings');
    expect(violation).toMatchObject({ check: 'c', line: 2, column: 3, evidence: { n: 1 } });
    expect(validate(document) ? [] : validate.errors).toStrictEqual([]);
  });

  it.each([
    ['evidence on a finding that names no check', () => withFinding(without('check'))],
    ['a reason on a finding that is not RESOURCE_CHECK_BROKEN', () => withFinding({ ...violation, reason: { refusal: 'USAGE_INVALID' } })],
    ['a column with no line', () => withFinding(without('line'))],
  ])('refuses %s, as the runtime does', (_what, build) => {
    expect(validate(build())).toBe(false);
  });
});
