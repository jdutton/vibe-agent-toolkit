import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSuiteContext, executeCli, writeTestFile } from './test-common.js';

const ctx = createSuiteContext('vat-build-shipped-link-', import.meta.url);

/**
 * A tree-copy-only plugin: the plugin-local skill under plugins/<plugin>/skills/
 * is excluded from the skills.include glob (a decoy pool skill is discovered
 * instead), so it is NEVER packaged by `vat skills build` — it reaches the
 * shipped plugin tree ONLY via verbatim tree-copy. This isolates Fix 2's check
 * from Fix 1 (no pool selection, no collision), proving the two are independent.
 */
function buildFixture(tempDir: string, skillBody: string): void {
  writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  writeTestFile(
    safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
    `version: 1
skills:
  include: ["resources/skills/**/SKILL.md"]
claude:
  marketplaces:
    mp1:
      owner:
        name: Test Org
      plugins:
        - name: local-only-plugin
          skills: []
`,
  );

  // Decoy pool skill so `vat skills build` (Phase 1) has something to
  // discover and succeed on. It lives outside plugins/, so it never
  // interacts with the plugin-local skill below.
  const decoyDir = safePath.join(tempDir, 'resources', 'skills', 'decoy');
  mkdirSyncReal(decoyDir, { recursive: true });
  writeTestFile(
    safePath.join(decoyDir, 'SKILL.md'),
    '---\nname: decoy\ndescription: decoy pool skill so vat skills build has something to package\n---\n\n# decoy\n',
  );

  // Plugin-local skill: excluded from skills.include, so it is NEVER
  // packaged/validated by `vat skills build` — it reaches the shipped
  // plugin tree ONLY via verbatim tree-copy (the path Fix 2 protects).
  const skillDir = safePath.join(tempDir, 'plugins', 'local-only-plugin', 'skills', 'local-a');
  mkdirSyncReal(skillDir, { recursive: true });
  writeTestFile(
    safePath.join(skillDir, 'SKILL.md'),
    `---
name: local-a
description: local-a - tree-copy-only skill for shipped-tree link validation testing
---

# local-a

${skillBody}
`,
  );
}

describe('vat build — shipped plugin skill tree link validation (Fix 2)', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it('fails vat build with PACKAGED_BROKEN_LINK when a tree-copied skill ships a dead relative link', async () => {
    const tempDir = ctx.createTempDir();
    buildFixture(tempDir, 'See [missing](./missing.md).');

    const result = await executeCli(ctx.binPath, ['--cwd', tempDir, 'build']);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('PACKAGED_BROKEN_LINK');
  });

  it('exits 0 when the tree-copied skill has no broken links', async () => {
    const tempDir = ctx.createTempDir();
    buildFixture(tempDir, 'No links here.');

    const result = await executeCli(ctx.binPath, ['--cwd', tempDir, 'build']);

    expect(result.status).toBe(0);
  });
});
