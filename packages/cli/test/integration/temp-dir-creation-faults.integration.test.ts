/**
 * A temp directory VAT cannot create — a full or read-only `$TMPDIR` — is the ENVIRONMENT's fault
 * (`RUN_INCOMPLETE`: free space, or point TMPDIR elsewhere), in every lane that makes one. Two lanes
 * called `mkdtemp` raw, so the same condition there was an uncoded errno: `INTERNAL_ERROR` with a stack.
 */
import { FS_FAULT_CODE, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { parseGitUrl } from '@vibe-agent-toolkit/utils/git';
import { type FaultFsSession, installFaultFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withClonedRepo } from '../../src/commands/audit/git-url-clone.js';
import { publishToGitBranch } from '../../src/commands/claude/marketplace/git-publish.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { createLogger } from '../../src/utils/logger.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

// ⛔ Disposal paths: TMPDIR / TEMP / TMP point at a scratch tree for every test.
const scratchTmp = useScratchTmpdir('vat-scratch-tmpdir-faults-');

let session: FaultFsSession | undefined;
afterEach(() => {
  session?.restore();
  session = undefined;
  vi.restoreAllMocks();
});

const rejectionOf = (work: () => Promise<unknown>): Promise<unknown> => work().then(() => undefined, (error: unknown) => error);

/** Refuse every `mkdtemp` under the scratch temp directory with `errno`. */
function refuseMkdtemp(errno: 'EACCES' | 'ENOSPC'): void {
  session = installFaultFs({ within: scratchTmp(), faults: [{ op: 'mkdtemp', path: () => true, errno }] });
}

describe.each(['EACCES', 'ENOSPC'] as const)('a temp directory the OS will not create (%s)', (errno) => {
  it('vat audit <git-url>: an environment fault, RUN_INCOMPLETE — and nothing was cloned', async () => {
    refuseMkdtemp(errno);
    const body = vi.fn();

    const refused = await rejectionOf(() => withClonedRepo(parseGitUrl('https://example.invalid/o/r.git'), { keepTempForDebug: false }, body));

    expect(refused, String(refused)).toMatchObject({ code: FS_FAULT_CODE, side: 'environment', errno });
    expect(refusalCodeOf(refused)).toBe('RUN_INCOMPLETE');
    expect(body).not.toHaveBeenCalled();
  });

  it('vat claude marketplace publish: an environment fault, RUN_INCOMPLETE', async () => {
    refuseMkdtemp(errno);
    const publishDir = safePath.join(scratchTmp(), 'publish-tree');
    mkdirSyncReal(publishDir, { recursive: true });

    const refused = await rejectionOf(() => publishToGitBranch({
      publishDir, branch: 'claude-marketplace', remote: 'https://example.invalid/o/r.git', remoteFromConfig: true,
      commitMessage: 'publish', dryRun: true, force: false, noPush: true, logger: createLogger({}),
    }));

    expect(refused, String(refused)).toMatchObject({ code: FS_FAULT_CODE, side: 'environment', errno });
    expect(refusalCodeOf(refused)).toBe('RUN_INCOMPLETE');
  });
});
