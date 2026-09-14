/**
 * Rule 13 of the structure gate: every `bin` target's source calls
 * `installLastResortExit()`. Two pure pieces — mapping a `bin` target to the
 * source it is built from, and judging a set of read sources — so the gate's
 * verdict can be pinned without a tree.
 */

import { describe, expect, it } from 'vitest';

import { binSourceOf, findBinsWithoutLastResort } from '../src/validate-repo-structure.js';

describe('binSourceOf', () => {
  it('maps a dist/ target to the TypeScript that builds it', () => {
    expect(binSourceOf('packages/cli', './dist/bin/vat.js')).toBe('packages/cli/src/bin/vat.ts');
  });

  it('keeps a hand-written bin file as written', () => {
    expect(binSourceOf('packages/vibe-agent-toolkit', './bin/vat')).toBe('packages/vibe-agent-toolkit/bin/vat');
  });
});

describe('findBinsWithoutLastResort', () => {
  it('passes a bin that calls the last resort', () => {
    expect(findBinsWithoutLastResort([{ path: 'packages/x/src/bin.ts', text: "installLastResortExit();\nrun();" }])).toEqual([]);
  });

  it('fails a bin that never calls it, naming the file', () => {
    const findings = findBinsWithoutLastResort([{ path: 'packages/x/src/bin.ts', text: 'run();' }]);
    expect(findings.map((f) => [f.path, f.severity])).toEqual([['packages/x/src/bin.ts', 'error']]);
    expect(findings[0]?.message).toContain('installLastResortExit()');
  });

  it('fails a bin whose source could not be read — silence is not a pass', () => {
    const findings = findBinsWithoutLastResort([{ path: 'packages/x/bin/gone', text: undefined }]);
    expect(findings.map((f) => f.path)).toEqual(['packages/x/bin/gone']);
    expect(findings[0]?.message).toContain('could not be read');
  });
});
