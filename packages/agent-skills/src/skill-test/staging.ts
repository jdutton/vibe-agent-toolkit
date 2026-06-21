import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

import type { ResolveSkillSourceContext, ResolvedSkillSource, SkillSource } from '@vibe-agent-toolkit/agent-skills';
import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

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

/** Map a config descriptor onto Plan 1's runtime SkillSource union. */
export function descriptorToSource(d: SkillSourceDescriptor): SkillSource {
  return d as SkillSource; // shapes are structurally identical (see Task 1)
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
    const dest = safePath.join(opts.harnessRoot, item.name);
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
