/**
 * A SKILL.md nested deep enough to overflow an in-process parse must not crash
 * the lanes that only read its NAME (discovery, the plugin build, `vat verify`,
 * and `vat skills package` reporting a refused package): the name falls back to
 * its key, and the packaging validator reports the file as
 * `RESOURCE_PARSE_LIMIT_EXCEEDED`.
 *
 * 50,000 levels: 5,000 overflows `yaml` on a plain `node` main thread but not
 * inside a vitest worker, whose stack is larger.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverSkillsFromConfig, readPluginLocalSkillName, skillDocumentOrRefused } from '../../src/commands/skills/skill-discovery.js';

const DEPTH = 50_000;
const DEEP_SKILL = `---\nname: deep\nnested: ${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}\n---\n# Deep\n`;

describe('a SKILL.md that overflows an in-process parse', () => {
  let skillDir: string;

  beforeEach(() => {
    skillDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'skill-name-overflow-'));
    writeFileSync(safePath.join(skillDir, 'SKILL.md'), DEEP_SKILL, 'utf-8');
  });

  afterEach(() => {
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('is named by its DIRECTORY, never by the file name every SKILL.md shares, dropped or a crash', async () => {
    // Keyed `SKILL`, two refused skills collide on one key and one config.
    await expect(readPluginLocalSkillName(skillDir)).resolves.toBe(basename(skillDir));
  });

  it('is keyed by its directory in config discovery too', async () => {
    const skills = await discoverSkillsFromConfig({ include: ['**/SKILL.md'] }, skillDir, 'refuse');
    expect(skills.map((skill) => skill.name)).toEqual([basename(skillDir)]);
  });

  it('reads as no parse result, so a refused package report still publishes', async () => {
    await expect(skillDocumentOrRefused(safePath.join(skillDir, 'SKILL.md'))).resolves.toBeUndefined();
  });
});
