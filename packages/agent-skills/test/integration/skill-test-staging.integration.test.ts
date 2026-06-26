import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeReconcilePlan, StagedManifestSchema } from '../../src/skill-test/manifest.js';
import type { PluginLayout } from '../../src/skill-test/plugin-layout.js';
import { descriptorToSource, stageHarness, type StageItem } from '../../src/skill-test/staging.js';

/** Shared relative source spec for the fake resolver (one literal, many uses). */
const SUBJECT_SRC = '../subject';

/** The plugin-manifest dir name (one literal, asserted in several tests). */
const CLAUDE_PLUGIN_DIR = '.claude-plugin';

/** The plugin manifest filename (one literal, asserted in several tests). */
const PLUGIN_JSON = 'plugin.json';

/**
 * Build a real on-disk plugin tree (the TRUE source) under `srcRoot` so
 * plugin-layout staging has a `.claude-plugin/` dir to copy. Returns the layout
 * VAT would detect plus the rel path used to assert the staged nesting.
 */
function makeRealPlugin(srcRoot: string, pluginName: string, skillName: string): {
  pluginRoot: string;
  relPathUnderPlugin: string;
  layout: PluginLayout;
} {
  const pluginRoot = safePath.join(srcRoot, pluginName);
  const cp = safePath.join(pluginRoot, CLAUDE_PLUGIN_DIR);
  mkdirSyncReal(cp, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp src
  writeFileSync(safePath.join(cp, PLUGIN_JSON), `{"name":"${pluginName}"}\n`, 'utf8');
  const relPathUnderPlugin = `skills/${skillName}`;
  return { pluginRoot, relPathUnderPlugin, layout: { pluginRoot, relPathUnderPlugin } };
}

// Fake resolver: materializes each source into a fresh dir with a marker file
// whose content == the source identity, so contentHash is observable.
function makeFakeResolver(srcRoot: string) {
  return async (source: { path?: string; workspace?: string }) => {
    const id = source.path ?? source.workspace ?? 'x';
    const dir = safePath.join(srcRoot, id.replaceAll(/[^a-z0-9]/gi, '_'));
    mkdirSyncReal(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fake resolver creates test fixture files
    writeFileSync(safePath.join(dir, 'SKILL.md'), `# ${id}\n`, 'utf8');
    return { stagedDir: dir, identity: `id-${id}` };
  };
}

// Stage a single fake-resolved subject item under the given harness root.
function stageFakeSubject(root: string, srcRoot: string, uid: number, name: string) {
  const items: StageItem[] = [
    { name, source: descriptorToSource({ path: SUBJECT_SRC }), role: 'subject' },
  ];
  return stageHarness({
    harnessRoot: root,
    items,
    resolve: makeFakeResolver(srcRoot) as never,
    ctx: {} as never,
    currentUid: uid,
  });
}

describe('stageHarness (integration)', () => {
  let root: string;
  let srcRoot: string;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;

  beforeEach(() => {
    root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-stage-'));
    srcRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-src-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(srcRoot, { recursive: true, force: true });
  });

  it('stages declared items, writes a content-bound manifest, returns one plugin dir per item', async () => {
    const items: StageItem[] = [
      { name: 'subject', source: descriptorToSource({ path: SUBJECT_SRC }) },
      { name: 'skill-creator', source: descriptorToSource({ vendored: true }) },
    ];
    const result = await stageHarness({
      harnessRoot: root,
      items,
      resolve: makeFakeResolver(srcRoot) as never,
      ctx: {} as never,
      currentUid: uid,
    });
    expect(result.pluginDirs).toHaveLength(2);
    const onDisk = StagedManifestSchema.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading test harness manifest from our own tmp root
      JSON.parse(readFileSync(safePath.join(root, 'staged.manifest.json'), 'utf8')),
    );
    expect(onDisk.entries.map(e => e.name).sort((a, b) => a.localeCompare(b))).toEqual(['skill-creator', 'subject']);
    expect(onDisk.entries.every(e => e.contentHash.length > 0)).toBe(true);
  });

  it('reduces an absolute-path item name to a single safe child of the harness root (Windows-safe)', async () => {
    // Regression (issue #132 Windows CI): the subject under test is the positional
    // CLI arg — an ABSOLUTE path. Joining it raw onto the harness root put a drive
    // letter mid-path on Windows (…\harness\C:\Users\…), an invalid path that made
    // cpSync throw → caught → exit 1 instead of the gate codes 2/3. On POSIX the
    // same join silently produced a wrongly-nested directory. The staged subject
    // dir must be exactly ONE sanitized segment directly under the harness root.
    const absName = safePath.join(srcRoot, 'poc-skill'); // absolute path used as the item name
    const result = await stageFakeSubject(root, srcRoot, uid, absName);

    expect(result.subjectStagedDir).not.toBeNull();
    const staged = toForwardSlash(result.subjectStagedDir as string);
    const rootFwd = toForwardSlash(root);
    // The staged subject dir is a DIRECT child of the harness root...
    expect(toForwardSlash(safePath.join(staged, '..'))).toBe(rootFwd);
    // ...and the single segment carries no separators or drive letter.
    const segment = staged.slice(rootFwd.length + 1);
    expect(segment).not.toMatch(/[/\\:]/);
  });

  it('re-stage prunes files deleted from source (clean mirror, not an overlay)', async () => {
    // Regression (#132): the harness root is reused on a deterministic key and
    // cpSync overlays source onto dest without removing files dropped from the
    // source. A stale staged evals/evals.json then makes the bootstrap check
    // wrongly pass → spawn/exit-1 instead of re-scaffolding (exit 3). Each
    // re-stage must be a clean mirror of source.
    const srcDir = safePath.join(srcRoot, 'subject');
    mkdirSyncReal(srcDir, { recursive: true });
    const evalsDir = safePath.join(srcDir, 'evals');
    mkdirSyncReal(evalsDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp src
    writeFileSync(safePath.join(srcDir, 'SKILL.md'), '# subject\n', 'utf8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp src
    writeFileSync(safePath.join(evalsDir, 'evals.json'), '{}\n', 'utf8');

    // Resolver returns srcDir verbatim so we can mutate the source between runs.
    const resolve = (async () => ({ stagedDir: srcDir, identity: 'id-subject' })) as never;
    const items: StageItem[] = [{ name: 'subject', source: descriptorToSource({ path: SUBJECT_SRC }) }];
    const opts = { harnessRoot: root, items, resolve, ctx: {} as never, currentUid: uid };

    const first = await stageHarness(opts);
    const stagedEvals = safePath.join(first.pluginDirs[0] as string, 'evals', 'evals.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(stagedEvals)).toBe(true);

    // Drop evals/ from the SOURCE, then re-stage the same harnessRoot+item.
    rmSync(evalsDir, { recursive: true, force: true });
    await stageHarness(opts);

    // The stale staged copy must be gone — re-stage mirrors source, not overlays.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(stagedEvals)).toBe(false);
  });

  it('re-stage with unchanged inputs is a manifest-level no-op (unchanged plan)', async () => {
    const items: StageItem[] = [{ name: 'subject', source: descriptorToSource({ path: SUBJECT_SRC }) }];
    const opts = { harnessRoot: root, items, resolve: makeFakeResolver(srcRoot) as never, ctx: {} as never, currentUid: uid };
    const first = await stageHarness(opts);
    const desired = first.manifest.entries;
    const plan = computeReconcilePlan(desired, first.manifest);
    expect(plan.toStage).toEqual([]);
    expect(plan.unchanged).toHaveLength(1);
  });

  it('stages a plugin-distributed skill under its real plugin-root layout', async () => {
    const { pluginRoot, relPathUnderPlugin, layout } = makeRealPlugin(srcRoot, 'acme-platform', 'report');
    const items: StageItem[] = [
      {
        name: 'report',
        source: descriptorToSource({ path: SUBJECT_SRC }),
        role: 'subject',
        pluginLayout: layout,
      },
    ];
    const result = await stageHarness({
      harnessRoot: root,
      items,
      // Resolver returns a flat copy of the skill contents incl. a nested script.
      resolve: (async () => {
        const flat = safePath.join(srcRoot, 'flat-report');
        const scripts = safePath.join(flat, 'scripts');
        mkdirSyncReal(scripts, { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp src
        writeFileSync(safePath.join(flat, 'SKILL.md'), '# report\n', 'utf8');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own tmp src
        writeFileSync(safePath.join(scripts, 'report.mjs'), '// report\n', 'utf8');
        return { stagedDir: flat, identity: 'id-report' };
      }) as never,
      ctx: {} as never,
      currentUid: uid,
    });

    expect(result.subjectStagedDir).not.toBeNull();
    const stageRoot = result.pluginDirs[0] as string;
    // The plugin manifest is copied into the staged plugin root...
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(safePath.join(stageRoot, CLAUDE_PLUGIN_DIR, PLUGIN_JSON))).toBe(true);
    // ...and the skill lands at its real nesting, scripts intact.
    const stagedSkill = safePath.join(stageRoot, relPathUnderPlugin);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(safePath.join(stagedSkill, 'SKILL.md'))).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(safePath.join(stagedSkill, 'scripts', 'report.mjs'))).toBe(true);
    // pluginDirs carries the PLUGIN ROOT (for --plugin-dir), not the inner skill dir.
    expect(toForwardSlash(stageRoot).startsWith(toForwardSlash(root))).toBe(true);
    expect(toForwardSlash(stageRoot)).not.toBe(toForwardSlash(stagedSkill));
    // subjectStagedDir points INTO the skill dir (where evals/evals.json lives).
    expect(toForwardSlash(result.subjectStagedDir as string)).toBe(toForwardSlash(stagedSkill));
    expect(pluginRoot).toContain('acme-platform'); // sanity on the real source
  });

  it('stages two skills from the same plugin without the second rmSync clobbering the first (M4)', async () => {
    // Bug: stageOneItem called rmSync(pluginStageRoot) unconditionally for every item.
    // When subject + helper share the same plugin, staging helper wiped the already-staged
    // subject dir — leaving subjectStagedDir pointing at a deleted path.
    // Use a distinct plugin name to avoid triggering the sonarjs no-duplicate-string
    // rule for 'acme-platform', which is already used twice in the test above.
    const { pluginRoot: sharedRoot, layout: subjectLayout } = makeRealPlugin(srcRoot, 'dual-skills-plugin', 'subject-skill');
    const helperLayout: PluginLayout = { pluginRoot: sharedRoot, relPathUnderPlugin: 'skills/helper-skill' };

    const items: StageItem[] = [
      {
        name: 'subject-skill',
        source: descriptorToSource({ path: '../subject-skill' }),
        role: 'subject',
        pluginLayout: subjectLayout,
      },
      {
        name: 'helper-skill',
        source: descriptorToSource({ path: '../helper-skill' }),
        pluginLayout: helperLayout,
      },
    ];

    const result = await stageHarness({
      harnessRoot: root,
      items,
      resolve: makeFakeResolver(srcRoot) as never,
      ctx: {} as never,
      currentUid: uid,
    });

    // Both items staged to the same plugin root.
    expect(result.pluginDirs).toHaveLength(2);
    const stageRoot = result.pluginDirs[0] as string;
    // Both items share the same staged plugin root.
    expect(toForwardSlash(result.pluginDirs[1] as string)).toBe(toForwardSlash(stageRoot));

    // Critical: BOTH nested skill dirs must exist after staging. Derive paths from
    // the layout objects so changing skill names in the future doesn't duplicate literals.
    const stagedSubject = safePath.join(stageRoot, subjectLayout.relPathUnderPlugin);
    const stagedHelper = safePath.join(stageRoot, helperLayout.relPathUnderPlugin);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(stagedSubject)).toBe(true); // was wiped without the fix
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(stagedHelper)).toBe(true);

    // The subject's SKILL.md is readable (subjectStagedDir was not deleted).
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(safePath.join(result.subjectStagedDir as string, 'SKILL.md'))).toBe(true);
    // subjectStagedDir points at the nested subject slot, not the plugin root.
    expect(toForwardSlash(result.subjectStagedDir as string)).toBe(toForwardSlash(stagedSubject));

    // Plugin manifest is present (copied once; not lost after second skill staged).
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(safePath.join(stageRoot, CLAUDE_PLUGIN_DIR, PLUGIN_JSON))).toBe(true);
  });

  it('keeps a standalone skill staged flat (no plugin layout regression)', async () => {
    const result = await stageFakeSubject(root, srcRoot, uid, 'subject');
    const staged = toForwardSlash(result.subjectStagedDir as string);
    const rootFwd = toForwardSlash(root);
    // Flat: the staged subject dir is a DIRECT child of the harness root.
    expect(toForwardSlash(safePath.join(staged, '..'))).toBe(rootFwd);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(safePath.join(staged, 'SKILL.md'))).toBe(true);
    // No plugin manifest was synthesized for a standalone skill.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- staged path under our tmp root
    expect(existsSync(safePath.join(staged, CLAUDE_PLUGIN_DIR))).toBe(false);
  });
});
