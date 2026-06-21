import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { ResolveSkillSourceContext, ResolvedSkillSource, SkillSource } from '@vibe-agent-toolkit/agent-skills';
import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { assertSafeHarnessRoot } from './harness-location.js';
import { StagedManifestSchema, type StagedEntry, type StagedManifest } from './manifest.js';
import type { PluginLayout } from './plugin-layout.js';

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
  /**
   * Present when this skill's TRUE source dir lives inside a Claude plugin
   * (detected via {@link detectPluginLayout}). When set, the item is staged under
   * its real plugin-root layout — the plugin's `.claude-plugin/` is copied and the
   * skill is nested at `<pluginStageRoot>/<relPathUnderPlugin>/` — so that the
   * harness mirrors a real plugin install and `${CLAUDE_PLUGIN_ROOT}/skills/<name>`
   * paths in the skill's own code resolve. Absent → flat staging (standalone skill).
   */
  pluginLayout?: PluginLayout;
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
   * the subject's `evals/evals.json` from inside this directory. For a
   * plugin-distributed subject this points at the NESTED skill dir
   * (`<pluginStageRoot>/<relPathUnderPlugin>`), not the plugin root.
   */
  subjectStagedDir: string | null;
  /**
   * Absolute staged PLUGIN ROOT of the subject when the subject is
   * plugin-distributed (the dir holding `.claude-plugin/`). The caller exports it
   * as `CLAUDE_PLUGIN_ROOT` so the harness mirrors a real plugin install. `null`
   * when the subject is standalone (no plugin layout) or absent.
   */
  subjectPluginRoot: string | null;
}

/**
 * Stage a single item's resolved contents into the harness, choosing flat vs
 * plugin-root layout. Returns the staged dirs that callers care about:
 *   - `pluginDir`  → pushed to `--plugin-dir` (the plugin root for plugin skills,
 *                    else the flat skill dir).
 *   - `skillDir`   → where the skill's own files (incl. evals/) actually live.
 *   - `pluginRoot` → the staged plugin root, or null for a standalone skill.
 */
function stageOneItem(
  harnessRoot: string,
  item: StageItem,
  resolvedStagedDir: string,
): { pluginDir: string; skillDir: string; pluginRoot: string | null } {
  if (item.pluginLayout === undefined) {
    // Standalone: flat dest, exactly as before. item.name may be an absolute path
    // (the positional CLI arg) — never join it raw. See stagedDirName.
    const dest = safePath.joinUnderRoot(harnessRoot, stagedDirName(item.name));
    // v1 re-stages fully every run; wipe dest first so each re-stage is a clean
    // mirror of source (a stale staged evals/evals.json must not survive).
    rmSync(dest, { recursive: true, force: true });
    cpSync(resolvedStagedDir, dest, { recursive: true });
    return { pluginDir: dest, skillDir: dest, pluginRoot: null };
  }

  // Plugin-distributed: recreate the real plugin-root layout so the harness
  // mirrors a real install. The plugin name (basename of the real plugin dir)
  // becomes the single sanitized staged segment. `realPluginDir` is a READ source
  // (the true on-disk plugin), not a write-containment root — hence safePath.join,
  // not joinUnderRoot; only the staging DESTS below use joinUnderRoot.
  const { pluginRoot: realPluginDir, relPathUnderPlugin } = item.pluginLayout;
  const pluginName = basename(toForwardSlash(realPluginDir));
  const pluginStageRoot = safePath.joinUnderRoot(harnessRoot, stagedDirName(pluginName));
  rmSync(pluginStageRoot, { recursive: true, force: true });

  // Copy the plugin's manifest dir (`.claude-plugin/`) from the REAL source so the
  // staged tree is recognized as a plugin.
  const realManifestDir = safePath.join(realPluginDir, '.claude-plugin');
  const stagedManifestDir = safePath.joinUnderRoot(pluginStageRoot, '.claude-plugin');
  mkdirSyncReal(stagedManifestDir, { recursive: true });
  cpSync(realManifestDir, stagedManifestDir, { recursive: true });

  // Copy the skill contents (the resolved flat copy) INTO the nested skill slot so
  // `${pluginStageRoot}/skills/<name>/...` resolves like a real install.
  const stagedSkillDir = safePath.joinUnderRoot(pluginStageRoot, relPathUnderPlugin);
  mkdirSyncReal(stagedSkillDir, { recursive: true });
  cpSync(resolvedStagedDir, stagedSkillDir, { recursive: true });

  return { pluginDir: pluginStageRoot, skillDir: stagedSkillDir, pluginRoot: pluginStageRoot };
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
  const manifestPath = safePath.joinUnderRoot(harnessRoot, 'staged.manifest.json');
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
  let subjectPluginRoot: string | null = null;
  for (const item of opts.items) {
    const resolved = await opts.resolve(item.source, opts.ctx);
    // Stage flat (standalone) or under the real plugin-root layout (plugin skill).
    const { pluginDir, skillDir, pluginRoot } = stageOneItem(opts.harnessRoot, item, resolved.stagedDir);
    // Content-hash the staged plugin dir (the whole thing pushed to --plugin-dir),
    // so a change to the plugin manifest OR the skill body invalidates the entry.
    const contentHash = computeDirContentHash(pluginDir);
    entries.push({ name: item.name, identity: resolved.identity, contentHash });
    pluginDirs.push(pluginDir);
    if (item.role === 'subject') {
      subjectStagedDir = skillDir;
      subjectPluginRoot = pluginRoot;
    }
  }

  const fingerprint = createHash('sha256')
    .update(entries.map(e => `${e.name}:${e.identity}:${e.contentHash}`).join('|'))
    .digest('hex');
  const manifest: StagedManifest = { fingerprint, entries };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own harness root
  writeFileSync(
    safePath.joinUnderRoot(opts.harnessRoot, 'staged.manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return { manifest, pluginDirs, subjectStagedDir, subjectPluginRoot };
}
