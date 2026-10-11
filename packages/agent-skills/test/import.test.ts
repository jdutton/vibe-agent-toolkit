import * as fs from 'node:fs';

import { safePath, TREE_DEST_OCCUPIED_CODE } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { importSkillToAgent } from '../src/import.js';

import { setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('import-unit-');

describe('importSkillToAgent', () => {
  it('should return error for invalid YAML frontmatter', async () => {
    const tmp = getTempDir();
    const skillPath = safePath.join(tmp, 'SKILL.md');
    // Write content with syntactically invalid YAML (unclosed bracket)
    fs.writeFileSync(skillPath, '---\nname: [invalid yaml\n---\n# Skill');

    const result = await importSkillToAgent({ skillPath });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Failed to parse frontmatter');
      expect(result.refusal).toBe('INPUT_UNREADABLE');
    }
  });

  it('should return error when file does not exist', async () => {
    const result = await importSkillToAgent({ skillPath: '/nonexistent/SKILL.md' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('does not exist');
      expect(result.refusal).toBe('USAGE_INVALID');
    }
  });

  it('refuses a directory where the SKILL.md should be as the input\'s refusal, never an uncoded throw', async () => {
    const result = await importSkillToAgent({ skillPath: getTempDir() });

    expect(result).toMatchObject({ success: false, refusal: 'INPUT_UNREADABLE' });
  });

  // The plan's preflight refuses it before anything is written: the CLI publishes it USAGE_INVALID.
  it('refuses an existing agent.yaml without force by the plan\'s preflight, and leaves it alone', async () => {
    const tmp = getTempDir();
    const skillPath = safePath.join(tmp, 'SKILL.md');
    const agentPath = safePath.join(tmp, 'agent.yaml');
    fs.writeFileSync(skillPath, '---\nname: kept\ndescription: Keeps things. Use when keeping.\n---\n# kept\n');
    fs.writeFileSync(agentPath, 'kept: true\n');

    await expect(importSkillToAgent({ skillPath })).rejects.toMatchObject({ code: TREE_DEST_OCCUPIED_CODE });
    expect(fs.readFileSync(agentPath, 'utf-8')).toBe('kept: true\n');
    expect(fs.readdirSync(tmp).toSorted((a, b) => a.localeCompare(b))).toEqual(['agent.yaml', 'SKILL.md']);
  });

  // The plan makes the directory an --output goes in, as every verb with an output does.
  it('writes into an --output whose directory does not exist yet, making it', async () => {
    const tmp = getTempDir();
    const skillPath = safePath.join(tmp, 'SKILL.md');
    fs.writeFileSync(skillPath, '---\nname: kept\ndescription: Keeps things. Use when keeping.\n---\n# kept\n');
    const agentPath = safePath.join(tmp, 'never-created', 'agent.yaml');

    expect(await importSkillToAgent({ skillPath, outputPath: agentPath })).toEqual({ success: true, agentPath });
    expect(fs.readFileSync(agentPath, 'utf-8')).toContain('name: kept');
  });
});
