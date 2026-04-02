import { describe, expect, it } from 'vitest';

import {
  createCommitMessage,
} from '../../../../src/commands/claude/marketplace/git-publish.js';

describe('git-publish', () => {
  describe('createCommitMessage', () => {
    it('should format commit message with version and changelog delta', () => {
      const msg = createCommitMessage('1.0.0', '### Added\n- Feature A\n- Feature B');
      expect(msg).toContain('publish v1.0.0');
      expect(msg).toContain('### Added');
      expect(msg).toContain('Feature A');
    });

    it('should include source repo metadata when provided', () => {
      const msg = createCommitMessage('1.0.0', '### Added\n- Feature', {
        sourceRepo: 'https://github.com/org/repo',
        commitRange: 'abc123..def456',
      });
      expect(msg).toContain('Source: https://github.com/org/repo');
      expect(msg).toContain('abc123..def456');
    });

    it('should work without changelog delta', () => {
      const msg = createCommitMessage('1.0.0', '');
      expect(msg).toContain('publish v1.0.0');
    });
  });
});
