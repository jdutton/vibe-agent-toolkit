/**
 * A known defect marked as blocking the stable tag must stop `bun run
 * pre-release` on a stable version and only there. The real file is read too,
 * so a marker spelled the way the parser cannot see fails here, not at release.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import {
  KNOWN_DEFECTS_PATH,
  STABLE_TAG_BLOCKER_MARKER,
  isPrereleaseVersion,
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

describe('isPrereleaseVersion', () => {
  it('tells an rc from a stable version', () => {
    expect(isPrereleaseVersion('0.2.0-rc.12')).toBe(true);
    expect(isPrereleaseVersion('0.2.0')).toBe(false);
  });
});

describe('the real known-defects file', () => {
  it('parses, so the gate cannot be silenced by a malformed file', () => {
    const text = readFileSync(safePath.join(PROJECT_ROOT, KNOWN_DEFECTS_PATH), 'utf8');

    expect(() => stableTagBlockers(text)).not.toThrow();
  });
});
