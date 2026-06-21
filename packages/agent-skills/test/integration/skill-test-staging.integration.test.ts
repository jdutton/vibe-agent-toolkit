import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeReconcilePlan, StagedManifestSchema } from '../../src/skill-test/manifest.js';
import { descriptorToSource, stageHarness, type StageItem } from '../../src/skill-test/staging.js';

/** Shared relative source spec for the fake resolver (one literal, many uses). */
const SUBJECT_SRC = '../subject';

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
    const items: StageItem[] = [
      { name: absName, source: descriptorToSource({ path: SUBJECT_SRC }), role: 'subject' },
    ];
    const result = await stageHarness({
      harnessRoot: root,
      items,
      resolve: makeFakeResolver(srcRoot) as never,
      ctx: {} as never,
      currentUid: uid,
    });

    expect(result.subjectStagedDir).not.toBeNull();
    const staged = toForwardSlash(result.subjectStagedDir as string);
    const rootFwd = toForwardSlash(root);
    // The staged subject dir is a DIRECT child of the harness root...
    expect(toForwardSlash(safePath.join(staged, '..'))).toBe(rootFwd);
    // ...and the single segment carries no separators or drive letter.
    const segment = staged.slice(rootFwd.length + 1);
    expect(segment).not.toMatch(/[/\\:]/);
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
});
