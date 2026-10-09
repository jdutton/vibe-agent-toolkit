/**
 * The publish-tree lane's one seam: `publishToGitBranch` spawns git (init, commit, push), a child
 * process no in-process fault reaches, so it becomes a `vi.fn()` that does nothing. Every fs call
 * the case makes is then the composer's (`composePublishTree`), and none is the mock's.
 *
 * Imported FIRST by each publish-tree matrix file, before anything that loads the publish command:
 * the mock is registered as this module evaluates, ahead of the command importing `git-publish.js`.
 */
import { vi } from 'vitest';

import type * as GitPublish from '../../../src/commands/claude/marketplace/git-publish.js';

vi.mock('../../../src/commands/claude/marketplace/git-publish.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitPublish>()),
  publishToGitBranch: vi.fn(),
}));
