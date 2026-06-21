import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { ResolveSkillSourceContext, ResolvedSkillSource, SkillSource } from '@vibe-agent-toolkit/agent-skills';
import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { assertSafeHarnessRoot } from './harness-location.js';
import { StagedManifestSchema, type StagedEntry, type StagedManifest } from './manifest.js';

export interface StageItem {
  name: string;
  source: SkillSource;
  /**
   * Marks the primary skill under test. Exactly one item should carry
   * `role: 'subject'`; its staged directory is returned as
   * {@link StageHarnessResult.subjectStagedDir} so the caller can locate the
   * subject's own `evals/evals.json`.
   */
  role?: 'subject';
}

export interface StageHarnessOptions {
  harnessRoot: string;
  items: StageItem[];
  resolve: (source: SkillSource, ctx: ResolveSkillSourceContext) => Promise<ResolvedSkillSource>;
  ctx: ResolveSkillSourceContext;
  currentUid: number;
}

export interface StageHarnessResult {
  manifest: StagedManifest;
  pluginDirs: string[];
  /**
   * Absolute staged directory of the item tagged `role: 'subject'` (the primary
   * skill under test). `null` when no item carried that role. The harness reads
   * the subject's `evals/evals.json` from inside this directory.
   */
  subjectStagedDir: string | null;
}

/**
 * Map a config descriptor onto Plan 1's runtime SkillSource union.
 *
 * Implemented as a CHECKED assignment (no `as`): the config descriptor union and
 * the runtime `SkillSource` union are a pinned cross-plan interface that must stay
 * structurally identical. If either ever drifts, this assignment stops
 * type-checking instead of silently laundering the mismatch through a cast.
 */
export function descriptorToSource(d: SkillSourceDescriptor): SkillSource {
  return d;
}

/**
 * Safe single-segment directory name for a staged item under the harness root.
 *
 * `item.name` may be an absolute or relative path — the subject under test is the
 * positional CLI arg (`vat skill test run <path>`). Using it raw as a path segment
 * (`join(harnessRoot, name)`) is a bug: on Windows an absolute `C:\…` name lands a
 * drive letter mid-path (`…\harness\C:\Users\…`), an invalid path that makes cpSync
 * throw; on POSIX the same join silently produces a wrongly-nested directory.
 * Reduce to the sanitized basename plus a short hash of the full name so the
 * destination is always one valid, collision-free segment (the hash also covers the
 * empty-after-sanitize fallback and disambiguates equal basenames).
 */
export function stagedDirName(name: string): string {
  const slug = basename(toForwardSlash(name)).replaceAll(/[^A-Za-z0-9_-]/g, '_');
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  // Require at least one alphanumeric so an all-separator basename (e.g. '...')
  // falls back to a pure hash rather than a noise segment like '___'.
  return /[A-Za-z0-9]/.test(slug) ? `${slug}-${hash}` : hash;
}

/** Stable content hash of a staged directory tree (sorted relative paths + bytes). */
export function computeDirContentHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string, rel: string): void => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own staged dir
    for (const name of readdirSync(current).sort((a, b) => a.localeCompare(b))) {
      const abs = safePath.join(current, name);
      const childRel = rel ? `${rel}/${name}` : name;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own staged dir
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs, childRel);
      } else {
        hash.update(childRel);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own staged dir
        hash.update(readFileSync(abs));
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

function readExistingManifest(harnessRoot: string): StagedManifest | null {
  const manifestPath = safePath.join(harnessRoot, 'staged.manifest.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own harness root
  if (!existsSync(manifestPath)) return null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own harness root
    return StagedManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch {
    return null; // corrupt/tampered manifest → force a full re-stage
  }
}

export async function stageHarness(opts: StageHarnessOptions): Promise<StageHarnessResult> {
  assertSafeHarnessRoot(opts.harnessRoot, opts.currentUid);
  mkdirSyncReal(opts.harnessRoot, { recursive: true, mode: 0o700 });

  // v1: full re-stage every run. Task 15 wires reconcile-reuse via this return value.
  readExistingManifest(opts.harnessRoot);

  const entries: StagedEntry[] = [];
  const pluginDirs: string[] = [];
  let subjectStagedDir: string | null = null;
  for (const item of opts.items) {
    const resolved = await opts.resolve(item.source, opts.ctx);
    // item.name may be an absolute/relative path (the subject is the positional
    // CLI arg) — never join it raw (drive-letter-mid-path on Windows). Always
    // stage under one sanitized segment. See stagedDirName.
    const dest = safePath.join(opts.harnessRoot, stagedDirName(item.name));
    cpSync(resolved.stagedDir, dest, { recursive: true });
    const contentHash = computeDirContentHash(dest);
    entries.push({ name: item.name, identity: resolved.identity, contentHash });
    pluginDirs.push(dest);
    if (item.role === 'subject') subjectStagedDir = dest;
  }

  const fingerprint = createHash('sha256')
    .update(entries.map(e => `${e.name}:${e.identity}:${e.contentHash}`).join('|'))
    .digest('hex');
  const manifest: StagedManifest = { fingerprint, entries };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own harness root
  writeFileSync(
    safePath.join(opts.harnessRoot, 'staged.manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return { manifest, pluginDirs, subjectStagedDir };
}
