import { readdirSync, statSync, writeFileSync } from 'node:fs';

import { isFsFaultError, mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { installFaultFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isSkillPackagingInputError, SkillPackageChecksFailedError } from '../../src/packaging-errors.js';
import { resolveWorkspaceSource } from '../../src/skill-source/sources/workspace-source.js';

import { setupSkillSourceTestSuite } from './test-helpers.js';

const suite = setupSkillSourceTestSuite('vat-ws-');

describe('resolveWorkspaceSource', () => {
  let skillDir: string;

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);
  afterEach(() => vi.unstubAllEnvs());

  // ⛔ A disposal path: every test's temp directory is a private scratch under the suite root.
  let privateTmp: string;
  beforeEach(() => {
    privateTmp = safePath.join(suite.root, 'private-tmp');
    mkdirSyncReal(privateTmp, { recursive: true });
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, privateTmp);
  });

  beforeEach(() => {
    skillDir = safePath.join(suite.root, 'skills', 'bar');
    mkdirSyncReal(skillDir, { recursive: true });
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: bar\ndescription: A workspace skill for resolveWorkspaceSource build-graph staging coverage.\n---\n\n# bar\n`,
    );
  });

  it('builds the workspace skill via the build graph and stages the built bundle', async () => {
    const result = await resolveWorkspaceSource('bar', suite.ctx, {
      skillPath: safePath.join(skillDir, 'SKILL.md'),
    });
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    expect(result.identity).toMatch(/^workspace:bar:[0-9a-f]{64}$/);
  });

  // A package its own checks failed writes nothing: the lane refuses naming the findings, coded,
  // never hashing a bundle that was never written (a raw absence error with the findings lost).
  it('refuses a workspace skill whose package fails its own checks, coded with the findings', async () => {
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: bar\ndescription: A workspace skill whose package fails its post-build checks.\n---\n\n# bar\n\nSee [the guide](./missing-guide.md).\n`,
    );

    const error: unknown = await resolveWorkspaceSource('bar', suite.ctx, { skillPath: safePath.join(skillDir, 'SKILL.md') })
      .then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(SkillPackageChecksFailedError);
    expect(isSkillPackagingInputError(error)).toBe(true);
    expect((error as Error).message).toMatch(/missing-guide\.md/);
  });

  it('removes its build temp dir after staging (no vat-ws-build- leak) (M4)', async () => {
    // The subject builds under `os.tmpdir()`, which is OS-wide and shared with
    // every other process on the box — including the sibling vitest workers
    // running other test files, whose own transient `vat-ws-build-` dirs appear
    // and vanish while this test runs. A before/after diff of the shared dir
    // read one of those as this subject's leak (2026-09-12, gate run 2), and an
    // earlier exact-equality check failed on a stale entry someone else cleaned
    // up mid-test (2026-08-12). So give the subject a tmpdir nothing else uses:
    // `os.tmpdir()` reads TMPDIR (POSIX) / TEMP, TMP (win32) on every call.
    // `normalizedTmpdir()` is realpath'd in the OS's own spelling (backslashes on Windows).
    expect(toForwardSlash(normalizedTmpdir())).toBe(privateTmp);

    const result = await resolveWorkspaceSource('bar', suite.ctx, {
      skillPath: safePath.join(skillDir, 'SKILL.md'),
    });
    // Staged output survives; the build temp dir does not.
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    // The build also parks the parse cache's fallback root (`.vat-cache`) in the
    // tmpdir; that is the cache's own contract, not this subject's leak.
    expect(readdirSync(privateTmp).filter((n) => n.startsWith('vat-ws-build-'))).toEqual([]);
    expect(result.leftovers).toEqual([]);
  });

  // The skill WAS resolved and staged before its build temp dir refused to go: the resolution
  // stands, and the directory left behind rides it as a leftover for the run to report.
  it('resolves, and returns a build temp dir the OS will not remove as a leftover naming it', async () => {
    const refused = { op: 'rm', path: (p: string) => p.startsWith(`${toForwardSlash(normalizedTmpdir())}/vat-ws-build-`) && !p.slice(privateTmp.length + 1).includes('/'), errno: 'EBUSY' } as const;
    const faults = installFaultFs({ within: privateTmp, faults: [refused] });
    let result: Awaited<ReturnType<typeof resolveWorkspaceSource>>;
    try {
      result = await resolveWorkspaceSource('bar', suite.ctx, { skillPath: safePath.join(skillDir, 'SKILL.md') });
    } finally {
      faults.restore();
    }

    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    expect(result.leftovers).toHaveLength(1);
    expect(isFsFaultError(result.leftovers[0])).toBe(true);
    expect((result.leftovers[0] as Error).message).toMatch(/vat-ws-build-/);
  });
});
