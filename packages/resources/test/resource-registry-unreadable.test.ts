/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
/**
 * RESOURCE_UNREADABLE issue shape.
 *
 * `ValidationIssue`'s contract (see `packages/schema/src/validation-issue.ts`)
 * says every issue's `location` must be a project-relative path so it never leaks
 * the developer's home directory into CI logs, and so `validation.allow` globs
 * (which match against `location`) can address it. `collectUnreadableResourceErrors`
 * computes the sanitized relative path (`issueLocation`) but historically only used
 * it inside the message string -- never as the `location` extra -- and interpolated
 * the raw filesystem error message, which embeds the absolute path, straight into
 * the issue text. Both are asserted against here, using a nonexistent file (ENOENT
 * is a `READ_FAILURE_CODES` member and reproduces cross-platform, unlike EACCES via
 * chmod which is POSIX-only).
 */
import { writeFileSync } from 'node:fs';

import {
  mkdirSyncReal,
  safePath,
  setupAsyncTempDirSuite,
  toForwardSlash,
  withReaddirSyncRefused,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';
import type { ValidationIssue } from '../src/schemas/validation-result.js';

const MISSING_FILE_NAME = 'missing.md';
const OPEN_FILE = 'docs/open/ok.md';

/** Register a nonexistent file under `tempDir` and return its RESOURCE_UNREADABLE issue. */
async function unreadableIssue(tempDir: string): Promise<ValidationIssue | undefined> {
  const missingPath = safePath.join(tempDir, MISSING_FILE_NAME);
  const registry = new ResourceRegistry({ baseDir: tempDir });
  await registry.addResources([missingPath]);
  const result = await registry.validate({ skipGitIgnoreCheck: true });
  return result.issues.find((i) => i.code === 'RESOURCE_UNREADABLE');
}

describe('ResourceRegistry RESOURCE_UNREADABLE issues', () => {
  const suite = setupAsyncTempDirSuite('resource-registry-unreadable');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('reports a project-relative location for a file that could not be read', async () => {
    const issue = await unreadableIssue(tempDir);
    expect(issue).toBeDefined();
    expect(issue?.location).toBe(MISSING_FILE_NAME);
  });

  it('never leaks the absolute filesystem path into the message', async () => {
    const issue = await unreadableIssue(tempDir);
    expect(issue).toBeDefined();
    expect(issue?.message).not.toContain(tempDir);
    expect(issue?.message).not.toContain(safePath.join(tempDir, MISSING_FILE_NAME));
  });
});

/** Crawl `tempDir` with `locked` refusing to list, then validate. */
async function crawlAndValidate(
  tempDir: string,
  locked: string,
  code: string,
): Promise<{ registry: ResourceRegistry; issues: ValidationIssue[] }> {
  const registry = new ResourceRegistry({ baseDir: tempDir });
  return await withReaddirSyncRefused(locked, code, async () => {
    await registry.crawl({ baseDir: tempDir, include: ['**/*.md'] });
    const result = await registry.validate({ skipGitIgnoreCheck: true });
    return { registry, issues: result.issues };
  });
}

/**
 * The crawl that defines the population must report a directory it could not
 * enter — the same green-without-running shape the link judge already refuses
 * (`LINK_TARGET_UNREADABLE`), one level up.
 *
 * 🪤 `crawlDirectory` used to swallow the refusal and hand back a shorter list,
 * so `docs/locked/t.md` — in the declared population, never opened — was in no
 * count and no finding, and `vat resources validate` reported `status: success`.
 */
describe('ResourceRegistry SCAN_PATH_UNREADABLE for a directory the crawl could not list', () => {
  const suite = setupAsyncTempDirSuite('resource-registry-unlistable');
  let tempDir: string;
  let locked: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    locked = safePath.join(tempDir, 'docs', 'locked');
    mkdirSyncReal(safePath.join(tempDir, 'docs', 'open'), { recursive: true });
    mkdirSyncReal(locked, { recursive: true });
    writeFileSync(safePath.join(tempDir, OPEN_FILE), '# ok\n');
    writeFileSync(safePath.join(locked, 't.md'), '# t\n');
  });

  it('reports the refused directory, project-relative, with its errno — and still admits the readable sibling', async () => {
    const { registry, issues } = await crawlAndValidate(tempDir, locked, 'EACCES');

    const refusal = issues.filter((i) => i.code === 'SCAN_PATH_UNREADABLE');
    expect(refusal).toHaveLength(1);
    expect(refusal[0]?.location).toBe('docs/locked');
    expect(refusal[0]?.message).toContain('EACCES');
    expect(refusal[0]?.message).toContain('resources.exclude');
    expect(refusal[0]?.message).not.toContain(tempDir);

    // Degrade, don't destroy: the half the walk could list is still there.
    expect(registry.getAllResources().map((r) => toForwardSlash(safePath.relative(tempDir, r.filePath)))).toEqual([
      OPEN_FILE,
    ]);
    expect(registry.getUnlistableDirectories()).toEqual([
      { kind: 'directory_unreadable', code: 'EACCES', directory: toForwardSlash(locked), transient: false },
    ]);
  });

  it('tells the reader to re-run first when the refusal was transient', async () => {
    const { issues } = await crawlAndValidate(tempDir, locked, 'EMFILE');
    const refusal = issues.find((i) => i.code === 'SCAN_PATH_UNREADABLE');
    expect(refusal?.message).toContain('EMFILE');
    expect(refusal?.message).toMatch(/re-run/i);
  });

  it('clears the refusal log with the rest of the registry', async () => {
    const { registry } = await crawlAndValidate(tempDir, locked, 'EACCES');
    registry.clear();
    expect(registry.getUnlistableDirectories()).toEqual([]);
  });
});
