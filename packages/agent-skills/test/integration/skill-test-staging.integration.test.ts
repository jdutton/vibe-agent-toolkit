import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeReconcilePlan, StagedManifestSchema } from '../../src/skill-test/manifest.js';
import { descriptorToSource, stageHarness, type StageItem } from '../../src/skill-test/staging.js';

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
      { name: 'subject', source: descriptorToSource({ path: '../subject' }) },
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

  it('re-stage with unchanged inputs is a manifest-level no-op (unchanged plan)', async () => {
    const items: StageItem[] = [{ name: 'subject', source: descriptorToSource({ path: '../subject' }) }];
    const opts = { harnessRoot: root, items, resolve: makeFakeResolver(srcRoot) as never, ctx: {} as never, currentUid: uid };
    const first = await stageHarness(opts);
    const desired = first.manifest.entries;
    const plan = computeReconcilePlan(desired, first.manifest);
    expect(plan.toStage).toEqual([]);
    expect(plan.unchanged).toHaveLength(1);
  });
});
