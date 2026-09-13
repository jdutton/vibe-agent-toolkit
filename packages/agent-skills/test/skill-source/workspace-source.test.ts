/* eslint-disable security/detect-non-literal-fs-filename -- tmpdir paths constructed in test setup */
import { readdirSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveWorkspaceSource } from '../../src/skill-source/sources/workspace-source.js';

import { setupSkillSourceTestSuite } from './test-helpers.js';

const suite = setupSkillSourceTestSuite('vat-ws-');

describe('resolveWorkspaceSource', () => {
  let skillDir: string;

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);
  afterEach(() => vi.unstubAllEnvs());

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

  it('removes its build temp dir after staging (no vat-ws-build- leak) (M4)', async () => {
    // The subject builds under `os.tmpdir()`, which is OS-wide and shared with
    // every other process on the box — including the sibling vitest workers
    // running other test files, whose own transient `vat-ws-build-` dirs appear
    // and vanish while this test runs. A before/after diff of the shared dir
    // read one of those as this subject's leak (2026-09-12, gate run 2), and an
    // earlier exact-equality check failed on a stale entry someone else cleaned
    // up mid-test (2026-08-12). So give the subject a tmpdir nothing else uses:
    // `os.tmpdir()` reads TMPDIR (POSIX) / TEMP, TMP (win32) on every call.
    const privateTmp = safePath.join(suite.root, 'private-tmp');
    mkdirSyncReal(privateTmp, { recursive: true });
    vi.stubEnv('TMPDIR', privateTmp);
    vi.stubEnv('TEMP', privateTmp);
    vi.stubEnv('TMP', privateTmp);
    expect(normalizedTmpdir()).toBe(privateTmp);

    const result = await resolveWorkspaceSource('bar', suite.ctx, {
      skillPath: safePath.join(skillDir, 'SKILL.md'),
    });
    // Staged output survives; the build temp dir does not.
    expect(statSync(safePath.join(result.stagedDir, 'SKILL.md')).isFile()).toBe(true);
    // The build also parks the parse cache's fallback root (`.vat-cache`) in the
    // tmpdir; that is the cache's own contract, not this subject's leak.
    expect(readdirSync(privateTmp).filter((n) => n.startsWith('vat-ws-build-'))).toEqual([]);
  });
});
