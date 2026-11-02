/**
 * The memory probe recognises the spawner by a marker the spawner sets. The two
 * name it by literal in different files (the probe may import nothing), so this
 * pins them to one spelling: a rename on either side reds here instead of
 * silently failing every repeat for want of a spawner peak.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

const MEMORY_DIR = resolveFromImportMeta(import.meta.url, '../src/facets/memory');

const SPAWNER_MARKER = /\bconst SPAWNER_PID_ENV = '([A-Z_]+)';/;

/** The string literal the marker declaration in `file` assigns. */
function markerIn(file: string): string | undefined {
  return SPAWNER_MARKER.exec(readFileSync(safePath.join(MEMORY_DIR, file), 'utf-8'))?.[1];
}

describe('the spawner marker', () => {
  it('is spelled the same by the spawner that sets it and the probe that reads it', () => {
    const spawner = markerIn('rss-spawner.ts');
    expect(spawner).toBeDefined();
    expect(markerIn('rss-probe.cts')).toBe(spawner);
  });
});
