/**
 * A real bare git remote for `publishToGitBranch` round-trips: the remote and an empty publish
 * tree under `root`, with the remote initialised bare on `main`.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';

import { fs } from '../system/test-common.js';

export function bareRemoteAndPublishDir(root: string): { bareRemote: string; publishDir: string } {
  const bareRemote = safePath.join(root, 'remote.git');
  const publishDir = safePath.join(root, 'publish');
  fs.mkdirSync(bareRemote, { recursive: true });
  fs.mkdirSync(publishDir, { recursive: true });
  runGitOrThrow(['init', '--bare', '--initial-branch=main', bareRemote], { cwd: root });
  return { bareRemote, publishDir };
}
