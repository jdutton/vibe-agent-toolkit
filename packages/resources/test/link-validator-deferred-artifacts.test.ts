/* eslint-disable security/detect-non-literal-fs-filename -- tempDir paths are test-generated, safe in test context */
/**
 * `validateLink` + `DeferredArtifacts`.
 *
 * A `local_file` link whose target is missing must become an info-severity
 * `LINK_DEFERRED_ARTIFACT` (not an error-severity `LINK_BROKEN_FILE`) when a
 * `DeferredArtifacts` model covers the resolved target path — mirroring what
 * `vat skills validate` already reports for the same `files:`-declared link.
 *
 * The existence gate matters: an EXISTING covered target must keep its normal
 * treatment (no deferred downgrade) — `covers()` alone is not enough to
 * short-circuit validation.
 */
import { promises as fs } from 'node:fs';

import { safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DeferredArtifacts } from '../src/deferred-artifacts.js';
import { fragmentIndex, validateLink, type ValidateLinkOptions } from '../src/link-validator.js';
import type { SkillFileEntry } from '../src/schemas/project-config.js';

import { createLink } from './test-helpers.js';

const DEST_ENTRY = 'cli-reference.md';

/** Build a DeferredArtifacts model covering `dest` under `skillDir` (both project-root-relative). */
function deferredArtifactsCovering(dest: string, skillDir: string): DeferredArtifacts {
  const files: SkillFileEntry[] = [{ source: 'build-output/generated-ref.md', dest }];
  return DeferredArtifacts.from([{ files, skillDir }], skillDir);
}

/**
 * Write a SKILL.md linking to `./${DEST_ENTRY}` in `tempDir`, then validate that
 * link with `extraOptions` layered on top of the always-on `projectRoot` /
 * `skipGitIgnoreCheck` options. Each call site supplies its own `deferredArtifacts`
 * (or omits it) and asserts independently on the returned issue.
 */
async function validateDestLink(tempDir: string, extraOptions: Partial<ValidateLinkOptions> = {}) {
  const sourceFile = safePath.join(tempDir, 'SKILL.md');
  await fs.writeFile(sourceFile, `[ref](./${DEST_ENTRY})\n`, 'utf-8');

  return validateLink(createLink('local_file', `./${DEST_ENTRY}`), sourceFile, fragmentIndex(), {
    projectRoot: tempDir,
    skipGitIgnoreCheck: true,
    ...extraOptions,
  });
}

describe('validateLink + deferredArtifacts', () => {
  const suite = setupAsyncTempDirSuite('link-validator-deferred-');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('reports LINK_BROKEN_FILE for a missing target when no deferredArtifacts is given', async () => {
    const issue = await validateDestLink(tempDir);

    expect(issue?.code).toBe('LINK_BROKEN_FILE');
  });

  it('reports LINK_DEFERRED_ARTIFACT (info) for a missing target the deferredArtifacts model covers', async () => {
    const issue = await validateDestLink(tempDir, {
      deferredArtifacts: deferredArtifactsCovering(DEST_ENTRY, tempDir),
    });

    expect(issue?.code).toBe('LINK_DEFERRED_ARTIFACT');
    expect(issue?.severity).toBe('info');
  });

  it('still reports LINK_BROKEN_FILE for a missing target NOT covered by deferredArtifacts', async () => {
    const issue = await validateDestLink(tempDir, {
      deferredArtifacts: deferredArtifactsCovering('some-other-file.md', tempDir),
    });

    expect(issue?.code).toBe('LINK_BROKEN_FILE');
  });

  it('does NOT downgrade an EXISTING covered target — normal (valid) treatment applies', async () => {
    // The dest target is covered by deferredArtifacts BUT already materialized on disk.
    await fs.writeFile(safePath.join(tempDir, DEST_ENTRY), '# CLI Reference\n', 'utf-8');

    const issue = await validateDestLink(tempDir, {
      deferredArtifacts: deferredArtifactsCovering(DEST_ENTRY, tempDir),
    });

    expect(issue).toBeNull();
  });
});
