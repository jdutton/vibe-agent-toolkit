/**
 * The built lane's link graph is empty, and nothing committed could show it.
 *
 * **All 13 of VAT's own dogfood skills bundle exactly zero files** — source and
 * built both report `fileCount: 1, maxLinkDepth: 0` — so VAT's own build cannot
 * distinguish a working link graph from a structurally empty one. This test
 * supplies the fixture that can: a skill with one `reference.md` reachable by a
 * single relative link from `SKILL.md`.
 *
 * Three cases, one variable — where the packaged output lands:
 *
 * | lane   | output location        | expectation |
 * |--------|------------------------|-------------|
 * | source | n/a                    | `fileCount 2`, `maxLinkDepth 1` |
 * | built  | inside the project     | `fileCount 1`, `maxLinkDepth 0` ← the defect |
 * | built  | outside any project    | `fileCount 2`, `maxLinkDepth 1` ← the proof of cause |
 *
 * The only difference between the two built rows is whether the output tree
 * falls under the crawl's `**\/dist\/**` exclusion. In the middle row the
 * result's own `files.dependencies` still lists `reference.md` — the packager
 * *did* copy it; the validator that runs immediately afterwards simply cannot
 * see it.
 *
 * That is not only a metrics hole. Everything in the built lane derived from
 * the walk is structurally dead: the file-count rule, the reference-depth rule,
 * the total-lines size rule, and — the part that is not a metric — the
 * per-bundled-file content scans, which iterate `bundledFiles` and therefore
 * **never open a single bundled reference in the built lane**. A non-portable
 * `${CLAUDE_PLUGIN_ROOT}` invocation inside a bundled reference is caught at
 * source and cannot be caught in the built artifact.
 *
 * ⚠️ **This test pins what VAT does TODAY.** The middle row is a defect. The
 * fix is not "crawl `dist/` everywhere" — `BUILD_OUTPUT_GLOBS` is deliberately
 * kept out of `NEVER_CRAWL_GLOBS` so a lane can opt in, and
 * `crawlAndResolveRegistry`'s process-lifetime memo documents that same
 * exclusion as its own correctness proof. When it is fixed, the middle row's
 * assertions flip in the change that fixes them.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- every path derives from a mkdtemp root created here. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { packageSkill, validateSkillForPackaging } from '@vibe-agent-toolkit/agent-skills';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLING_SKILL_FILES } from '../../src/pipeline-oracles/index.js';

/** The one skill in {@link BUNDLING_SKILL_FILES}. */
const SKILL_NAME = 'bundling-skill';

const roots: string[] = [];

/**
 * A project anchored by a config file, containing the bundling skill.
 *
 * The config file is what makes `findProjectRoot` stop here, which is what
 * makes `<root>/dist/...` "inside the project" and therefore excluded from the
 * crawl. Without it the skill directory becomes the root and the defect does
 * not reproduce — the fixture would silently test nothing.
 */
function makeProject(label: string): { root: string; skillPath: string } {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), `vat-bundling-${label}-`));
  roots.push(root);
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n', 'utf-8');
  for (const [relativePath, contents] of Object.entries(BUNDLING_SKILL_FILES)) {
    const absolutePath = safePath.join(root, relativePath);
    mkdirSyncReal(safePath.resolve(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, contents, 'utf-8');
  }
  return { root, skillPath: safePath.join(root, 'skills', SKILL_NAME, 'SKILL.md') };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundling skill fixture — the built lane cannot see what it bundled', () => {
  it('sees the bundled reference at SOURCE', async () => {
    const { skillPath } = makeProject('source');
    const result = await validateSkillForPackaging(skillPath, undefined, 'source');
    expect(result.metadata.fileCount).toBe(2);
    expect(result.metadata.directFileCount).toBe(1);
    expect(result.metadata.maxLinkDepth).toBe(1);
  });

  it('does NOT see it when the output lands inside the project (the defect)', async () => {
    const { root, skillPath } = makeProject('inside');
    const packaged = await packageSkill(skillPath, {
      outputPath: safePath.join(root, 'dist', 'skills', SKILL_NAME),
    });

    // The packager copied it. This is the half that works.
    expect(packaged.files.dependencies).toContain('reference.md');

    // The validator that runs immediately afterwards cannot see it, because the
    // output tree falls under the crawl's `**/dist/**` exclusion.
    const metadata = packaged.postBuildValidation?.metadata;
    expect(metadata).toBeDefined();
    expect(metadata?.fileCount).toBe(1);
    expect(metadata?.directFileCount).toBe(0);
    expect(metadata?.maxLinkDepth).toBe(0);
  });

  it('DOES see it when the same call writes outside any project root (proof of cause)', async () => {
    const { skillPath } = makeProject('outside');
    const elsewhere = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-bundling-out-'));
    roots.push(elsewhere);

    const packaged = await packageSkill(skillPath, {
      outputPath: safePath.join(elsewhere, SKILL_NAME),
    });

    // Same call, same skill, same bundled file — only the destination differs.
    const metadata = packaged.postBuildValidation?.metadata;
    expect(metadata).toBeDefined();
    expect(metadata?.fileCount).toBe(2);
    expect(metadata?.directFileCount).toBe(1);
    expect(metadata?.maxLinkDepth).toBe(1);
  });

  it('reads the bundled file\'s bytes only in the lanes that can see it', async () => {
    // `totalLines` is the same fact from the other side: when the walk finds
    // nothing, it is `skillLines` alone, so the bundled reference's bytes are
    // never read — which is why the per-bundled-file content scans are dead in
    // the built lane, not merely under-counting.
    const { root, skillPath } = makeProject('lines');
    const inside = await packageSkill(skillPath, {
      outputPath: safePath.join(root, 'dist', 'skills', SKILL_NAME),
    });
    const source = await validateSkillForPackaging(skillPath, undefined, 'source');

    expect(inside.postBuildValidation?.metadata.totalLines).toBeLessThan(source.metadata.totalLines);
  });
});
