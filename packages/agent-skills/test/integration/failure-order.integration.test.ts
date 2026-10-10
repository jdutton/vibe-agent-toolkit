/**
 * The two packaged-output scans read their documents in parallel. When two
 * documents fail, the error raised must be the one a sequential loop raised —
 * the first by POSITION — not whichever read happened to finish first.
 *
 * Each read is made to fail, with the FIRST-started read failing LAST in time, so
 * a first-in-time helper names the second document and this suite goes red.
 */
import * as fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';

import type * as Resources from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/** A read of one path: the shape both mocked reads are driven through. */
type PathRead = (path: string) => Promise<never>;

const mocks = vi.hoisted(() => ({ parseMarkdown: vi.fn<PathRead>(), readFile: vi.fn<PathRead>() }));

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => ({
  ...(await importOriginal<typeof Resources>()),
  parseMarkdown: mocks.parseMarkdown,
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  readFile: mocks.readFile,
}));

const { checkBrokenPackagedLinks } = await import('../../src/post-build-checks.js');
const { detectMissingReferencedPaths } = await import('../../src/validators/referenced-path-missing.js');

/**
 * A read that rejects naming its path: the first call after 30 ms, every later
 * call after 1 ms. Returns the paths in the order the reads were started.
 */
function failFirstStartedLast(mock: Mock<PathRead>): string[] {
  const started: string[] = [];
  mock.mockImplementation((path) => {
    started.push(path);
    const delay = started.length === 1 ? 30 : 1;
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`unreadable ${path}`)), delay);
    });
  });
  return started;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-failure-order-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('packaged-output scans raise the first failure by position', () => {
  it('detectMissingReferencedPaths names the first failing document, not the first to finish', async () => {
    const started = failFirstStartedLast(mocks.parseMarkdown);
    const first = safePath.join(root, 'a.md');
    const docs = [first, safePath.join(root, 'b.md')];

    await expect(detectMissingReferencedPaths(docs, root, 'claude-code')).rejects.toThrow(`unreadable ${first}`);
    expect(started).toEqual(docs);
  });

  it('checkBrokenPackagedLinks names the first failing document, not the first to finish', async () => {
    fs.writeFileSync(safePath.join(root, 'a.md'), '# a\n');
    fs.writeFileSync(safePath.join(root, 'b.md'), '# b\n');
    const started = failFirstStartedLast(mocks.readFile);

    const run = checkBrokenPackagedLinks(root);
    await expect(run).rejects.toThrow(/unreadable /);
    await run.catch((error: unknown) => {
      expect(started).toHaveLength(2);
      // The walk's own order decides "first"; the first-started read is first by position.
      expect((error as Error).message).toBe(`unreadable ${String(started[0])}`);
    });
  });
});
