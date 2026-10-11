import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { applyTreePlan, openForReading, planTreeChanges, safePath, withFsFault, withTempDir } from '@vibe-agent-toolkit/utils';
import { ARCHIVE_DOWNLOAD_MAX_BYTES, ARCHIVE_LIMITS, extractArchive } from '@vibe-agent-toolkit/utils/archive';
import { isGitUrl, parseGitUrl } from '@vibe-agent-toolkit/utils/git';

import { withCachedFetch } from '../fetch-cache.js';
import { cloneGitSource } from '../git-clone.js';
import { SkillSourceDigestRequiredError, SkillSourceFetchError } from '../source-errors.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

/** Wall-clock cap on a single network fetch of zip bytes. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Resolve a `{ url, sha256? }` skill source.
 *
 * - Git URL (cloneUrl#ref:subpath): clone via the extracted cloneGitSource into a
 *   cache entry keyed on the WHOLE url (its ref and subpath included) and the
 *   resolved commit; identity is url + commit.
 * - Arbitrary `.zip`: fetch the bytes (bounded), verify the REQUIRED sha256, extract
 *   through the one archive primitive into a cache entry keyed on the sha256;
 *   identity is url + sha256. This is the one genuinely new fetch capability (spec §11a).
 *
 * Every way either can fail is a coded refusal: a clone that did not happen
 * (`GIT_CLONE_FAILED`), a fetch that did not (`SKILL_SOURCE_FETCH_FAILED`), a `.zip`
 * with no digest (`SKILL_SOURCE_DIGEST_REQUIRED`), an archive VAT will not extract
 * (`ARCHIVE_REFUSED`), or a classified filesystem fault.
 */
export function resolveUrlSource(
  url: string,
  sha256: string | undefined,
  ctx: ResolveSkillSourceContext,
): Promise<ResolvedSkillSource> {
  // Check for .zip before isGitUrl: a file:// URL ending in .zip must be
  // handled as a zip fetch, not a git clone — isGitUrl returns true for all
  // file:// URLs regardless of extension.
  if (!isZipUrl(url) && isGitUrl(url)) {
    return resolveGitUrl(url, ctx);
  }
  return resolveZipUrl(url, sha256, ctx);
}

/** True if the URL's path component ends with `.zip` (case-insensitive). */
function isZipUrl(url: string): boolean {
  const withoutFragment = url.split('#')[0] ?? url;
  return withoutFragment.toLowerCase().endsWith('.zip');
}

async function resolveGitUrl(
  url: string,
  ctx: ResolveSkillSourceContext,
): Promise<ResolvedSkillSource> {
  const parsed = parseGitUrl(url);
  // Clone once into a throwaway tempdir to learn the commit, then cache by commit. The tempdir
  // is disposed of however this ends — its content has been staged into the cache by then.
  const { value, leftover } = await withTempDir('vat-url-git-', async (probe) => {
    const { commit, targetDir } = cloneGitSource(parsed, probe);
    // Strip .git metadata from the clone root before staging — consumers should
    // only see skill files, not git internals. VAT's own clone: whatever is there may go.
    await applyTreePlan(await planTreeChanges([{
      op: 'remove',
      dest: safePath.join(probe, '.git'),
      ownership: { kind: 'vat-state' },
      label: 'git metadata of the probe clone',
    }]));
    const identity = `url:${url}:${commit}`;
    // What is cached and staged is the SUBPATH's tree, so the url as written — its ref and
    // subpath included — is the key: two subpaths of one commit are two trees, never one entry.
    const selection = keyForUrl(url);
    const cached = await withCachedFetch({
      cacheDir: ctx.fetchCacheDir,
      digest: commit,
      key: selection,
      ...(ctx.refresh === undefined ? {} : { refresh: ctx.refresh }),
      fetchInto: async (dir) => {
        await stageDirInto(targetDir, { ...ctx, stagingRoot: dir }, '.');
      },
      verify: async () => {
        // git identity IS the commit SHA; no separate digest re-check needed.
      },
    });
    const stagedDir = await stageDirInto(cached, ctx, `url-git-${commit}-${selection.slice(0, 16)}`);
    return { stagedDir, identity };
  });
  return { ...value, leftovers: leftover === undefined ? [] : [leftover] };
}

async function resolveZipUrl(
  url: string,
  sha256: string | undefined,
  ctx: ResolveSkillSourceContext,
): Promise<ResolvedSkillSource> {
  if (sha256 === undefined) {
    throw new SkillSourceDigestRequiredError(url);
  }
  const cached = await withCachedFetch({
    cacheDir: ctx.fetchCacheDir,
    digest: sha256,
    key: keyForUrl(url),
    ...(ctx.refresh === undefined ? {} : { refresh: ctx.refresh }),
    fetchInto: async (dir) => {
      const bytes = await fetchBytes(url);
      const actual = sha256Of(bytes);
      if (actual !== sha256) {
        throw new SkillSourceFetchError(
          `sha256 mismatch for ${url}: expected ${sha256}, got ${actual} (integrity check failed).`,
        );
      }
      await extractArchive({ bytes, label: url }, dir, { format: 'zip', limits: ARCHIVE_LIMITS });
    },
    verify: async (_dir) => {
      // On a cache hit, trust the digest-keyed extraction (key already includes the sha256).
    },
  });
  const stagedDir = await stageDirInto(cached, ctx, `url-zip-${sha256}`);
  return { stagedDir, identity: `url:${url}:${sha256}`, leftovers: [] };
}

/** The refusal of a download past {@link ARCHIVE_DOWNLOAD_MAX_BYTES}. */
function downloadTooLarge(url: string): SkillSourceFetchError {
  return new SkillSourceFetchError(`${url} is larger than ${ARCHIVE_DOWNLOAD_MAX_BYTES} bytes, the most VAT downloads for a skill source.`);
}

/**
 * The body of a successful response, read chunk by chunk and refused the moment it passes the
 * download bound — a server that never stops sending is never held in memory.
 */
async function boundedBody(url: string, response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > ARCHIVE_DOWNLOAD_MAX_BYTES) throw downloadTooLarge(url);
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    received += chunk.byteLength;
    if (received > ARCHIVE_DOWNLOAD_MAX_BYTES) throw downloadTooLarge(url);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The bytes of a `file://` source, held to the same bound a download is: sized on the handle it
 * is then read through (opened without blocking — a named pipe is refused, never waited on),
 * before a byte is read.
 */
async function boundedFile(url: string, file: string): Promise<Buffer> {
  const handle = await openForReading(file);
  try {
    if ((await handle.stat()).size > ARCHIVE_DOWNLOAD_MAX_BYTES) throw downloadTooLarge(url);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Read the raw bytes of a URL, bounded in size whichever it is. `file://` reads from disk (a read
 * the OS refuses is a `source` fault); `http(s)://` via fetch, bounded in time too.
 *
 * @throws SkillSourceFetchError for a fetch that failed, timed out, answered with a failure
 *   status, or sent more than the download bound
 */
async function fetchBytes(url: string): Promise<Buffer> {
  if (url.startsWith('file://')) {
    const file = fileURLToPath(url);
    return await withFsFault({ side: 'source', origin: 'argument', action: `read the skill source ${url}`, path: file }, () => boundedFile(url, file));
  }
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error: unknown) {
    throw fetchFailure(url, error);
  }
  if (!response.ok) {
    throw new SkillSourceFetchError(`Failed to fetch ${url}: HTTP ${response.status.toString()}.`);
  }
  try {
    return await boundedBody(url, response);
  } catch (error: unknown) {
    throw fetchFailure(url, error);
  }
}

/** What a fetch of `url` threw, as the source's refusal; one that already is comes back as it is. */
function fetchFailure(url: string, error: unknown): SkillSourceFetchError {
  if (error instanceof SkillSourceFetchError) return error;
  const said = error instanceof Error ? error.message : String(error);
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  return new SkillSourceFetchError(
    timedOut ? `Timed out fetching ${url} after ${(FETCH_TIMEOUT_MS / 1000).toString()}s.` : `Failed to fetch ${url}: ${said}.`,
    { cause: error },
  );
}

/**
 * Derive a filesystem-safe, collision-resistant cache key from the FULL url
 * (host + path, and for a git url its `#ref:subpath`), not its basename.
 * `github.com/a/skill.git` and `gitlab.com/b/skill.git` share the basename
 * `skill.git`; hashing the whole url keeps their cache entries distinct so a hit
 * never serves the wrong tree.
 */
function keyForUrl(url: string): string {
  return sha256Of(Buffer.from(url, 'utf-8'));
}

/** Re-export so unit tests / callers can compute a zip digest the same way. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
