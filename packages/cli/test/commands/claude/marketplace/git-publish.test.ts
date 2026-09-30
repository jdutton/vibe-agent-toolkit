import { runGit } from '@vibe-agent-toolkit/utils/git';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCommitMessage,
  deliverCommit,
  publishToGitBranch,
} from '../../../../src/commands/claude/marketplace/git-publish.js';
import { refusalCodeOf } from '../../../../src/utils/command-refusal.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { thrownBy } from '../../../helpers/refusal-doubles.js';

vi.mock('@vibe-agent-toolkit/utils/git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runGit: vi.fn(),
}));

/** Every git call exits `status` with `stderr`, and nothing else happens. */
function gitExits(status: number, stderr = ''): void {
  vi.mocked(runGit).mockReturnValue({ stdout: '', stderr, status } as ReturnType<typeof runGit>);
}

/** What `promise` rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error);
}

const logger = createLogger({});
const DELIVERY = { branch: 'claude-marketplace', remote: 'origin', force: false, dryRun: false, noPush: false, logger };

const HEADLINE_V1 = 'publish v1.0.0';

describe('git-publish', () => {
  describe('createCommitMessage', () => {
    it('should format commit message with headline and changelog delta', () => {
      const msg = createCommitMessage(HEADLINE_V1, '### Added\n- Feature A\n- Feature B');
      expect(msg).toContain(HEADLINE_V1);
      expect(msg).toContain('### Added');
      expect(msg).toContain('Feature A');
    });

    it('should include source repo metadata when provided', () => {
      const msg = createCommitMessage(HEADLINE_V1, '### Added\n- Feature', {
        sourceRepo: 'https://github.com/org/repo',
        commitRange: 'abc123..def456',
      });
      expect(msg).toContain('Source: https://github.com/org/repo');
      expect(msg).toContain('abc123..def456');
    });

    it('should work without changelog delta', () => {
      const msg = createCommitMessage(HEADLINE_V1, '');
      expect(msg).toContain(HEADLINE_V1);
    });

    it('should accept a headline without a version (multi-plugin marketplace)', () => {
      const msg = createCommitMessage('publish my-marketplace', '### Added\n- Bumped plugin-a');
      expect(msg.startsWith('publish my-marketplace')).toBe(true);
      expect(msg).not.toContain('publish v');
      expect(msg).toContain('Bumped plugin-a');
    });
  });

  describe('refusal codes', () => {
    afterEach(() => { vi.mocked(runGit).mockReset(); });

    const publish = (remote: string, remoteFromConfig: boolean): Promise<void> => publishToGitBranch({
      publishDir: '/never-read', branch: 'b', remote, remoteFromConfig, commitMessage: 'm', force: false, dryRun: true, noPush: false, logger,
    });

    it('refuses the default remote it cannot find as CONFIG_INVALID, saying it was the default', async () => {
      gitExits(2);
      const error = await rejectionOf(publish('origin', false));
      expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
      expect((error as Error).message).toBe(
        'Git remote "origin" (the default — publish.remote is not set) not found. Add it with git remote add, or set publish.remote to a remote name or a full URL.',
      );
    });

    it('refuses a config-named remote it cannot find as CONFIG_INVALID, naming publish.remote', async () => {
      gitExits(2);
      const error = await rejectionOf(publish('upstream', true));
      expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
      expect((error as Error).message).toBe(
        'Git remote "upstream" (from publish.remote) not found. Add it with git remote add, or set publish.remote to a remote name or a full URL.',
      );
    });

    it('refuses a rejected push as EXTERNAL_API_FAILED', () => {
      gitExits(1, 'rejected');
      expect(refusalCodeOf(thrownBy(() => deliverCommit('/staging', '/project', DELIVERY, 'https://example.invalid/r.git')))).toBe('EXTERNAL_API_FAILED');
    });

    it('refuses any other failed git step as RUN_INCOMPLETE', () => {
      gitExits(1, 'fetch failed');
      expect(refusalCodeOf(thrownBy(() => deliverCommit('/staging', '/project', { ...DELIVERY, noPush: true }, 'https://example.invalid/r.git')))).toBe('RUN_INCOMPLETE');
    });
  });
});
