/**
 * A check finding's two cross-field rules hold in BOTH contracts: the Zod schema every document is
 * re-parsed against at publish, and the committed JSON Schemas a consumer validates against.
 *
 * - `evidence` is a check's row, so a finding carrying it names its `check`.
 * - `reason` explains why a check is broken, so only a `RESOURCE_CHECK_BROKEN` finding carries it.
 *
 * `zod-to-json-schema` drops refinements, so the generator emits both as `if`/`then`; the
 * committed-file cases fail the day it stops.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { CHECK_FINDING_SCHEMA } from '../../src/commands/resources/check-schema.js';

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

/** The rules the generator emits on a check finding's items node. */
const EMITTED_RULES = [
  { if: { required: ['evidence'] }, then: { required: ['check'] } },
  { if: { required: ['reason'] }, then: { required: ['code'], properties: { code: { const: 'RESOURCE_CHECK_BROKEN' } } } },
];

describe.each(['resources-check', 'orchestrator'])('the committed %s.json', (name) => {
  it('carries both rules on its findings', () => {
    const file = safePath.join(import.meta.dirname, '..', '..', 'schemas', `${name}.json`);
    const document = JSON.parse(readFileSync(file, 'utf8')) as {
      definitions: Record<string, { anyOf: { properties: { findings: { items: { allOf?: unknown } } } }[] }>;
    };
    const items = document.definitions[name]?.anyOf[0]?.properties.findings.items;

    expect(items?.allOf).toStrictEqual(EMITTED_RULES);
  });
});
