import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { SkillSourceDescriptor } from '@vibe-agent-toolkit/resources';
import {
  applyTreePlan,
  copyTree,
  forEachInOrder,
  planTreeChanges,
  proveTreeReadable,
  recordSuppressedFault,
  safePath,
  suppressedFaultsOf,
  toForwardSlashAnyPlatform,
  withFsFault,
  withFsFaultSync,
} from '@vibe-agent-toolkit/utils';
import { ZodError } from 'zod';

import type {
  ResolveSkillSourceContext,
  ResolvedSkillSource,
  SkillSource,
} from '../skill-source/types.js';

import { DEFAULT_EVALS_SUBPATH, isolateEvalSuite } from './eval-suite-isolation.js';
import { assertSafeHarnessRoot, createHarnessRoot } from './harness-location.js';
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
  /**
   * Marks a `--with-optional` companion: when this item's `resolve` (or the
   * subsequent staging of its resolved contents) throws, `stageHarness` SKIPS it
   * — with the name recorded in {@link StageHarnessResult.skippedOptional} — rather
   * than failing the whole run. Absent (required, including the subject and every
   * `--with` companion) means a throw propagates and fails the run.
   */
  optional?: true;
}

export interface StageHarnessOptions {
  harnessRoot: string;
  items: StageItem[];
  resolve: (source: SkillSource, ctx: ResolveSkillSourceContext) => Promise<ResolvedSkillSource>;
  ctx: ResolveSkillSourceContext;
  currentUid: number;
  /**
   * Suite subpath (e.g. `evals/evals.json`) whose contents are stripped from EVERY
   * item's resolved copy before it is staged onward or hashed — the eval answer key
   * must never reach the executor's filesystem. See {@link isolateEvalSuite}.
   *
   * Optional: `undefined` means this run declares no eval suite at all, which is a
   * clean no-op (nothing to strip) rather than a runtime accident — the real
   * production caller (`run-harness.ts`) always defaults this to
   * `evals/evals.json` before calling in, but the type must not pretend the value
   * can never be absent, since nothing upstream is contractually obligated to
   * default it.
   */
  evalsSubpath?: string;
  /**
   * vat-only directory OUTSIDE the harness root. When the SUBJECT's resolved copy
   * carries the suite (a fetched npm/url/vendored artifact, or a source tree that
   * holds its own evals), it is relocated here so the harness can still read it
   * while the executor cannot. Left empty when the subject carried no suite.
   *
   * OMIT IT when the run will read the suite from the AUTHORED source instead —
   * the strip out of the staged tree still happens, but no copy is written. A
   * held copy the run never reads is a second copy of the answer key in the
   * shared OS temp dir, bought for nothing; the caller owns that decision because
   * it is the one that resolves the read path.
   */
  evalSuiteHoldDir?: string;
}

/** One `--with-optional` companion that did not stage, and the reason it did not. */
export interface SkippedOptionalItem {
  name: string;
  /** The message of whatever `resolve`/staging threw. */
  reason: string;
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
  /**
   * `--with-optional` items that were SKIPPED because resolving or staging them
   * threw (unresolvable source, build failure, etc.), each with the error's
   * message so the warning can say WHY. Empty when every optional item staged
   * cleanly, or when there were none. A required item (subject or `--with`) that
   * throws is never recorded here — it propagates and fails the whole run instead.
   */
  skippedOptional: SkippedOptionalItem[];
  /**
   * True when the SUBJECT's resolved copy carried an eval suite, which was
   * therefore relocated into `evalSuiteHoldDir` (and removed from everything the
   * executor can reach). The harness reads the suite from there ONLY when no
   * authored source copy exists — an authored suite always wins, so editing it is
   * what a re-run picks up.
   */
  subjectEvalSuiteHeld: boolean;
  /**
   * What resolving the items left behind once each was resolved: every
   * {@link ResolvedSkillSource.leftovers} entry, in item order — a skipped optional item's
   * included, since its resolution ran. The harness reports each as a warning beside its result.
   */
  leftovers: unknown[];
}

/**
 * Replace the harness entry `dest` with what `fill` writes into a staged directory beside it,
 * in one swap. The harness is VAT's own: whatever a previous run left there goes.
 */
async function replaceStaged(dest: string, label: string, fill: (staged: string) => Promise<void>): Promise<void> {
  await applyTreePlan(await planTreeChanges([{ op: 'replace', dest, ownership: { kind: 'vat-state' }, fill: { from: 'write', write: fill }, label }]));
}

/** Copy a resolved skill copy — VAT's own staging, symlink-free — to `relative` under `root`: its reads are the environment's. */
function copyResolved(resolvedStagedDir: string, root: string, relative: string): Promise<void> {
  return copyTree(resolvedStagedDir, root, relative, { links: 'preserve', side: 'environment', onto: 'fresh' });
}

/**
 * Stage a single item's resolved contents into the harness, choosing flat vs
 * plugin-root layout. Returns the staged dirs that callers care about:
 *   - `pluginDir`  → pushed to `--plugin-dir` (the plugin root for plugin skills,
 *                    else the flat skill dir).
 *   - `skillDir`   → where the skill's own files (incl. evals/) actually live.
 *   - `pluginRoot` → the staged plugin root, or null for a standalone skill.
 *
 * `preparedPluginRoots` tracks which staged plugin roots have already been wiped
 * and had their `.claude-plugin/` manifest copied in this `stageHarness` run. When
 * two items share the same on-disk plugin the root is prepared exactly ONCE; later
 * items skip the replace so already-staged sibling skill dirs survive.
 */
async function stageOneItem(
  harnessRoot: string,
  item: StageItem,
  resolvedStagedDir: string,
  preparedPluginRoots: Set<string>,
): Promise<{ pluginDir: string; skillDir: string; pluginRoot: string | null }> {
  if (item.pluginLayout === undefined) {
    // Standalone: flat dest, exactly as before. item.name may be an absolute path
    // (the positional CLI arg) — never join it raw. See stagedDirName.
    const dest = safePath.joinUnderRoot(harnessRoot, stagedDirName(item.name));
    // v1 re-stages fully every run; the copy REPLACES dest so each re-stage is a clean
    // mirror of source (a stale staged evals/evals.json must not survive).
    await replaceStaged(dest, `staged copy of ${item.name}`, (staged) => copyResolved(resolvedStagedDir, staged, ''));
    return { pluginDir: dest, skillDir: dest, pluginRoot: null };
  }

  // Plugin-distributed: recreate the real plugin-root layout so the harness
  // mirrors a real install. `realPluginDir` is a READ source (the true on-disk
  // plugin), not a write-containment root — hence safePath.join, not joinUnderRoot;
  // only the staging DESTS below use joinUnderRoot.
  const { pluginRoot: realPluginDir, relPathUnderPlugin } = item.pluginLayout;
  // Key the staged plugin-root segment on the FULL resolved plugin path, not just
  // its basename: two different `--with` plugins that share a directory basename
  // (…/a/my-plugin and …/b/my-plugin) must not collide onto ONE staged root and
  // silently cross-wire CLAUDE_PLUGIN_ROOT / the manifest into a misleading result.
  // stagedDirName keeps the basename as the readable slug and disambiguates on a
  // hash of the full path, so equal basenames from distinct dirs stay distinct.
  const pluginStageRoot = safePath.joinUnderRoot(harnessRoot, stagedDirName(realPluginDir));

  if (!preparedPluginRoots.has(pluginStageRoot)) {
    // First item for this plugin root in this stageHarness run: wipe the stale
    // staged tree (clean re-stage) and copy the plugin's manifest dir so the
    // staged tree is recognized as a plugin.
    const realManifestDir = safePath.join(realPluginDir, '.claude-plugin');
    // The manifest dir is the author's: prove it readable first (a `source` fault), so a
    // file the OS will not read there is never coded as the run's output failing.
    await proveTreeReadable(realManifestDir, { links: 'preserve', side: 'source' });
    await replaceStaged(pluginStageRoot, 'staged plugin root', (staged) =>
      copyTree(realManifestDir, staged, '.claude-plugin', { links: 'preserve', side: 'source', onto: 'fresh' }));
    preparedPluginRoots.add(pluginStageRoot);
  }

  // Copy the skill contents (the resolved flat copy) INTO the nested skill slot so
  // `${pluginStageRoot}/skills/<name>/...` resolves like a real install.
  const stagedSkillDir = safePath.joinUnderRoot(pluginStageRoot, relPathUnderPlugin);
  // The staged root already holds the author's manifest directory, links kept: the copy names the
  // root and the slot under it, so the slot is made component by component, never through one of them.
  await withFsFault({ side: 'destination', action: `write the staged copy of ${item.name} at ${stagedSkillDir}` }, () =>
    copyResolved(resolvedStagedDir, pluginStageRoot, safePath.relative(pluginStageRoot, stagedSkillDir)));

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
  const slug = basename(toForwardSlashAnyPlatform(name)).replaceAll(/[^A-Za-z0-9_-]/g, '_');
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  // Require at least one alphanumeric so an all-separator basename (e.g. '...')
  // falls back to a pure hash rather than a noise segment like '___'.
  return /[A-Za-z0-9]/.test(slug) ? `${slug}-${hash}` : hash;
}

/** Stable content hash of a staged directory tree (sorted relative paths + bytes). */
export function computeDirContentHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string, rel: string): void => {
    for (const name of readdirSync(current).sort((a, b) => a.localeCompare(b))) {
      const abs = safePath.join(current, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs, childRel);
      } else {
        hash.update(childRel);
        hash.update(readFileSync(abs));
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

function readExistingManifest(harnessRoot: string): StagedManifest | null {
  const manifestPath = safePath.joinUnderRoot(harnessRoot, 'staged.manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return StagedManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    // Corrupt or tampered (not JSON, or JSON of the wrong shape) → null, which
    // forces a full re-stage. A manifest vat could not READ is neither: the
    // harness root is vat's own 0700 dir, and a refusal there is a problem the
    // next write would hit anyway — let it surface with its errno.
    if (error instanceof SyntaxError || error instanceof ZodError) return null;
    throw error;
  }
}

export async function stageHarness(opts: StageHarnessOptions): Promise<StageHarnessResult> {
  assertSafeHarnessRoot(opts.harnessRoot, opts.currentUid);
  createHarnessRoot(opts.harnessRoot);

  // v1: full re-stage every run. Task 15 wires reconcile-reuse via this return value.
  readExistingManifest(opts.harnessRoot);

  const entries: StagedEntry[] = [];
  const pluginDirs: string[] = [];
  const skippedOptional: SkippedOptionalItem[] = [];
  const leftovers: unknown[] = [];
  let subjectStagedDir: string | null = null;
  let subjectPluginRoot: string | null = null;
  let subjectEvalSuiteHeld = false;
  // Track which staged plugin roots have been prepared (wiped + manifest copied) this
  // run so that sibling skills sharing the same plugin don't clobber each other.
  const preparedPluginRoots = new Set<string>();

  // Strip the eval suite from an item's resolved copy BEFORE it is staged onward or
  // content-hashed — the answer key must never reach the executor's filesystem. The
  // SUBJECT's suite is relocated to the vat-only hold dir first, but ONLY when the
  // caller asked for that (`evalSuiteHoldDir` given) — i.e. when the suite exists
  // nowhere else and the run has to read it back. Every other item's, and the
  // subject's when an authored copy already exists, is simply removed. See
  // eval-suite-isolation.ts for the full rationale.
  const stripEvalSuite = async (stagedDir: string, role: StageItem['role']): Promise<boolean> => {
    const preserved = await isolateEvalSuite({
      stagedDir,
      stagingRoot: opts.ctx.stagingRoot,
      evalsSubpath: opts.evalsSubpath,
      ...(role === 'subject' && opts.evalSuiteHoldDir !== undefined
        ? { holdDir: opts.evalSuiteHoldDir }
        : {}),
    });
    // When the run reads its suite from somewhere OTHER than the convention, the
    // conventional location must be stripped too. A suite this run is not grading
    // is still an answer key for this same skill, sitting in the executor's
    // working directory — the invariant is "the executor's filesystem holds no
    // answer key", not "…none for the suite we happen to be grading". The strip
    // target used to BE the read target, so naming an out-of-tree suite disabled
    // the strip entirely: nothing inside the skill matched an absolute path.
    //
    // Scoped to a DECLARED-but-different suite on purpose. `evalsSubpath:
    // undefined` means the caller declared no suite for this run at all, which is
    // a documented no-op that must keep its opt-out; and when the configured path
    // IS the convention the first call already removed it. Never held — the hold
    // dir is for the suite being graded.
    if (opts.evalsSubpath !== undefined && opts.evalsSubpath !== DEFAULT_EVALS_SUBPATH) {
      await isolateEvalSuite({
        stagedDir,
        stagingRoot: opts.ctx.stagingRoot,
        evalsSubpath: DEFAULT_EVALS_SUBPATH,
      });
    }
    return preserved;
  };
  // In order: every resolver stages into one root, and a required item fails closed in order.
  await forEachInOrder(opts.items, async (item) => {
    // A `--with-optional` companion degrades to skip-with-warning on ANY failure
    // resolving or staging it (unresolvable source, build failure, etc.) — it must
    // never take down a run whose subject and required `--with` companions are
    // otherwise fine. The failure is CARRIED into the result, not dropped: the
    // warning names the reason, so an unresolvable source and a bug in the
    // resolver do not both read as "not staged". A required item (subject or
    // `--with`) still fails closed: its throw propagates unchanged.
    if (item.optional === true) {
      try {
        const resolved = await opts.resolve(item.source, opts.ctx);
        leftovers.push(...resolved.leftovers);
        await stripEvalSuite(resolved.stagedDir, item.role);
        // An optional item is never the subject, so only `pluginDir` (pushed to
        // --plugin-dir) is needed here — skillDir/pluginRoot only matter for the
        // subject's own dir, tracked below.
        const { pluginDir } = await stageOneItem(opts.harnessRoot, item, resolved.stagedDir, preparedPluginRoots);
        const contentHash = computeDirContentHash(pluginDir);
        entries.push({ name: item.name, identity: resolved.identity, contentHash });
        pluginDirs.push(pluginDir);
      } catch (error) {
        skippedOptional.push({ name: item.name, reason: error instanceof Error ? error.message : String(error) });
        // What the failed item could not clean up is still on disk: the skip keeps it for the run to report.
        leftovers.push(...suppressedFaultsOf(error));
      }
      return;
    }

    const resolved = await opts.resolve(item.source, opts.ctx);
    leftovers.push(...resolved.leftovers);
    if (await stripEvalSuite(resolved.stagedDir, item.role)) subjectEvalSuiteHeld = true;
    // Stage flat (standalone) or under the real plugin-root layout (plugin skill).
    const { pluginDir, skillDir, pluginRoot } = await stageOneItem(opts.harnessRoot, item, resolved.stagedDir, preparedPluginRoots);
    // Content-hash the staged plugin dir (the whole thing pushed to --plugin-dir),
    // so a change to the plugin manifest OR the skill body invalidates the entry.
    const contentHash = computeDirContentHash(pluginDir);
    entries.push({ name: item.name, identity: resolved.identity, contentHash });
    pluginDirs.push(pluginDir);
    if (item.role === 'subject') {
      subjectStagedDir = skillDir;
      subjectPluginRoot = pluginRoot;
    }
  }).catch((error: unknown) => {
    // No result will carry what earlier items left behind, so it rides the throw (`suppressedFaultsOf`).
    for (const leftover of leftovers) recordSuppressedFault(error, leftover);
    throw error;
  });

  const fingerprint = createHash('sha256')
    .update(entries.map(e => `${e.name}:${e.identity}:${e.contentHash}`).join('|'))
    .digest('hex');
  const manifest: StagedManifest = { fingerprint, entries };
  const manifestPath = safePath.joinUnderRoot(opts.harnessRoot, 'staged.manifest.json');
  withFsFaultSync({ side: 'destination', action: `write the staged manifest ${manifestPath}` }, () => {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  });

  return { manifest, pluginDirs, subjectStagedDir, subjectPluginRoot, skippedOptional, subjectEvalSuiteHeld, leftovers };
}
