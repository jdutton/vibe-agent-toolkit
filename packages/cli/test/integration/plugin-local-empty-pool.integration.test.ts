/**
 * A project whose skills are all PLUGIN-LOCAL has a `skills:` block (the include is required, and
 * plugin-local skills read `skills.config` / `skills.defaults` from it) whose include matches no
 * pool skill. In every orchestrator with a `skills` phase, that phase's zero is then an answer —
 * and with no pool match AND no plugin-local skill, it is the refusal the verb gives alone.
 *
 * Over a real project, so the answer comes from the one plugin-local index
 * (`indexPluginLocalSkills`) each orchestrator is wired to, not from a stand-in.
 */

import { buildReport } from '@vibe-agent-toolkit/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuredBuildSurfaces, selectBuildPhases } from '../../src/commands/build.js';
import { ORCHESTRATOR_GATE, type Phase, phaseVerdict, type PhaseSelection } from '../../src/commands/phase-utils.js';
import { selectValidateSurfaces } from '../../src/commands/validate.js';
import { selectVerifyPhases } from '../../src/commands/verify.js';
import { loadConfig } from '../../src/utils/config-loader.js';
import { pluginSkillDir, writeProjectConfig, writeSkillProject } from '../helpers/plugin-local-fixture.js';
import { createTempDirTracker } from '../system/test-common.js';

const tempDirs = createTempDirTracker('vat-plugin-local-empty-pool-');

afterEach(() => {
  vi.restoreAllMocks();
  tempDirs.cleanupTempDirs();
});

/** A project with one plugin `p` and a pool include that matches nothing; with or without a skill under the plugin. */
function project(pluginLocalSkill: boolean): string {
  const root = tempDirs.createTempDir();
  writeProjectConfig(root, {
    skills: { include: ['pool-that-does-not-exist/**/SKILL.md'] },
    claude: { marketplaces: { m: { owner: { name: 'Owner' }, plugins: [{ name: 'p', skills: [] }] } } },
  });
  // Outside any repository, where every file is visible to the plugin build.
  writeSkillProject(root, pluginLocalSkill ? [{ dir: pluginSkillDir('shipped-dir'), name: 'shipped' }] : [{ dir: 'docs/not-a-plugin-skill', name: 'elsewhere' }]);
  return root;
}

/** The `skills` phase an orchestrator selects for the project at `root`, the process standing in it as `vat --cwd` leaves it. */
function skillsPhaseOf(select: (root: string) => PhaseSelection, root: string): Pick<Phase, 'examined'> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const selection = select(root);
  const phase = selection.kind === 'run' ? selection.phases.find((each) => each.name === 'skills') : undefined;
  if (phase === undefined) throw new Error('the orchestrator selected no skills phase');
  return phase;
}

/** A `skills` phase that finished cleanly over an empty pool. */
const zero = buildReport({ examined: 0, findings: [], data: null, gate: ORCHESTRATOR_GATE });

const ORCHESTRATORS: ReadonlyArray<readonly [name: string, select: (root: string) => PhaseSelection]> = [
  ['vat build', (root) => selectBuildPhases(undefined, configuredBuildSurfaces(root))],
  ['vat validate', (root) => selectValidateSurfaces(loadConfig(root))],
  ['vat verify', (root) => selectVerifyPhases(loadConfig(root))],
];

describe.each(ORCHESTRATORS)('%s over a pool include that matches nothing', (_name, select) => {
  it('takes zero pool skills as an answer when the project ships a plugin-local skill', () => {
    expect(phaseVerdict(skillsPhaseOf(select, project(true)), zero)).toBe(zero);
  });

  it('refuses zero pool skills when the project ships no plugin-local skill either', () => {
    expect(phaseVerdict(skillsPhaseOf(select, project(false)), zero).findings.map((finding) => [finding.code, finding.severity])).toEqual([['RESOURCE_CHECK_BROKEN', 'error']]);
  });
});
