/**
 * Root-relative (RFC 3986 §4.2) links must survive packaging.
 *
 * A leading-`/` href means "relative to the project root", not "the filesystem
 * root". Two lanes used to disagree about that, and the disagreement shipped:
 *
 *  - The link-graph walker resolved it correctly (via `resolveLocalHref`), so it
 *    BUNDLED the target into the skill.
 *  - `ResourceRegistry.resolveLinks()` used a private path-only resolver that sent
 *    the href to the OS root, found nothing, and left `resolvedId` unset. The
 *    bundled-link template then rendered an empty path and STRIPPED the href.
 *
 * Net effect on a real adopter: the file shipped with nothing pointing at it, so
 * `PACKAGED_UNREFERENCED_FILE` (error severity) failed the build — and every other
 * root-relative link in the packaged prose was silently de-linked to plain text,
 * which no check reported at all.
 *
 * The relative-link case is the control: it always worked, and must keep working.
 */
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../../../cli/test/system/test-common.js';
import { packageSkill } from '../../src/skill-packager.js';

const SKILL_MD = `---
name: demo
description: Fixture skill linking a project doc by root-relative and relative href.
---

# demo

- root-relative: [the ADR](/docs/adrs/boundary.md)
- relative: [the guide](../../docs/guides/guide.md)
`;

interface PackagedFixture {
  body: string;
  hasErrors: boolean;
  unreferenced: string[];
}

/** Write a project tree with a skill that links docs both ways, then package it. */
async function packageFixture(tempDir: string): Promise<PackagedFixture> {
  // A config marker pins findProjectRoot() to tempDir, so `/docs/...` resolves
  // against the fixture project rather than whatever encloses the temp dir.
  writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');

  const skillDir = safePath.join(tempDir, 'skills', 'demo');
  mkdirSyncReal(skillDir, { recursive: true });
  mkdirSyncReal(safePath.join(tempDir, 'docs', 'adrs'), { recursive: true });
  mkdirSyncReal(safePath.join(tempDir, 'docs', 'guides'), { recursive: true });

  writeTestFile(safePath.join(skillDir, 'SKILL.md'), SKILL_MD);
  writeTestFile(safePath.join(tempDir, 'docs', 'adrs', 'boundary.md'), '# Boundary ADR\n');
  writeTestFile(safePath.join(tempDir, 'docs', 'guides', 'guide.md'), '# Guide\n');

  const outputPath = safePath.join(tempDir, 'dist', 'demo');
  const result = await packageSkill(safePath.join(skillDir, 'SKILL.md'), {
    outputPath,
    formats: ['directory'],
  });

  const { readFile } = await import('node:fs/promises');
  return {
    body: await readFile(safePath.join(outputPath, 'SKILL.md'), 'utf-8'),
    hasErrors: result.hasErrors,
    unreferenced: (result.postBuildIssues ?? [])
      .filter((issue) => issue.code === 'PACKAGED_UNREFERENCED_FILE')
      .map((issue) => issue.message),
  };
}

describe('packager — root-relative links', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) cleanupTestTempDir(tempDir);
    tempDir = '';
  });

  it('rewrites a root-relative link to its packaged counterpart instead of stripping it', async () => {
    tempDir = createTestTempDir('root-relative-link-');

    const { body, hasErrors, unreferenced } = await packageFixture(tempDir);

    // The bundled ADR is reachable from the packaged SKILL.md by a real link.
    expect(body).toContain('[the ADR](resources/boundary.md)');
    // The control: a plain relative link keeps working.
    expect(body).toContain('[the guide](resources/guide.md)');

    // The href must not have been stripped to `()` or flattened to bare text.
    expect(body).not.toContain('[the ADR]()');
    expect(body).not.toMatch(/the ADR(?!\]\(resources)/);

    // A bundled-but-unreferenced file is what the strip used to produce.
    expect(unreferenced).toEqual([]);
    expect(hasErrors).toBe(false);
  });
});
