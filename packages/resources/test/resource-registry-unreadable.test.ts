/**
 * RESOURCE_UNREADABLE issue shape.
 *
 * `ValidationIssue`'s contract (see `packages/agent-schema/src/validation-issue.ts`)
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
import { safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';
import type { ValidationIssue } from '../src/schemas/validation-result.js';

const MISSING_FILE_NAME = 'missing.md';

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
