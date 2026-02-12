import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { importSkillToAgent } from '../src/import.js';

import { setupTempDir } from './test-helpers.js';

const { getTempDir } = setupTempDir('import-unit-');

describe('importSkillToAgent', () => {
  it('should return error for invalid YAML frontmatter', async () => {
    const tmp = getTempDir();
    const skillPath = path.join(tmp, 'SKILL.md');
    // Write content with syntactically invalid YAML (unclosed bracket)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses controlled temp directory
    fs.writeFileSync(skillPath, '---\nname: [invalid yaml\n---\n# Skill');

    const result = await importSkillToAgent({ skillPath });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Failed to parse frontmatter');
    }
  });

  it('should return error when file does not exist', async () => {
    const result = await importSkillToAgent({ skillPath: '/nonexistent/SKILL.md' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('does not exist');
    }
  });
});
