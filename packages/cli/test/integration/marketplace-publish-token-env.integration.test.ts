/**
 * The CI token's git configuration, as real git SENDS it — to a local HTTP server, no network.
 *
 * `vat claude marketplace publish` authenticates by appending entries to git's env-only
 * configuration channel (`GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n`) after any the operator already
 * exports: an empty value that resets the `extraheader` list, then the token header. Reading the
 * configuration back proves nothing about the wire (`--get-urlmatch` answers the last value with or
 * without the reset), so this records the headers git actually sends. Two AUTHORIZATION headers —
 * the operator's and ours — is what GitHub answers with 400.
 *
 * And `runGit`'s environment scrub must KEEP the operator's `GIT_CONFIG_*`: drop them and git sees
 * a count naming keys that are not there, and refuses.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { githubTokenEnv } from '../../src/commands/claude/marketplace/git-publish.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { createTempDirTracker, fs } from '../system/test-common.js';

useScratchTmpdir('vat-scratch-cli-mp-token-env-');

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-mp-token-env-');

const TOKEN = 'ghp_TOKEN_ENV_PROBE';
const BASIC = Buffer.from('x-access-token:' + TOKEN).toString('base64');

/** A local server that answers 404 and records each request's raw headers, as `[name, value]` pairs. */
async function recordingServer(): Promise<{ prefix: string; requests: [string, string][][]; close: () => Promise<void> }> {
  const requests: [string, string][][] = [];
  const server = createServer((request, response) => {
    const pairs: [string, string][] = [];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      pairs.push([request.rawHeaders[index] ?? '', request.rawHeaders[index + 1] ?? '']);
    }
    requests.push(pairs);
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    prefix: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

describe('the publish token environment, as git sends it', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanupTempDirs();
  });

  it('sends exactly one Authorization header, the token\'s, beside operator headers for the same URL prefix', async () => {
    const dir = createTempDir();
    const server = await recordingServer();
    try {
      const key = `http.${server.prefix}.extraheader`;
      // A header the operator configured globally, and two entries they export themselves.
      const globalConfig = safePath.join(dir, 'gitconfig');
      fs.writeFileSync(globalConfig, `[http "${server.prefix}"]\n\textraheader = AUTHORIZATION: basic from-global\n`);
      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_CONFIG_COUNT', '2');
      vi.stubEnv('GIT_CONFIG_KEY_0', key);
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'AUTHORIZATION: basic from-operator-env');
      vi.stubEnv('GIT_CONFIG_KEY_1', 'vatprobe.operator');
      vi.stubEnv('GIT_CONFIG_VALUE_1', 'kept');
      vi.stubEnv('GH_TOKEN', TOKEN);
      vi.stubEnv('GITHUB_TOKEN', undefined);

      const env = githubTokenEnv(`${server.prefix}r`, server.prefix);

      // runGit's scrub keeps the operator's numbered entries beside VAT's.
      expect(runGitOrThrow(['config', '--get', 'vatprobe.operator'], { cwd: dir, env })).toBe('kept');

      // ls-remote fails against a 404; only the first request's headers matter.
      await promisify(execFile)(gitExecutable(), ['ls-remote', '--', `${server.prefix}r`], {
        cwd: dir,
        timeout: 20_000,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
      }).catch(() => undefined);

      const first = server.requests[0];
      expect(first).toBeDefined();
      const authorizations = (first ?? []).filter(([name]) => name.toLowerCase() === 'authorization').map(([, value]) => value);
      expect(authorizations).toEqual([`basic ${BASIC}`]);
    } finally {
      await server.close();
    }
  });
});
