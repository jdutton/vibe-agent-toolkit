/**
 * Unit tests for the allowlist seed: parsing vitest's per-file summary lines
 * out of a serial root-run log, and classifying why a spec file is slow.
 */
import { describe, expect, it } from 'vitest';

import { MECHANISM, TIER_BUDGET_MS } from '../src/test-tier-budget-allowlist.js';
import {
  classifyMechanisms,
  findDelistCandidates,
  mechanismsOf,
  parseVitestLog,
  renderEntries,
  selectSeedCandidates,
} from '../src/test-tier-budget-seed.js';

const ESC = String.fromCodePoint(0x1b);

/**
 * A slice of a real serial root-run log — repo-relative paths, ANSI colour,
 * per-test lines interleaved, and one line carrying the timestamp GitHub
 * Actions prefixes to a job log.
 */
const LOG = [
  `${ESC}[32m ✓ ${ESC}[0mpackages/lab/test/subject.test.ts ${ESC}[2m(24 tests)${ESC}[0m ${ESC}[33m28847ms${ESC}[0m`,
  '     ✓ resolves this checkout to its built bin  1040ms',
  '2026-09-14T01:12:18.8634032Z  ✓ packages/lab/test/fast.test.ts (3 tests) 12ms',
  ' ❯ packages/lab/test/flaky.test.ts (2 tests | 1 failed) 2s',
  ' ↓ packages/lab/test/gated.test.ts (5 tests | 5 skipped)',
  ' ✓ packages/lab/test/subject.test.ts (24 tests) 28000ms',
  ' ✓ packages/lab/test/integration/io.integration.test.ts (7 tests) 3340ms',
  '@vibe-agent-toolkit/lab:test:unit:  ✓ test/turbo-lane.test.ts (1 test) 900ms',
].join('\n');

describe('parseVitestLog', () => {
  it('reads one duration per spec file, keeping the FIRST line for a file that prints twice', () => {
    const rows = parseVitestLog(LOG);
    expect(rows).toEqual([
      { file: 'packages/lab/test/subject.test.ts', durationMs: 28_847 },
      { file: 'packages/lab/test/fast.test.ts', durationMs: 12 },
      { file: 'packages/lab/test/flaky.test.ts', durationMs: 2_000 },
      { file: 'packages/lab/test/integration/io.integration.test.ts', durationMs: 3_340 },
    ]);
  });

  it('ignores per-test lines, files that printed no duration, and a turbo lane\'s package-relative line', () => {
    const files = parseVitestLog(LOG).map((r) => r.file);
    expect(files).not.toContain('packages/lab/test/gated.test.ts');
    expect(files.some((f) => f.includes('turbo-lane'))).toBe(false);
    expect(files.every((f) => f.startsWith('packages/') && f.endsWith('.test.ts'))).toBe(true);
  });

  it('returns nothing for an empty log', () => {
    expect(parseVitestLog('')).toEqual([]);
  });
});

describe('classifyMechanisms', () => {
  it('names each integration-shaped mechanism the source uses, in a stable order', () => {
    const source = [
      "const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'x-'));",
      "runGit(['init'], { cwd: dir });",
      'chmodSync(dir, 0o000);',
      "spawnSync('node', [bin]);",
    ].join('\n');
    expect(classifyMechanisms(source)).toEqual(['tempTree', 'git', 'refusal', 'spawn']);
  });

  it('recognises native models and network', () => {
    expect(classifyMechanisms("import { connect } from '@lancedb/lancedb';")).toEqual(['nativeModel']);
    expect(classifyMechanisms("await fetch('https://example.com');")).toEqual(['network']);
  });

  it('says so when nothing in the source explains the duration', () => {
    expect(classifyMechanisms('expect(1).toBe(1);')).toEqual(['unclassified']);
  });

  it('maps keys to the labels the allowlist carries', () => {
    expect(mechanismsOf(['tempTree', 'unclassified'])).toEqual([MECHANISM.tempTree, MECHANISM.unclassified]);
  });
});

describe('selectSeedCandidates', () => {
  it('keeps only files OVER their tier budget — an entry for a file under budget can only widen its ceiling — and re-lists every file already listed', () => {
    // Boundaries are the tier budgets themselves: 1 000 / 5 000 / 30 000 ms.
    // Two earlier floors (10 % of budget, then budget / 8) seeded "hover"
    // entries that were under budget when listed and bought nothing.
    const rows = [
      { file: 'packages/a/test/slow.test.ts', durationMs: 1_001 },
      { file: 'packages/a/test/fast.test.ts', durationMs: 1_000 },
      { file: 'packages/a/test/hover.test.ts', durationMs: 126 },
      { file: 'packages/a/test/listed.test.ts', durationMs: 50 },
      { file: 'packages/a/test/integration/slow.integration.test.ts', durationMs: 5_001 },
      { file: 'packages/a/test/integration/fast.integration.test.ts', durationMs: 5_000 },
      { file: 'packages/a/test/system/slow.system.test.ts', durationMs: 30_001 },
      { file: 'packages/a/test/system/fast.system.test.ts', durationMs: 30_000 },
    ];
    const allowlist = [{ file: 'packages/a/test/listed.test.ts', measuredMs: 900, mechanisms: [MECHANISM.tempTree] }];
    const files = selectSeedCandidates(rows, TIER_BUDGET_MS, allowlist).map((r) => r.file);
    expect(files.toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual([
      'packages/a/test/integration/slow.integration.test.ts',
      'packages/a/test/listed.test.ts',
      'packages/a/test/slow.test.ts',
      'packages/a/test/system/slow.system.test.ts',
    ]);
  });

  it('sorts candidates slowest first', () => {
    const rows = [
      { file: 'packages/a/test/b.test.ts', durationMs: 1_400 },
      { file: 'packages/a/test/a.test.ts', durationMs: 1_900 },
    ];
    expect(selectSeedCandidates(rows, TIER_BUDGET_MS, []).map((r) => r.durationMs)).toEqual([1_900, 1_400]);
  });
});

describe('findDelistCandidates', () => {
  it('names listed files whose measured headroom no longer exceeds the tier budget, and nothing else', () => {
    const rows = [
      { file: 'packages/a/test/still-slow.test.ts', durationMs: 126 },
      { file: 'packages/a/test/now-fast.test.ts', durationMs: 125 },
      { file: 'packages/a/test/never-listed.test.ts', durationMs: 5 },
    ];
    const allowlist = [
      { file: 'packages/a/test/still-slow.test.ts', measuredMs: 900, mechanisms: [MECHANISM.tempTree] },
      { file: 'packages/a/test/now-fast.test.ts', measuredMs: 900, mechanisms: [MECHANISM.tempTree] },
    ];
    expect(findDelistCandidates(rows, allowlist, TIER_BUDGET_MS).map((r) => r.file)).toEqual([
      'packages/a/test/now-fast.test.ts',
    ]);
  });
});

describe('renderEntries', () => {
  it('prints entries in the allowlist module shape, referencing the MECHANISM constants', () => {
    const text = renderEntries([
      { file: 'packages/a/test/a.test.ts', measuredMs: 900, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },
      { file: 'packages/a/test/b.test.ts', measuredMs: 1_200, mechanisms: [MECHANISM.unclassified], note: "it's slow" },
    ]);
    expect(text).toBe(
      "  { file: 'packages/a/test/a.test.ts', measuredMs: 900, mechanisms: [MECHANISM.tempTree, MECHANISM.git] },\n" +
        "  { file: 'packages/a/test/b.test.ts', measuredMs: 1200, mechanisms: [MECHANISM.unclassified], note: 'it\\'s slow' },\n",
    );
  });
});
