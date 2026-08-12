/**
 * Unit tests for the drill-down header.
 *
 * `renderCompareSummary` is exercised by `diff.test.ts` against real comparison
 * reports, which is where it belongs — it is only meaningful over one. This
 * file covers the other half of the reading surface, `renderDetailHeader`, over
 * hand-built rows so each conditional can be driven both ways.
 *
 * The load-bearing case is the **reordering** note. `ArtifactDelta`'s line
 * counts are an order-insensitive multiset difference, so a pure reordering
 * reads `changed  +0/-0` — a row that looks like a no-op while the artifact
 * text genuinely moved. This header is the only place a reader is told that,
 * and a header that stopped saying it would look completely normal.
 */

import { describe, expect, it } from 'vitest';

import { renderDetailHeader } from '../../src/qa-snapshot/render.js';
import type { ArtifactDelta } from '../../src/qa-snapshot/types.js';

const REORDER_NOTE = 'REORDERING';
const ADVISORY_NOTE = 'advisory';

/**
 * One comparison row, clean unless the test says otherwise.
 *
 * @param overrides - The fields this test varies
 * @returns The row
 */
function delta(overrides: Partial<ArtifactDelta> = {}): ArtifactDelta {
  return {
    name: 'enumeration.resources',
    kind: 'oracle',
    artifact: 'oracle/enumeration.resources.txt',
    status: 'changed',
    addedLines: 0,
    removedLines: 0,
    headlines: [],
    ...overrides,
  };
}

describe('renderDetailHeader', () => {
  it('states the artifact, its kind, its status and its counts', () => {
    const text = renderDetailHeader(delta({ addedLines: 3, removedLines: 1 }));

    expect(text).toContain('enumeration.resources');
    expect(text).toContain('oracle/enumeration.resources.txt');
    expect(text).toContain('kind: oracle');
    expect(text).toContain('status: changed');
    expect(text).toContain('+3/-1');
    expect(text.endsWith('\n')).toBe(true);
  });

  describe('the reordering note', () => {
    it('fires when the text changed but no line was added or removed', () => {
      const text = renderDetailHeader(delta({ addedLines: 0, removedLines: 0 }));

      expect(text).toContain(REORDER_NOTE);
    });

    it('stays silent when lines actually moved, even with one count at zero', () => {
      // `+3/-0` is the case an `||` in the guard would misreport as a
      // reordering. It is a genuine addition and must not carry the note.
      const text = renderDetailHeader(delta({ addedLines: 3, removedLines: 0 }));

      expect(text).not.toContain(REORDER_NOTE);
    });

    it('stays silent on an unchanged row, which is 0/0 for an honest reason', () => {
      const text = renderDetailHeader(delta({ status: 'same' }));

      expect(text).not.toContain(REORDER_NOTE);
    });
  });

  describe('headlines', () => {
    it('prints one per line and marks the whole set advisory', () => {
      const text = renderDetailHeader(
        delta({ headlines: ['enumeratedCount 265→267', 'linksFound 730→731'] }),
      );
      const lines = text.split('\n');

      expect(lines).toContain('headline: enumeratedCount 265→267');
      expect(lines).toContain('headline: linksFound 730→731');
      // Headlines come from a shallow key/value scan, not a parse. Printing
      // them without saying so invites a reader to treat a heuristic as the
      // authoritative signal, which `status` and the line counts are.
      expect(text).toContain(ADVISORY_NOTE);
    });

    it('says nothing about advisories when there are no headlines', () => {
      const text = renderDetailHeader(delta({ headlines: [] }));

      expect(text).not.toContain('headline:');
      expect(text).not.toContain(ADVISORY_NOTE);
    });
  });
});
