/**
 * `refusedListingMessage` is the ONE owner of the adopter-facing refusal
 * sentence, and it is printed by two enumeration routes that know different
 * things: the readdir walk, where a refusal means nothing beneath the
 * directory was seen, and the `git ls-files --others` route, where the index
 * has already named every TRACKED file beneath it and only the untracked ones
 * are missing (`file-crawler-git-refused-listing.test.ts` pins that listing).
 *
 * The sentence therefore may not assert what was enumerated beneath the
 * directory — one route or the other would contradict it in the same report —
 * only what is certain on both: whatever the listing would have found and
 * nothing else named is absent, and the result cannot be told from a complete
 * one. The claims it makes are pinned here as positives so a rewrite that
 * drops the hazard is as red as one that reinstates the walk's sentence.
 */
import { describe, expect, it } from 'vitest';

import { refusedListingMessage, type DirectoryRefusal } from '../src/file-crawler.js';

const ROOT = '/corpus';
const REMEDY = 'Fix the permissions on that directory, or gitignore it.';

function refusal(directory: string, code = 'EACCES', transient = false): DirectoryRefusal {
  return { kind: 'directory_unreadable', code, directory, transient };
}

describe('refusedListingMessage', () => {
  it('names the directory root-relative with its errno, states the gap, and appends the remedy', () => {
    const message = refusedListingMessage(refusal(`${ROOT}/docs/locked`), { root: ROOT, remedy: REMEDY });

    expect(message).toContain("the directory 'docs/locked'");
    expect(message).toContain('(EACCES)');
    expect(message).not.toContain(ROOT);
    expect(message.endsWith(REMEDY)).toBe(true);
    // The hazard, stated so it holds on both routes.
    expect(message).toMatch(/no other listing named is absent from every count/);
    expect(message).toMatch(/cannot be told from a complete one/);
  });

  it('asserts nothing about what WAS enumerated beneath the directory — the git route lists tracked members', () => {
    const message = refusedListingMessage(refusal(`${ROOT}/docs/locked`), { root: ROOT, remedy: REMEDY });
    expect(message).not.toMatch(/nothing beneath it was enumerated/);
    expect(message).not.toMatch(/declared scan/);
  });

  it('calls the scan root itself out by name rather than as an empty path', () => {
    const message = refusedListingMessage(refusal(ROOT), { root: ROOT, remedy: REMEDY });
    expect(message).toContain('the scan root itself');
    expect(message).not.toContain("''");
  });

  it('replaces the remedy with the re-run clause for a transient refusal', () => {
    const message = refusedListingMessage(refusal(`${ROOT}/x`, 'EMFILE', true), { root: ROOT, remedy: REMEDY });
    expect(message).toContain('EMFILE');
    expect(message).toMatch(/re-run before investigating/);
    expect(message).not.toContain(REMEDY);
  });
});
