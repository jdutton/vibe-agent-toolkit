import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';

import { isGitUrl, normalizedTmpdir, parseGitUrl, safePath } from '@vibe-agent-toolkit/utils';

import { withCachedFetch } from '../fetch-cache.js';
import { cloneGitSource } from '../git-clone.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

/**
 * Resolve a `{ url, sha256? }` skill source.
 *
 * - Git URL (cloneUrl#ref:subpath): clone via the extracted cloneGitSource into a
 *   cache entry keyed on the resolved commit; identity is url + commit.
 * - Arbitrary `.zip`: fetch the bytes, verify the REQUIRED sha256, extract into a
 *   cache entry keyed on the sha256; identity is url + sha256. This is the one
 *   genuinely new fetch capability (spec §11a).
 */
export async function resolveUrlSource(
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
  // Clone once into a throwaway tempdir to learn the commit, then cache by commit.
  const probe = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-url-git-'));
  try {
    const { commit, targetDir } = cloneGitSource(parsed, probe);
    // Strip .git metadata from the clone root before staging — consumers should
    // only see skill files, not git internals.
    await rm(safePath.join(probe, '.git'), { recursive: true, force: true });
    const identity = `url:${url}:${commit}`;
    const cached = await withCachedFetch({
      cacheDir: ctx.fetchCacheDir,
      digest: commit,
      key: sanitizeKey(parsed.cloneUrl),
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
  } finally {
    // Always clean up the probe tempdir — content has been staged into the cache.
    await rm(probe, { recursive: true, force: true });
  }
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
    key: sanitizeKey(url),
    ...(ctx.refresh === undefined ? {} : { refresh: ctx.refresh }),
    fetchInto: async (dir) => {
      const bytes = await fetchBytes(url);
      const actual = createHash('sha256').update(bytes).digest('hex');
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
  return { stagedDir, identity: `url:${url}:${sha256}` };
}

/** Read the raw bytes of a URL. `file://` reads from disk; `http(s)://` via fetch. */
async function fetchBytes(url: string): Promise<Buffer> {
  if (url.startsWith('file://')) {
    const { fileURLToPath } = await import('node:url');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- file:// URL provided by config
    return readFileSync(fileURLToPath(url));
  }
  const res = await fetch(url);
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

/** Reduce a URL to a filesystem-safe key segment. */
function sanitizeKey(url: string): string {
  return basename(url).replaceAll(/[^A-Za-z0-9._-]/g, '_') || 'url';
}

/** Re-export so unit tests / callers can compute a zip digest the same way. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
