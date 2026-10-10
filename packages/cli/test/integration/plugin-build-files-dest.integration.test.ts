/**
 * `vat claude plugin build`: a plugin `files[]` entry never lands inside the plugin's `skills/`,
 * however its `dest` is spelled, and so never reaches a link a pool skill's copy kept.
 *
 * Phase 3 copies each pool skill out of `dist/skills` with its links kept as links; Phase 4 then
 * writes the `files[]` entries into the same staged plugin. `dest: skills/…` was refused by a string
 * prefix, so `./skills/<pool-skill>/<link>` passed it and the build wrote THROUGH the link: over the
 * file it pointed at, or — a directory link — into the directory it pointed at, outside the output.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { diffSnapshots, installFaultFs, snapshotTree, tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { makeCaseRoot, runVerb, type CaseRoot, type VerbCase } from '../fault-matrix/drive.js';
import type { VerbOutcome } from '../fault-matrix/invariants.js';

const scratch = tempDirTracker('vat-plugin-build-files-dest-');
afterEach(() => {
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

const CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';
const POOL_SKILL = 'fx-skill';
const PRECIOUS = 'precious: bytes outside the build output';

interface PluginConfig { claude: { marketplaces: Record<string, { plugins: Array<Record<string, unknown>> }> } }

/** The matrix's plugin-build project, its one plugin given `files: [{ source: payload.md, dest }]`. */
function buildCase(dest: string, plant: (r: CaseRoot) => void): VerbCase {
  const base = BUILD_FAMILY_SHARDS['plugin/build'].make();
  return {
    ...base,
    fixture: (r) => {
      base.fixture(r);
      const configPath = safePath.join(r.project, CONFIG_FILE);
      const config = YAML.parse(readFileSync(configPath, 'utf8')) as PluginConfig;
      for (const marketplace of Object.values(config.claude.marketplaces)) {
        for (const plugin of marketplace.plugins) plugin['files'] = [{ source: 'payload.md', dest }];
      }
      writeFileSync(configPath, YAML.stringify(config));
      writeFileSync(safePath.join(r.project, 'payload.md'), 'payload');
      mkdirSyncReal(safePath.join(r.root, 'outside'), { recursive: true });
      writeFileSync(safePath.join(r.root, 'outside', 'victim.md'), PRECIOUS);
      plant(r);
    },
  };
}

/** Run the build with nothing injected; `before` is the project's `dist` as the fixture left it. */
async function build(c: VerbCase): Promise<{ r: CaseRoot; outcome: VerbOutcome; before: ReturnType<typeof snapshotTree> }> {
  const r = makeCaseRoot(scratch.create());
  c.fixture(r);
  const before = snapshotTree(safePath.join(r.project, 'dist'));
  const session = installFaultFs({ within: r.root });
  try {
    const outcome = await runVerb(c, r);
    await session.settled();
    return { r, outcome, before };
  } finally {
    session.restore();
  }
}

const poolSkillDir = (r: CaseRoot): string => safePath.join(r.project, 'dist', 'skills', POOL_SKILL);
const outside = (r: CaseRoot): string => safePath.join(r.root, 'outside');

describe('vat claude plugin build — files[].dest never reaches a link a pool skill kept', () => {
  it.for([`./skills/${POOL_SKILL}/linked.md`, `Skills/${POOL_SKILL}/linked.md`])(
    'refuses dest %s (a FILE link in the pool skill): the file it points at byte-identical, the previous marketplace untouched',
    async (dest, { skip }) => {
      const cap = symlinkCapability() ?? skip();
      const c = buildCase(dest, (r) => createSymlink(cap, safePath.join(outside(r), 'victim.md'), safePath.join(poolSkillDir(r), 'linked.md'), 'file'));

      const { r, outcome, before } = await build(c);

      expect(readFileSync(safePath.join(outside(r), 'victim.md'), 'utf8')).toBe(PRECIOUS);
      expect(outcome, outcome.message).toMatchObject({ exitCode: 2, refusal: 'CONFIG_INVALID' });
      expect(outcome.message).toContain(dest);
      expect(diffSnapshots(before, snapshotTree(safePath.join(r.project, 'dist')))).toEqual([]);
    },
  );

  it('refuses a dest THROUGH a directory link in the pool skill: nothing is created where it points', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const dest = `./skills/${POOL_SKILL}/linkdir/x.md`;
    const c = buildCase(dest, (r) => createSymlink(cap, outside(r), safePath.join(poolSkillDir(r), 'linkdir'), 'dir'));

    const { r, outcome, before } = await build(c);

    expect(readdirSync(outside(r))).toEqual(['victim.md']);
    expect(outcome, outcome.message).toMatchObject({ exitCode: 2, refusal: 'CONFIG_INVALID' });
    expect(outcome.message).toContain(dest);
    expect(existsSync(safePath.join(outside(r), 'x.md'))).toBe(false);
    expect(diffSnapshots(before, snapshotTree(safePath.join(r.project, 'dist')))).toEqual([]);
  });
});
