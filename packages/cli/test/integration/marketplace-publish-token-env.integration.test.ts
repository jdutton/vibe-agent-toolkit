/**
 * The CI token's git configuration, read back by real git — no network.
 *
 * `vat claude marketplace publish` authenticates to `https://github.com/` by appending entries to
 * git's env-only configuration channel (`GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n`) after any the
 * operator already exports. That only works if `runGit`'s environment scrub KEEPS the operator's
 * `GIT_CONFIG_*`: drop them and git sees a count naming keys that are not there, and refuses.
 * And the token header must be the one git sends, not a second AUTHORIZATION beside one configured
 * elsewhere (GitHub answers 400 to two).
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { githubTokenEnv } from '../../src/commands/claude/marketplace/git-publish.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { createTempDirTracker, fs } from '../system/test-common.js';

useScratchTmpdir('vat-scratch-cli-mp-token-env-');

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-mp-token-env-');

const TOKEN = 'ghp_TOKEN_ENV_PROBE';
const EXTRAHEADER = 'http.https://github.com/.extraheader';
const BASIC = Buffer.from('x-access-token:' + TOKEN).toString('base64');
const HEADER = `AUTHORIZATION: basic ${BASIC}`;
const GLOBAL_HEADER = 'X-From-Global: 1';
const OPERATOR_HEADER = 'X-From-Operator: 1';

describe('the publish token environment, as git reads it', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanupTempDirs();
  });

  it('keeps the operator\'s GIT_CONFIG_* entries and makes the token header the only one git sends', () => {
    const dir = createTempDir();
    // A header the operator configured globally, and two entries they export themselves.
    const globalConfig = safePath.join(dir, 'gitconfig');
    fs.writeFileSync(globalConfig, `[http "https://github.com/"]\n\textraheader = ${GLOBAL_HEADER}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', EXTRAHEADER);
    vi.stubEnv('GIT_CONFIG_VALUE_0', OPERATOR_HEADER);
    vi.stubEnv('GIT_CONFIG_KEY_1', 'vatprobe.operator');
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'kept');
    vi.stubEnv('GH_TOKEN', TOKEN);
    vi.stubEnv('GITHUB_TOKEN', undefined);

    const env = githubTokenEnv('https://github.com/o/r.git');
    const read = (args: string[]): string => runGitOrThrow(['config', ...args], { cwd: dir, env, trim: false });

    // Every entry, in the order git applies them: the operator's intact, then VAT's reset and header.
    expect(read(['--get-all', EXTRAHEADER]).split('\n').slice(0, -1)).toEqual([GLOBAL_HEADER, OPERATOR_HEADER, '', HEADER]);
    // The value git resolves for the remote's URL is the token header.
    expect(read(['--get-urlmatch', 'http.extraheader', 'https://github.com/o/r']).trim()).toBe(HEADER);
    // The operator's other entry still reads.
    expect(read(['--get', 'vatprobe.operator']).trim()).toBe('kept');
  });
});
