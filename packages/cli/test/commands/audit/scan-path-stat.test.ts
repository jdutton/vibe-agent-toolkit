/**
 * The `stat` that decides whether an unknown-format audit subject is a
 * directory to walk, and what its failures mean.
 *
 * It used to share one `try` with the walk itself, under a bare `catch`. Every
 * throw — the stat refused, the walk refused, a `TypeError` two frames down —
 * was absorbed into "let validate() handle it", and `validate()` then filed the
 * directory as an UNKNOWN resource format. A scan that examined nothing was
 * reported as a directory that was nothing.
 *
 * Three answers, three tests: nothing there is the unknown-format result; a
 * refusal is the audit's own `SCAN_PATH_UNREADABLE` finding (the audit
 * DEGRADES, it does not refuse the run); anything else is a defect and throws.
 */

import fsPromises from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getValidationResults, resetAuditCaches } from '../../../src/commands/audit.js';
import { errno, refuseOnDefault } from '../../helpers/refusal-doubles.js';
import { createTempDirTracker } from '../../system/test-common.js';
import { silentLogger } from '../../test-helpers.js';

// The subject's stat goes through utils' link-following, which reaches the kernel through the
// DEFAULT `node:fs/promises` object, so the refusal is injected there.

const { createTempDir, cleanupTempDirs } = createTempDirTracker('audit-scan-path-stat-');

describe('the audit subject stat', () => {
  beforeEach(() => {
    resetAuditCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDirs();
  });

  it('files a subject that is not there as an unknown resource — the case the fallthrough is for', async () => {
    const root = createTempDir();

    const results = await getValidationResults(safePath.join(root, 'nowhere'), true, {}, silentLogger, root);

    expect(results).toHaveLength(1);
    expect(results[0]?.issues.map((issue) => issue.code)).toEqual(['UNKNOWN_FORMAT']);
  });

  it('files a subject the OS refuses to stat as SCAN_PATH_UNREADABLE, not as an unknown format', async () => {
    const root = createTempDir();
    refuseOnDefault(fsPromises, 'stat', root, errno('EACCES'));

    const results = await getValidationResults(root, true, {}, silentLogger, root);

    expect(results).toHaveLength(1);
    expect(results[0]?.issues.map((issue) => issue.code)).toEqual(['SCAN_PATH_UNREADABLE']);
  });

  it('lets a defect in the stat propagate rather than filing the directory as an unknown format', async () => {
    const root = createTempDir();
    refuseOnDefault(fsPromises, 'stat', root, new TypeError('not the filesystem'));

    await expect(getValidationResults(root, true, {}, silentLogger, root)).rejects.toThrow('not the filesystem');
  });
});
