/**
 * A known defect marked as blocking the stable tag must stop `bun run
 * pre-release` on a stable version and only there. Any `**Blocks` line that is
 * not the exact marker throws, so the real-file test below fails on a misspelt
 * marker rather than letting it through.
 */

import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import {
  STABLE_TAG_BLOCKER_MARKER,
  isPrereleaseVersion,
  readKnownDefects,
  releaseReadinessDefectRefusal,
  stableTagBlockers,
  stableTagRefusal,
} from '../src/known-defects-gate.js';

const BLOCKING = `# Known defects

## Git and crawl

### A one-file edit repopulates the whole tree

${STABLE_TAG_BLOCKER_MARKER}
- **Severity:** Important

### Something minor

- **Severity:** Minor
`;

const CLEAN = `# Known defects

### Something minor

- **Severity:** Minor — mentions the stable tag in prose, which is not the marker
`;

describe('stableTagBlockers', () => {
  it('names each entry that carries the marker, and no other', () => {
    expect(stableTagBlockers(BLOCKING)).toEqual(['A one-file edit repopulates the whole tree']);
    expect(stableTagBlockers(CLEAN)).toEqual([]);
  });

  it('refuses a marker that sits before any entry heading', () => {
    expect(() => stableTagBlockers(`# Known defects\n\n${STABLE_TAG_BLOCKER_MARKER}\n`)).toThrow(/heading/);
  });

  it.each([
    '- **Blocks**: the stable tag',
    '* **Blocks:** the stable tag',
    '- **Blocks:** the stable tag.',
    '- **Blocks:** the stable tag (until S6)',
    '- **blocks:** the stable tag',
    '- Blocks: the stable tag',
    '- **Blocking:** the stable tag',
    '- **Blocker:** the stable tag',
    '+ blocks the stable tag',
  ])('throws on the near-miss marker %j rather than failing open', (line) => {
    expect(() => stableTagBlockers(`### An entry\n\n${line}\n`)).toThrow(/marker/);
  });

  it('reads a list line whose first word merely CONTAINS "block" as prose, not a near-miss', () => {
    expect(stableTagBlockers('### An entry\n\n- Unblocks nothing; see the stable tag notes.\n- **Severity:** Minor\n')).toEqual([]);
  });

  it('ignores the marker quoted as inline code in prose', () => {
    expect(stableTagBlockers(`### An entry\n\nMark it \`${STABLE_TAG_BLOCKER_MARKER}\` to block.\n`)).toEqual([]);
  });
});

describe('stableTagRefusal', () => {
  it('refuses a stable version while an entry blocks the stable tag', () => {
    expect(stableTagRefusal('0.2.0', BLOCKING)).toMatch(/A one-file edit repopulates the whole tree/);
  });

  it('lets a prerelease through whatever is blocking', () => {
    expect(stableTagRefusal('0.2.0-rc.12', BLOCKING)).toBeUndefined();
  });

  it('lets a stable version through when nothing blocks', () => {
    expect(stableTagRefusal('0.2.0', CLEAN)).toBeUndefined();
  });
});

describe('releaseReadinessDefectRefusal', () => {
  const blocking = (): string => BLOCKING;

  it('refuses a stable release-readiness run over a blocking register', () => {
    expect(releaseReadinessDefectRefusal({ version: '0.2.0', releaseReadiness: true, register: blocking }))
      .toMatch(/A one-file edit repopulates the whole tree/);
  });

  it('lets an rc through, and gates nothing outside release readiness', () => {
    expect(releaseReadinessDefectRefusal({ version: '0.2.0-rc.12', releaseReadiness: true, register: blocking }))
      .toBeUndefined();
    const unread = (): string => { throw new Error('read the register outside release readiness'); };
    expect(releaseReadinessDefectRefusal({ version: '0.2.0', releaseReadiness: false, register: unread }))
      .toBeUndefined();
  });
});

describe('isPrereleaseVersion', () => {
  it('tells an rc from a stable version', () => {
    expect(isPrereleaseVersion('0.2.0-rc.12')).toBe(true);
    expect(isPrereleaseVersion('0.2.0')).toBe(false);
  });
});

describe('the real known-defects file', () => {
  it('parses, so the gate cannot be silenced by a malformed file', () => {
    const text = readKnownDefects(PROJECT_ROOT);

    expect(() => stableTagBlockers(text)).not.toThrow();
  });
});
