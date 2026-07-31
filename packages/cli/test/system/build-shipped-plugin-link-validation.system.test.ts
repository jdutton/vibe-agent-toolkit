import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSuiteContext, executeCli, writeTestFile } from './test-common.js';

const ctx = createSuiteContext('vat-build-shipped-link-', import.meta.url);

/**
 * A plugin-local-only plugin: the skill under plugins/<plugin>/skills/ is excluded
 * from the skills.include glob (a decoy pool skill is discovered instead), so
 * `vat skills build` never sees it. It reaches the shipped plugin tree solely
 * through the plugin build — which now PACKAGES it rather than copying it
 * verbatim, so it is validated like any other skill.
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

  // Plugin-local skill: excluded from skills.include, so `vat skills build` never
  // packages it. The plugin build is its only production path.
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

describe('vat build — shipped plugin skill link validation', () => {
  beforeAll(ctx.setup);
  afterEach(ctx.cleanup);

  it('fails vat build when a plugin-local skill ships a dead relative link', async () => {
    const tempDir = ctx.createTempDir();
    buildFixture(tempDir, 'See [missing](./missing.md).');

    const result = await executeCli(ctx.binPath, ['--cwd', tempDir, 'build']);

    expect(result.status).not.toBe(0);
    // Reported as a SOURCE defect, not as PACKAGED_BROKEN_LINK. Now that a
    // plugin-local skill is packaged like any other, its dead link is caught by
    // the same check that catches a pool skill's — and `PACKAGED_BROKEN_LINK`
    // goes back to meaning what its docs say it means: a link-rewriter bug.
    // Per-issue detail is human output (stderr); the machine summary is stdout.
    expect(result.stderr).toContain('LINK_MISSING_TARGET');
    // The failure names the skill, so a multi-skill plugin is diagnosable.
    expect(result.stdout).toContain('local-a');
  });

  it('exits 0 when the plugin-local skill has no broken links', async () => {
    const tempDir = ctx.createTempDir();
    buildFixture(tempDir, 'No links here.');

    const result = await executeCli(ctx.binPath, ['--cwd', tempDir, 'build']);

    expect(result.status).toBe(0);
  });
});
