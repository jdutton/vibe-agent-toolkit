/**
 * A report an older lab captured is refused with its CAUSE and the remedy —
 * "captured by a lab whose report shape differs … re-capture it" — never a bare
 * schema error. Pre-1.0 there is no compat shim: the refusal is the whole
 * answer, so it has to say what to do.
 *
 * Integration-tier: each reader is driven through the file it reads.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { readArmsReportFile } from '../../src/facets/perf/arms-report-file.js';
import { readVerdictDirectory } from '../../src/facets/verdict/compare.js';
import { makeReport } from '../report-fixtures.js';

import { cleanupVerdictFixtures, tempDir } from './verdict-fixtures.js';

afterAll(cleanupVerdictFixtures);

const RE_CAPTURE = /captured by a lab whose report shape differs from this one \(usually an older lab\) — re-capture it\./u;

describe('a report an older lab captured', () => {
  it('verdict: a body without preparedClone is refused with the cause, naming the file and the field', async () => {
    const dir = tempDir('lab-old-verdict-');
    const file = safePath.join(dir, 'old.json');
    const olderBody = { arm: { set: {}, unset: [] }, rows: [], excluded: [] };
    writeFileSync(file, JSON.stringify(makeReport({ facet: 'verdict', body: olderBody })));

    const read = await readVerdictDirectory(dir);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.refusal).toMatch(RE_CAPTURE);
    expect(read.refusal).toContain(file);
    expect(read.refusal).toContain('preparedClone');
  });

  it('perf arms: a report missing what this lab judges is refused with the cause', () => {
    const file = safePath.join(tempDir('lab-old-arms-'), 'arms-report.json');
    writeFileSync(file, JSON.stringify({ prepared: { ok: true, path: '/x', commit: 'abc' }, builds: [], arms: [] }));

    const read = readArmsReportFile(file);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.refusal).toMatch(RE_CAPTURE);
    expect(read.refusal).toContain('load');
  });
});
