import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DATA_DEFECT_CODES } from '../../src/projection/data-extractor.js';
import { TS_DEFECT_CODES } from '../../src/projection/ts-extractor.js';
import { DataRouteRowSchema } from '../../src/schemas/projection-data.js';
import { TsRouteRowSchema } from '../../src/schemas/projection-ts.js';

// Derived from `import.meta.url`, not user input: the repo's docs/validation-codes.md.
const docs = readFileSync(fileURLToPath(new URL('../../../../docs/validation-codes.md', import.meta.url)), 'utf8');

/** One `- \`<state>\`: <meaning>` line per state, as the schema's description states it. */
function stateLines(description: string): string[] {
  return [...description.matchAll(/`(\w+)`: (.+?)(?=; `\w+`: |$)/gu)].map(([, state = '', meaning = '']) => `- \`${state}\`: ${meaning}`);
}

describe('data__routes state', () => {
  it('means in the docs exactly what the schema describes, one line per state', () => {
    const lines = stateLines(DataRouteRowSchema.shape.state.description ?? '');
    expect(lines.map((line) => /`(\w+)`/u.exec(line)?.[1])).toStrictEqual(DataRouteRowSchema.shape.state.options);
    const section = docs.slice(docs.indexOf('**Pair codes**'), docs.indexOf('| Code | State | What |'));
    for (const line of lines) expect(section.split('\n')).toContain(line);
  });

  it('gives every defect the bytes decide its own defective row in the pair-codes table', () => {
    const table = docs.slice(docs.indexOf('| Code | State | What |'));
    for (const code of DATA_DEFECT_CODES) expect(table, code).toContain(`| \`${code}\` | defective | `);
  });
});

describe('ts__routes state', () => {
  it('is the data instance\'s state, so the one list in the docs states both', () => {
    expect(TsRouteRowSchema.shape.state.description).toBe(DataRouteRowSchema.shape.state.description);
    expect(TsRouteRowSchema.shape.state.options).toStrictEqual(DataRouteRowSchema.shape.state.options);
  });

  it('gives every defect the bytes decide its own defective row in the ts pair-codes table', () => {
    const section = docs.slice(docs.indexOf('### TypeScript instance codes'), docs.indexOf('### QA-snapshot invariants'));
    const table = section.slice(section.indexOf('| Code | State | What |'));
    for (const code of TS_DEFECT_CODES) expect(table, code).toContain(`| \`${code}\` | defective | `);
  });
});
