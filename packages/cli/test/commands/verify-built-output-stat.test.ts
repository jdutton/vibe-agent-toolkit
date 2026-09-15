/**
 * What `vat verify` makes of a built-output directory it cannot stat.
 *
 * `isDirectory` used to answer `false` for a file, for nothing, AND for a path
 * the process could not stat — and `false` is "no bundle here", which the
 * packaged-content phase files under `bundlesMissing` with the remedy "run
 * `vat build`". A refused `dist/skills/x` was reported as an unbuilt one. Only
 * an absence is a missing bundle; a refusal is the run's problem and throws.
 */

import { statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkPackagedAgentInstructionFiles } from '../../src/commands/verify.js';
import { resetLoadedConfigCache } from '../../src/utils/config-loader.js';
import { fakePluginLocalIndex } from '../helpers/plugin-local-fixture.js';
import { errno, realBehind, refusingOnly } from '../helpers/refusal-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';

// `statSync` is a named import in the command, so the refusal is injected at
// the module seam.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['statSync']));

const SKILL = 'only-skill';
const { createTempDir, cleanupTempDirs } = createTempDirTracker('verify-built-stat-');

afterEach(() => {
  vi.mocked(statSync).mockRestore();
  resetLoadedConfigCache();
  cleanupTempDirs();
});

/** A project whose `skills.config` names one skill, so `dist/skills/<SKILL>` is the one candidate. */
function projectWithOneCandidate(): string {
  const root = safePath.resolve(createTempDir());
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    `version: 1\nskills:\n  include:\n    - "nothing/**/SKILL.md"\n  config:\n    ${SKILL}:\n      files: []\n`,
    'utf-8',
  );
  return root;
}

describe('a built-output directory the run cannot stat', () => {
  it('counts an absent bundle as inspected-nothing — the case "no bundle here" is for', () => {
    const root = projectWithOneCandidate();

    const crawl = checkPackagedAgentInstructionFiles(root, [], fakePluginLocalIndex([]));

    expect(crawl.bundlesInspected).toBe(0);
  });

  it('inspects a bundle that is there', () => {
    const root = projectWithOneCandidate();
    mkdirSyncReal(safePath.join(root, 'dist', 'skills', SKILL), { recursive: true });

    const crawl = checkPackagedAgentInstructionFiles(root, [], fakePluginLocalIndex([]));

    expect(crawl.bundlesInspected).toBe(1);
  });

  it('throws on a bundle the OS refuses to stat rather than counting it as not built', () => {
    const root = projectWithOneCandidate();
    const bundle = safePath.join(root, 'dist', 'skills', SKILL);
    mkdirSyncReal(bundle, { recursive: true });
    vi.mocked(statSync).mockImplementation(refusingOnly(bundle, errno('EACCES'), realBehind(statSync)));

    expect(() => checkPackagedAgentInstructionFiles(root, [], fakePluginLocalIndex([]))).toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});
