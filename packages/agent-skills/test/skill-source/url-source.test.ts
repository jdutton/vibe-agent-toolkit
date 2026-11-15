import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ARCHIVE_ENTRY_UNREADABLE_CODE, ARCHIVE_REFUSED_CODE, isFsFaultError, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { ARCHIVE_DOWNLOAD_MAX_BYTES, ARCHIVE_LIMITS } from '@vibe-agent-toolkit/utils/archive';
import { type ArchiveFixtureEntry, entryHoldingMoreThanDeclared, hostileArchive, hostileArchiveRows, zipFixture } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SKILL_SOURCE_DIGEST_REQUIRED_CODE, SKILL_SOURCE_FETCH_FAILED_CODE } from '../../src/skill-source/source-errors.js';
import { resolveUrlSource, sha256Of } from '../../src/skill-source/sources/url-source.js';
import type { ResolveSkillSourceContext } from '../../src/skill-source/types.js';
import { SKILL_TEST_REFUSAL_BY_ERROR_CODE } from '../../src/skill-test/failure-reason.js';
import { useScratchTmpdir } from '../test-helpers.js';

// ⛔ Disposal paths: TMPDIR / TEMP / TMP point at a scratch tree for every test (and every child
// a test spawns), so neither the run nor a mutation of its cleanup can reach the real temp dir.
useScratchTmpdir('vat-scratch-1-');

// The git-url arm spawns real git (bare repo + clone) and lives in the
// integration tier: test/integration/url-source-git.integration.test.ts.

/** SKILL.md body packed into the zip fixture and asserted on extraction. */
const ZIP_SKILL_BODY = '# zip skill';

let root: string;
let zipPath: string;
let zipSha: string;
let ctx: ResolveSkillSourceContext;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Write `entries` as a ZIP under the suite root: its `file://` url and the digest that pins it. */
function zipAt(name: string, entries: readonly ArchiveFixtureEntry[], framed: (archive: Buffer) => Buffer = (archive) => archive): { url: string; sha: string } {
  const bytes = framed(zipFixture(entries));
  const path = safePath.join(root, name);
  writeFileSync(path, bytes);
  return { url: pathToFileURL(path).href, sha: sha256(bytes) };
}

/** A stand-in for `fetch` answering every request with `response`, or rejecting with it when it is an error. */
function stubFetch(response: Response | Error): void {
  vi.stubGlobal('fetch', () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
}

/** What a resolve rejected with; a resolution fails the test. */
async function rejectionOf(work: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await work();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a rejection');
}

beforeAll(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-url-'));
  ctx = {
    repoRoot: root,
    stagingRoot: safePath.join(root, 'staging'),
    fetchCacheDir: safePath.join(root, 'cache'),
  };

  zipPath = safePath.join(root, 'skill.zip');
  writeFileSync(zipPath, zipFixture([{ name: 'SKILL.md', data: ZIP_SKILL_BODY }]));
  zipSha = sha256(readFileSync(zipPath));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('resolves a .zip file url, verifies sha256, and stages it', async () => {
  const fileUrl = pathToFileURL(zipPath).href;
  const result = await resolveUrlSource(fileUrl, zipSha, ctx);
  expect(readFileSync(safePath.join(result.stagedDir, 'SKILL.md'), 'utf-8')).toBe(ZIP_SKILL_BODY);
  expect(result.identity).toBe(`url:${fileUrl}:${zipSha}`);
});

it('serves a .zip url from the warm cache on a second resolve', async () => {
  const fileUrl = pathToFileURL(zipPath).href;
  const first = await resolveUrlSource(fileUrl, zipSha, ctx);
  const second = await resolveUrlSource(fileUrl, zipSha, ctx);
  expect(second.identity).toBe(first.identity);
  expect(readFileSync(safePath.join(second.stagedDir, 'SKILL.md'), 'utf-8')).toBe(ZIP_SKILL_BODY);
});

it('exposes sha256Of computing the same digest used for zip integrity', () => {
  const bytes = readFileSync(zipPath);
  expect(sha256Of(bytes)).toBe(zipSha);
});

/**
 * Every way a `url` source can fail is the operator's to fix, and says so with a code: none of
 * these may reach the CLI as an uncoded `Error`, which it publishes as `INTERNAL_ERROR` — a
 * report that VAT has a defect, for a 404.
 */
describe('a url source that cannot be resolved is a coded refusal', () => {
  const REMOTE = 'https://skills.invalid/skill.zip';

  it('a .zip whose sha256 does not match', async () => {
    const error = await rejectionOf(() => resolveUrlSource(pathToFileURL(zipPath).href, 'deadbeef'.repeat(8), ctx));
    expect(error).toMatchObject({ code: SKILL_SOURCE_FETCH_FAILED_CODE, message: expect.stringMatching(/sha256 mismatch/) });
  });

  it('a .zip url with no sha256', async () => {
    const error = await rejectionOf(() => resolveUrlSource(pathToFileURL(zipPath).href, undefined, ctx));
    expect(error).toMatchObject({ code: SKILL_SOURCE_DIGEST_REQUIRED_CODE, message: expect.stringMatching(/requires a sha256/) });
  });

  it('a file:// .zip that is not there is a fault on the source', async () => {
    const error = await rejectionOf(() => resolveUrlSource(pathToFileURL(safePath.join(root, 'absent.zip')).href, zipSha, ctx));
    expect(isFsFaultError(error), error.message).toBe(true);
    expect(error).toMatchObject({ side: 'source', faultClass: 'absent' });
  });

  it('a server that answers with a failure status', async () => {
    stubFetch(new Response('nope', { status: 404 }));
    const error = await rejectionOf(() => resolveUrlSource(REMOTE, zipSha, ctx));
    expect(error).toMatchObject({ code: SKILL_SOURCE_FETCH_FAILED_CODE, message: expect.stringMatching(/HTTP 404/) });
  });

  it('a fetch that times out', async () => {
    stubFetch(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const error = await rejectionOf(() => resolveUrlSource(REMOTE, zipSha, ctx));
    expect(error).toMatchObject({ code: SKILL_SOURCE_FETCH_FAILED_CODE, message: expect.stringMatching(/Timed out fetching/) });
  });

  it('a fetch the network refuses', async () => {
    stubFetch(new TypeError('fetch failed'));
    const error = await rejectionOf(() => resolveUrlSource(REMOTE, zipSha, ctx));
    expect(error).toMatchObject({ code: SKILL_SOURCE_FETCH_FAILED_CODE, message: expect.stringMatching(/fetch failed/) });
  });

  it('a download the server declares larger than the bound, before a byte of it is read', async () => {
    stubFetch(new Response('x', { status: 200, headers: { 'content-length': String(ARCHIVE_DOWNLOAD_MAX_BYTES + 1) } }));
    const error = await rejectionOf(() => resolveUrlSource(REMOTE, zipSha, ctx));
    expect(error).toMatchObject({ code: SKILL_SOURCE_FETCH_FAILED_CODE, message: expect.stringMatching(/larger than/) });
  });

  // The hostile server: it omits `content-length`, or understates it, and keeps sending. Only the
  // count kept while the body is read stops it — one megabyte past the bound, in megabyte chunks.
  it.each([
    ['omits content-length', {}],
    ['understates content-length', { 'content-length': '10' }],
  ])('a download past the bound from a server that %s', async (_what, headers) => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > ARCHIVE_DOWNLOAD_MAX_BYTES) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    stubFetch(new Response(body, { status: 200, headers }));

    const error = await rejectionOf(() => resolveUrlSource(REMOTE, zipSha, ctx));

    expect(error).toMatchObject({ code: SKILL_SOURCE_FETCH_FAILED_CODE, message: expect.stringMatching(/larger than/) });
  });

  it('a file:// .zip larger than the bound, before a byte of it is read', async () => {
    const path = safePath.join(root, 'huge.zip');
    writeFileSync(path, '');
    // Sparse: the size is declared, and no block is written.
    truncateSync(path, ARCHIVE_DOWNLOAD_MAX_BYTES + 1);

    const error = await rejectionOf(() => resolveUrlSource(pathToFileURL(path).href, zipSha, ctx));

    expect(error).toMatchObject({ code: SKILL_SOURCE_FETCH_FAILED_CODE, message: expect.stringMatching(/larger than/) });
  });

  it('bytes that match their digest and are no ZIP archive', async () => {
    const path = safePath.join(root, 'garbage.zip');
    const bytes = Buffer.from('these bytes match their digest and are not an archive');
    writeFileSync(path, bytes);
    const error = await rejectionOf(() => resolveUrlSource(pathToFileURL(path).href, sha256(bytes), ctx));
    expect(error).toMatchObject({ code: ARCHIVE_REFUSED_CODE, reason: 'unreadable' });
  });

  it('every one of these codes names an operator-fixable refusal, never INTERNAL_ERROR', () => {
    expect(SKILL_TEST_REFUSAL_BY_ERROR_CODE[SKILL_SOURCE_FETCH_FAILED_CODE]).toBe('INPUT_UNREADABLE');
    expect(SKILL_TEST_REFUSAL_BY_ERROR_CODE[SKILL_SOURCE_DIGEST_REQUIRED_CODE]).toBe('USAGE_INVALID');
  });
});

/**
 * The `url:` lane of the hostile-archive table every extracting lane runs: an archive fetched
 * over the network is the least trusted input VAT extracts.
 */
/**
 * Registers this suite's lane with the CLI's archive-lane registry (`ARCHIVE_READ_SITES`, in
 * `packages/cli/test/helpers/archive-lane-registry.ts`): its coverage test reads `archiveLane(...)`
 * calls off every package's suites. Declared here because a test does not import another package's tests.
 */
const archiveLane = (id: string): string => id;

describe(`${archiveLane('url: skill source')} — a .zip VAT will not extract`, () => {
  const rows = hostileArchiveRows(ARCHIVE_LIMITS).filter((row) => row.formats.includes('zip'));

  it.each(rows)('refuses one holding $what, staging and caching nothing', async (row) => {
    const { url, sha } = zipAt(`hostile-${rows.indexOf(row)}.zip`, [{ name: 'SKILL.md', data: ZIP_SKILL_BODY }, ...row.entries('')], (archive) => hostileArchive(row, archive));
    const local: ResolveSkillSourceContext = { ...ctx, stagingRoot: safePath.join(root, `staging-${rows.indexOf(row)}`), fetchCacheDir: safePath.join(root, `cache-${rows.indexOf(row)}`) };

    const error = await rejectionOf(() => resolveUrlSource(url, sha, local));

    expect(error).toMatchObject({ code: ARCHIVE_REFUSED_CODE, reason: row.reason });
    // Nothing was staged, and the cache holds no entry — not even a partial one a later resolve could hit.
    expect(existsSync(local.stagingRoot)).toBe(false);
    expect(readdirSync(local.fetchCacheDir)).toEqual([]);
    expect(readdirSync(root)).not.toContain('planted.txt');
  });

  // Not a row of the table: the member is refused when it is read, under its own code, which the CLI
  // maps to INPUT_UNREADABLE (`command-refusal.ts`, pinned for this lane in `archive-hostile-lanes-zip`).
  it('refuses one whose member holds more than it declares, naming the member, staging and caching nothing', async () => {
    const { url, sha } = zipAt('entry-unreadable.zip', [{ name: 'SKILL.md', data: ZIP_SKILL_BODY }, ...entryHoldingMoreThanDeclared('')]);
    const local: ResolveSkillSourceContext = { ...ctx, stagingRoot: safePath.join(root, 'staging-entry'), fetchCacheDir: safePath.join(root, 'cache-entry') };

    const error = await rejectionOf(() => resolveUrlSource(url, sha, local));

    expect(error).toMatchObject({ code: ARCHIVE_ENTRY_UNREADABLE_CODE, entry: 'guide.md' });
    expect(existsSync(local.stagingRoot)).toBe(false);
    expect(readdirSync(local.fetchCacheDir)).toEqual([]);
  });
});
