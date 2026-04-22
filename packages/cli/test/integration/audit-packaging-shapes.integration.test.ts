import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { AuditCommandOptions } from '../../src/commands/audit.js';
import { getValidationResults, resetAuditCaches } from '../../src/commands/audit.js';

const MISMATCH_CODE = 'SKILL_CLAUDE_PLUGIN_NAME_MISMATCH';
const SURFACE_TYPE_CLAUDE_PLUGIN = 'claude-plugin';

const silentLogger = {
  info: (_msg: string) => {},
  error: (_msg: string) => {},
  debug: (_msg: string) => {},
};

async function runAudit(targetPath: string, options: AuditCommandOptions = {}) {
  resetAuditCaches();
  return getValidationResults(targetPath, options.recursive !== false, options, silentLogger);
}

function expectNoMismatchOnPlugin(results: ValidationResult[]): void {
  const pluginResult = results.find((r) => r.type === SURFACE_TYPE_CLAUDE_PLUGIN);
  expect(pluginResult).toBeDefined();
  expect(
    pluginResult?.issues.find((i) => i.code === MISMATCH_CODE),
  ).toBeUndefined();
}

describe('audit: packaging shapes (integration)', () => {
  const fixturesBase = safePath.join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'agent-skills',
    'test',
    'fixtures',
    'packaging-shapes',
  );

  it('standalone-skill fixture produces one agent-skill result', async () => {
    const dir = safePath.join(fixturesBase, 'standalone-skill');
    const results = await runAudit(dir, { recursive: false });
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe('agent-skill');
  });

  it('skill-claude-plugin-matching fixture produces two results (skill + plugin), no mismatch issue', async () => {
    const dir = safePath.join(fixturesBase, 'skill-claude-plugin-matching');
    const results = await runAudit(dir, { recursive: false });
    expect(results).toHaveLength(2);
    const types = results.map((r) => r.type).sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(['agent-skill', SURFACE_TYPE_CLAUDE_PLUGIN]);
    expectNoMismatchOnPlugin(results);
  });

  it('skill-claude-plugin-mismatch fixture produces two results with SKILL_CLAUDE_PLUGIN_NAME_MISMATCH on the plugin', async () => {
    const dir = safePath.join(fixturesBase, 'skill-claude-plugin-mismatch');
    const results = await runAudit(dir, { recursive: false });
    expect(results).toHaveLength(2);
    const pluginResult = results.find((r) => r.type === SURFACE_TYPE_CLAUDE_PLUGIN);
    expect(pluginResult).toBeDefined();
    const issue = pluginResult?.issues.find((i) => i.code === MISMATCH_CODE);
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
  });

  it('canonical-plugin fixture produces one claude-plugin result (no skill at root)', async () => {
    const dir = safePath.join(fixturesBase, 'canonical-plugin');
    const results = await runAudit(dir, { recursive: false });
    expect(results.some((r) => r.type === SURFACE_TYPE_CLAUDE_PLUGIN)).toBe(true);
    expectNoMismatchOnPlugin(results);
  });

  it('colocated-plugin-marketplace fixture produces one marketplace result (collapse preserved)', async () => {
    // Regression: enumerateSurfaces must honor detectResourceFormat's
    // co-located collapse — a marketplace that points at the current
    // directory via `source: "./"` must not produce a parallel claude-plugin
    // result even though .claude-plugin/plugin.json also exists.
    const dir = safePath.join(fixturesBase, 'colocated-plugin-marketplace');
    const results = await runAudit(dir, { recursive: false });
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe('marketplace');
  });
});
