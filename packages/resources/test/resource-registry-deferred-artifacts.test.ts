/**
 * ResourceRegistry.validate({ deferredArtifacts }) threading.
 *
 * Proves `deferredArtifacts` passed into `validate()` reaches the link
 * validator: a missing local_file link target covered by the model becomes
 * an info-severity `LINK_DEFERRED_ARTIFACT` (not an error-severity
 * `LINK_BROKEN_FILE`) — same mechanism as the gitTracker/checkHtmlAnchors
 * options already threaded through `validateAllLinks`.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- tempDir paths are test-generated, safe in test context */
import { promises as fs } from 'node:fs';

import { safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DeferredArtifacts } from '../src/deferred-artifacts.js';
import { ResourceRegistry } from '../src/resource-registry.js';
import type { SkillFileEntry } from '../src/schemas/project-config.js';

const DEST_ENTRY = 'cli-reference.md';

describe('ResourceRegistry.validate threads deferredArtifacts into link validation', () => {
  const suite = setupAsyncTempDirSuite('registry-deferred-artifacts');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('downgrades LINK_BROKEN_FILE to LINK_DEFERRED_ARTIFACT when deferredArtifacts covers the missing target', async () => {
    const docPath = safePath.join(tempDir, 'SKILL.md');
    await fs.writeFile(docPath, `# Skill\n\n[ref](./${DEST_ENTRY})\n`, 'utf-8');

    const registry = ResourceRegistry.empty(tempDir);
    await registry.addResource(docPath);

    // Baseline: without deferredArtifacts the missing target is an error.
    const baseline = await registry.validate({ skipGitIgnoreCheck: true });
    expect(baseline.issues.some((i) => i.code === 'LINK_BROKEN_FILE')).toBe(true);
    expect(baseline.hasErrors).toBe(true);

    // With deferredArtifacts covering the dest, the same link becomes info.
    const files: SkillFileEntry[] = [{ source: 'build-output/generated-ref.md', dest: DEST_ENTRY }];
    const deferredArtifacts = DeferredArtifacts.from([{ files, skillDir: tempDir }], tempDir);

    const result = await registry.validate({ skipGitIgnoreCheck: true, deferredArtifacts });

    expect(result.issues.some((i) => i.code === 'LINK_BROKEN_FILE')).toBe(false);
    const deferred = result.issues.find((i) => i.code === 'LINK_DEFERRED_ARTIFACT');
    expect(deferred).toBeDefined();
    expect(deferred?.severity).toBe('info');
    expect(result.hasErrors).toBe(false);
  });
});
