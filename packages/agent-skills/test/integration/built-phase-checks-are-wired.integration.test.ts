/* eslint-disable security/detect-non-literal-fs-filename -- test paths are our own controlled temp dirs */
/**
 * The WIRING of the two built-phase checks, through the real `packageSkill`.
 *
 * 🚨 This file exists because of a surviving mutation an adversarial review found
 * TWICE. `skill-packager.ts` has the only production call sites of
 * `checkMissingReferencedPaths` and `checkPackagedSizeLimit`, and no test reached
 * either one through `packageSkill` — so **deleting both call lines left the
 * entire suite green**. Both checks became dead code and every claim about what
 * "ships" became false, with nothing anywhere going red.
 *
 * Round one of the review reported it as "nothing pins the WIRING of the new
 * detectors", it named no file to edit, it was the one finding in the fan-out
 * that mapped onto no owner, and two rounds later it was unchanged. The lesson is
 * about triage, not about code — but the fix is this file.
 *
 * So the assertions here are deliberately about the CHANNEL, not the logic: that
 * a real build of a real skill emits each code on `postBuildIssues`, anchored the
 * way the validator promises. The per-rule precision arguments stay in the unit
 * suites (`validators/referenced-path-missing.test.ts`,
 * `validators/packaged-size-limit.test.ts`), which drive the detectors directly
 * and cannot see the wiring at all.
 */

import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageSkill } from '../../src/skill-packager.js';
import { API_SKILL_MAX_UPLOAD_BYTES } from '../../src/validators/packaged-size-limit.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-wiring-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Write a one-skill project and return the paths a build needs. */
function writeProject(body: string): { skillPath: string; outputPath: string; skillDir: string } {
  const skillDir = safePath.join(projectRoot, 'skills', 'demo');
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(safePath.join(projectRoot, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n', 'utf8');
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: demo\ndescription: A fixture skill for the built-phase wiring test.\n---\n\n${body}\n`,
    'utf8',
  );
  return {
    skillPath: safePath.join(skillDir, 'SKILL.md'),
    outputPath: safePath.join(projectRoot, 'dist', 'demo'),
    skillDir,
  };
}

/** Build the project and return the issues the packager published. */
async function buildAndCollect(skillPath: string, outputPath: string): Promise<ValidationIssue[]> {
  const result = await packageSkill(skillPath, { outputPath, formats: ['directory'] });
  return result.postBuildIssues ?? [];
}

describe('the built-phase checks are reachable from packageSkill', () => {
  /**
   * A bare path in a code block, naming a bundled subdirectory the build does not
   * ship. Deliberately NOT a markdown link — a link is `PACKAGED_BROKEN_LINK`'s
   * job, and routing this case through a link would let that other check satisfy
   * the assertion while this one stayed unwired.
   */
  it('emits PACKAGED_REFERENCED_PATH_MISSING for a path the bundle does not contain', async () => {
    const { skillPath, outputPath } = writeProject(
      ['# Demo', '', '```bash', 'node scripts/setup.mjs', '```'].join('\n'),
    );

    const issues = await buildAndCollect(skillPath, outputPath);

    const finding = issues.find(i => i.code === 'PACKAGED_REFERENCED_PATH_MISSING');
    expect(finding, 'no PACKAGED_REFERENCED_PATH_MISSING in postBuildIssues').toBeDefined();
    expect(finding?.location).toBe('SKILL.md');
    // The missing path rides `link`, which is what an allow glob waives.
    expect(finding?.link).toBe('scripts/setup.mjs');
  });

  it('stays silent through the same route when the path IS shipped', async () => {
    // The negative control. Without it, a check that emitted unconditionally
    // would satisfy the case above and still be useless.
    //
    // The bare token has to name the PACKAGED path of a file the build actually
    // bundles. Two things decide that and neither is visible from the source
    // layout: the packager copies only what the link graph reaches, and
    // content-type routing puts a `.md` under `resources/` wherever it started.
    // Authoring the source at `resources/guide.md` makes the source and packaged
    // spellings coincide, so the token names what ships.
    const { skillPath, outputPath, skillDir } = writeProject(
      ['# Demo', '', 'See [the guide](resources/guide.md) — spelled `resources/guide.md`.'].join('\n'),
    );
    mkdirSyncReal(safePath.join(skillDir, 'resources'), { recursive: true });
    writeFileSync(safePath.join(skillDir, 'resources', 'guide.md'), '# Guide\n', 'utf8');

    const issues = await buildAndCollect(skillPath, outputPath);

    expect(issues.filter(i => i.code === 'PACKAGED_REFERENCED_PATH_MISSING')).toEqual([]);
  });

  /**
   * The packager calls `checkPackagedSizeLimit(outputPath)` with no limit
   * override, so the only way to reach it through a real build is a bundle that
   * actually weighs the ceiling. `truncateSync` makes a SPARSE file: `statSync`
   * reports 30 MiB and the test writes ~no bytes, so this costs milliseconds
   * rather than 30 MB of disk churn.
   */
  it('emits PACKAGED_SIZE_EXCEEDS_API_LIMIT for a bundle at the real ceiling', async () => {
    const { skillPath, outputPath, skillDir } = writeProject(
      ['# Demo', '', 'Ships a [runtime](assets/runtime.wasm).'].join('\n'),
    );
    const assets = safePath.join(skillDir, 'assets');
    mkdirSyncReal(assets, { recursive: true });
    const heavy = safePath.join(assets, 'runtime.wasm');
    writeFileSync(heavy, '', 'utf8');
    truncateSync(heavy, API_SKILL_MAX_UPLOAD_BYTES);

    const issues = await buildAndCollect(skillPath, outputPath);

    const finding = issues.find(i => i.code === 'PACKAGED_SIZE_EXCEEDS_API_LIMIT');
    expect(finding, 'no PACKAGED_SIZE_EXCEEDS_API_LIMIT in postBuildIssues').toBeDefined();
    // The bundle root is the location; the heaviest file is the waiver anchor.
    // The anchor is the PACKAGED path — content-type routing lands a `.wasm`
    // under `resources/`, wherever the source tree kept it — which is exactly
    // why this has to be observed through a real build rather than asserted from
    // the source layout.
    expect(finding?.location).toBe('.');
    expect(finding?.link).toBe('resources/runtime.wasm');
    expect(finding?.message).toContain('resources/runtime.wasm');
  });

  it('stays silent through the same route for an ordinary bundle', async () => {
    const { skillPath, outputPath } = writeProject('# Demo\n\nNothing heavy here.');

    const issues = await buildAndCollect(skillPath, outputPath);

    expect(issues.filter(i => i.code === 'PACKAGED_SIZE_EXCEEDS_API_LIMIT')).toEqual([]);
  });
});
