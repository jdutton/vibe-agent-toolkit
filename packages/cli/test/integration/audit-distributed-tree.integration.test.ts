/* eslint-disable security/detect-non-literal-fs-filename -- all paths are temp dirs the test owns */
/**
 * B1: `vat audit` crawls a DISTRIBUTED skill tree for agent-instruction files.
 *
 * `PACKAGED_AGENT_INSTRUCTION_FILE` claims three surfaces — a built skill bundle,
 * an installed plugin, a plugin source directory — but the built-skill-bundle arm
 * had no producer at audit time. The skill lanes inspect SKILL.md plus whatever
 * links reach from it, so a file that arrives in a bundle with no link at all was
 * invisible: on a real adopter bundle carrying two of them, `vat audit` reported
 * `filesScanned: 1` and zero issues.
 *
 * The discriminator these tests pin is provenance, not path shape: a skill the
 * project's own config DECLARES is source (silent); anything else was handed to us.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditCommandOptions } from '../../src/commands/audit.js';
import { deriveScanRoot, getValidationResults, resetAuditCaches } from '../../src/commands/audit.js';
import { createTempDirTracker } from '../system/test-common.js';

const CODE = 'PACKAGED_AGENT_INSTRUCTION_FILE';
const SKILL_NAME = 'demo';
const CLAUDE_MD = 'CLAUDE.md';
const PLUGIN_NAME = 'demo-plugin';
const PLUGIN_MANIFEST = JSON.stringify({
  name: PLUGIN_NAME,
  description: 'A synthetic plugin fixture.',
  version: '1.0.0',
});

const silentLogger = {
  info: (_msg: string) => {},
  error: (_msg: string) => {},
  debug: (_msg: string) => {},
};

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-audit-distributed-');

async function runAudit(targetPath: string, options: AuditCommandOptions = {}) {
  resetAuditCaches();
  return getValidationResults(
    targetPath,
    options.recursive !== false,
    options,
    silentLogger,
    deriveScanRoot(targetPath),
  );
}

/** Every agent-instruction finding across a result set, by location. */
function instructionFindings(results: Awaited<ReturnType<typeof runAudit>>): string[] {
  return results
    .flatMap((r) => r.issues)
    .filter((i) => i.code === CODE)
    .map((i) => String(i.location))
    .sort((a, b) => a.localeCompare(b));
}

/** Write a minimal SKILL.md plus the given extra files under `dir`. */
function writeSkill(dir: string, extras: string[]): void {
  mkdirSyncReal(dir, { recursive: true });
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: A demonstration skill used to exercise distributed-tree auditing end to end.\n---\n\n# Demo\n\nBody.\n`,
    'utf-8',
  );
  for (const rel of extras) {
    const full = safePath.join(dir, rel);
    mkdirSyncReal(safePath.join(full, '..'), { recursive: true });
    writeFileSync(full, '# repo-internal guidance\n', 'utf-8');
  }
}

/** A plugin whose nested skill dir carries a CLAUDE.md. Returns both roots. */
function writePluginWithSkillGuidance(): { root: string; plugin: string } {
  const root = createTempDir();
  const plugin = safePath.join(root, 'plugins', PLUGIN_NAME);
  mkdirSyncReal(safePath.join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(safePath.join(plugin, '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST, 'utf-8');
  writeSkill(safePath.join(plugin, 'skills', SKILL_NAME), [CLAUDE_MD]);
  return { root, plugin };
}

const CONFIG = `version: 1
skills:
  include:
    - ".claude/skills/**/SKILL.md"
`;

describe('audit: distributed skill trees (integration)', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('reports agent-instruction files in a bundle no config declares', async () => {
    // The B1 population: a built bundle sitting beside the config that produced
    // it. Its PATH is not the declared source path, so it is not a declared
    // source skill — it is output someone can ship.
    const root = createTempDir();
    writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), CONFIG, 'utf-8');
    writeSkill(safePath.join(root, '.claude', 'skills', SKILL_NAME), []);
    const bundle = safePath.join(root, 'dist', 'skills', SKILL_NAME);
    writeSkill(bundle, [CLAUDE_MD, 'notes/AGENTS.md']);

    expect(instructionFindings(await runAudit(bundle))).toEqual([CLAUDE_MD, 'notes/AGENTS.md']);
  });

  // THE hard constraint. Guidance beside a source SKILL.md is deliberately fine.
  it('stays silent for a config-DECLARED source skill with a CLAUDE.md beside it', async () => {
    const root = createTempDir();
    writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), CONFIG, 'utf-8');
    const source = safePath.join(root, '.claude', 'skills', SKILL_NAME);
    writeSkill(source, [CLAUDE_MD]);

    expect(instructionFindings(await runAudit(source))).toEqual([]);
  });

  it('reports one inside an installed plugin exactly once, not twice', async () => {
    // `validatePlugin` crawls the plugin tree at ANY depth, so the per-skill crawl
    // must stand down under a plugin or one file is counted twice — in two results,
    // in one run's issueCounts.
    const { plugin } = writePluginWithSkillGuidance();

    const findings = instructionFindings(await runAudit(plugin));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(CLAUDE_MD);
  });

  it('reports it once when the plugin is reached by a recursive directory scan', async () => {
    // A different lane from the case above: scanning a repo ROOT descends into the
    // plugin dir and then finds the nested SKILL.md as an ordinary file entry. The
    // "a plugin ancestor already crawled this" flag has to survive that recursion,
    // not just the immediate child.
    const { root } = writePluginWithSkillGuidance();

    const findings = instructionFindings(await runAudit(root));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(CLAUDE_MD);
  });

  it('reports nothing for a clean bundle', async () => {
    const root = createTempDir();
    const bundle = safePath.join(root, 'dist', 'skills', SKILL_NAME);
    writeSkill(bundle, ['resources/guide.md', 'README.md']);

    expect(instructionFindings(await runAudit(bundle))).toEqual([]);
  });
});
