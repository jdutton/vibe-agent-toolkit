import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { applyTreePlan, planTreeChanges, safePath, withTempDir } from '@vibe-agent-toolkit/utils';
import { isGitUrl, parseGitUrl } from '@vibe-agent-toolkit/utils/git';

import { withCachedFetch } from '../fetch-cache.js';
import { cloneGitSource } from '../git-clone.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

/** Wall-clock cap on a single network fetch of zip bytes. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Resolve a `{ url, sha256? }` skill source.
 *
 * - Git URL (cloneUrl#ref:subpath): clone via the extracted cloneGitSource into a
 *   cache entry keyed on the resolved commit; identity is url + commit.
 * - Arbitrary `.zip`: fetch the bytes, verify the REQUIRED sha256, extract into a
 *   cache entry keyed on the sha256; identity is url + sha256. This is the one
 *   genuinely new fetch capability (spec §11a).
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
    const cached = await withCachedFetch({
      cacheDir: ctx.fetchCacheDir,
      digest: commit,
      key: keyForUrl(parsed.cloneUrl),
      ...(ctx.refresh === undefined ? {} : { refresh: ctx.refresh }),
      fetchInto: async (dir) => {
        await stageDirInto(targetDir, { ...ctx, stagingRoot: dir }, '.');
      },
      verify: async () => {
        // git identity IS the commit SHA; no separate digest re-check needed.
      },
    });
    const stagedDir = await stageDirInto(cached, ctx, `url-git-${commit}`);
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
    throw new Error(`url skill source '${url}' is a .zip and requires a sha256 integrity digest.`);
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
        throw new Error(
          `sha256 mismatch for ${url}: expected ${sha256}, got ${actual} (integrity check failed).`,
        );
      }
      await extractZipBytes(bytes, dir);
    },
    verify: async (_dir) => {
      // On a cache hit, trust the digest-keyed extraction (key already includes the sha256).
    },
  });
  const stagedDir = await stageDirInto(cached, ctx, `url-zip-${sha256}`);
  return { stagedDir, identity: `url:${url}:${sha256}`, leftovers: [] };
}

/** Read the raw bytes of a URL. `file://` reads from disk; `http(s)://` via fetch. */
async function fetchBytes(url: string): Promise<Buffer> {
  if (url.startsWith('file://')) {
    const { fileURLToPath } = await import('node:url');
    return readFileSync(fileURLToPath(url));
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Timed out fetching ${url} after ${(FETCH_TIMEOUT_MS / 1000).toString()}s.`,
      );
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status.toString()}.`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Extract a zip's bytes into `dir` using adm-zip (already a dependency). */
async function extractZipBytes(bytes: Buffer, dir: string): Promise<void> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  zip.extractAllTo(dir, /* overwrite */ true);
}

/**
 * Derive a filesystem-safe, collision-resistant cache key from the FULL url
 * (host + path), not its basename. `github.com/a/skill.git` and
 * `gitlab.com/b/skill.git` share the basename `skill.git`; hashing the whole url
 * keeps their cache entries distinct so a hit never serves the wrong tree.
 */
function keyForUrl(url: string): string {
  return sha256Of(Buffer.from(url, 'utf-8'));
}

/** Re-export so unit tests / callers can compute a zip digest the same way. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
