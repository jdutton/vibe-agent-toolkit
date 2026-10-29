/**
 * What `vat verify` makes of a built-output directory it cannot stat.
 *
 * `isDirectory` used to answer `false` for a file, for nothing, AND for a path
 * the process could not stat — and `false` is "no bundle here", which the
 * packaged-content phase files under `bundlesMissing` with the remedy "run
 * `vat build`". A refused `dist/skills/x` was reported as an unbuilt one. Only
 * an absence is a missing bundle; a refusal is the run's problem and throws.
 */

import nodeFs, { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkPackagedAgentInstructionFiles } from '../../src/commands/verify.js';
import { resetLoadedConfigCache } from '../../src/utils/config-loader.js';
import { fakePluginLocalIndex } from '../helpers/plugin-local-fixture.js';
import { errno, refuseOnDefault } from '../helpers/refusal-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';

// The bundle's `stat` goes through utils' link-following, which reaches the kernel through the
// DEFAULT `node:fs` object, so the refusal is injected there.

const SKILL = 'only-skill';
const { createTempDir, cleanupTempDirs } = createTempDirTracker('verify-built-stat-');

afterEach(() => {
  vi.restoreAllMocks();
  resetLoadedConfigCache();
  cleanupTempDirs();
});

/** A project whose `skills.config` names one skill, so `dist/skills/<SKILL>` is the one candidate. */
function projectWithOneCandidate(): string {
  const root = safePath.resolve(createTempDir());
  writeFileSync(
    safePath.join(root, 'vibe-agent-toolkit.config.yaml'),
    `skills:\n  include:\n    - "nothing/**/SKILL.md"\n  config:\n    ${SKILL}:\n      files: []\n`,
    'utf-8',
  );
  return root;
}

describe('a built-output directory the run cannot stat', () => {
  it('counts an absent bundle as inspected-nothing — the case "no bundle here" is for', () => {
    const root = projectWithOneCandidate();

    const crawl = checkPackagedAgentInstructionFiles(root, [], fakePluginLocalIndex([]), new Map());

    expect(crawl.bundlesInspected).toBe(0);
  });

  it('inspects a bundle that is there', () => {
    const root = projectWithOneCandidate();
    mkdirSyncReal(safePath.join(root, 'dist', 'skills', SKILL), { recursive: true });

    const crawl = checkPackagedAgentInstructionFiles(root, [], fakePluginLocalIndex([]), new Map());

    expect(crawl.bundlesInspected).toBe(1);
  });

  it('throws on a bundle the OS refuses to stat rather than counting it as not built', () => {
    const root = projectWithOneCandidate();
    const bundle = safePath.join(root, 'dist', 'skills', SKILL);
    mkdirSyncReal(bundle, { recursive: true });
    refuseOnDefault(nodeFs, 'statSync', bundle, errno('EACCES'));

    expect(() => checkPackagedAgentInstructionFiles(root, [], fakePluginLocalIndex([]), new Map())).toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});
