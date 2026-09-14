/**
 * What the parse-fact snapshot does with a path it cannot read.
 *
 * "Unreadable ones are skipped" used to mean every throw from the read: a path
 * that vanished since enumeration AND a path the OS refused. The first is no
 * longer in the corpus; the second is, and a snapshot with that row quietly
 * missing is the measurement-that-did-not-run the oracle's own `@throws`
 * promises to fail loudly on.
 */

import { readContentWithKey } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureParseFactSnapshot } from '../../src/pipeline-oracles/parse-fact-snapshot.js';

import { setupCorpusFixture } from './helpers/corpus-fixture.js';

// The read is `readContentWithKey` from the resources package, so the refusal
// is injected at that seam rather than by `chmod`, which reaches one errno,
// only where POSIX modes bind, and not as root.
vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readContentWithKey: vi.fn(actual['readContentWithKey'] as (...args: unknown[]) => unknown) };
});

const fixture = setupCorpusFixture('vat-parse-fact-unreadable-', { 'notes.md': '# Notes\n' });

afterEach(() => {
  vi.mocked(readContentWithKey).mockRestore();
});

describe('a path the snapshot cannot read', () => {
  it('skips one that is no longer there — it left the corpus', async () => {
    const paths = [...fixture.absolutePaths(), safePath.join(fixture.root(), 'vanished.md')];

    const snapshot = await captureParseFactSnapshot(paths, { corpusRoot: fixture.root(), corpus: 'x' });

    expect(snapshot.rows).toHaveLength(1);
  });

  it('fails on one the OS refuses — it is in the corpus and would be missing from the measurement', async () => {
    vi.mocked(readContentWithKey).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    await expect(
      captureParseFactSnapshot(fixture.absolutePaths(), { corpusRoot: fixture.root(), corpus: 'x' }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});
