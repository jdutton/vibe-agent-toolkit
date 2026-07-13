/**
 * Shared subscription invoker for the compat harness.
 *
 * Every `claude` spawn in the harness routes through here so the zero-API
 * guarantee lives in exactly one place: the child env gets the subscription
 * OAuth token and has ALL API credentials deleted, so the CLI cannot fall
 * back to API billing regardless of its internal auth-precedence order.
 */

import { type ChildProcessByStdio } from 'node:child_process';
import { type Readable } from 'node:stream';

import { safePath, spawnHardened } from '@vibe-agent-toolkit/utils';

import { promptUser } from '../../cli/prompt-user.js';

export interface ClaudeSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ClaudeSubscriptionOpts {
  /** Temp-profile HOME for per-attempt isolation (driver). Omit for the judge. */
  homeDir?: string;
  timeoutMs: number;
}

export function buildSubscriptionEnv(
  source: NodeJS.ProcessEnv,
  opts: { token: string; homeDir?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  env['CLAUDE_CODE_OAUTH_TOKEN'] = opts.token;
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  if (opts.homeDir !== undefined) {
    env['HOME'] = opts.homeDir;
    env['USERPROFILE'] = opts.homeDir;
    env['XDG_CONFIG_HOME'] = safePath.join(opts.homeDir, '.config');
  }
  return env;
}

export function requireOAuthToken(): string {
  const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (!token) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is not set. Mint one with `claude setup-token` ' +
        '(requires an active Claude Pro/Max subscription), then export it before running the harness.',
    );
  }
  return token;
}

export type PromptFn = (question: string) => Promise<string>;

/**
 * Resolve the operator's OWN subscription token so the run only ever spends
 * the operator's personal plan — never an ambient/shared/CI credential.
 * Prefers an explicit env var (repeat runs in one's own shell); otherwise
 * prompts the operator to paste their token. Populates process.env so the
 * synchronous requireOAuthToken() inside runClaudeSubscription finds it for
 * the rest of the run (env is the cache; no module-global). Call once at
 * preflight, before any spawn.
 */
export async function resolveOAuthToken(promptFn: PromptFn = promptUser): Promise<string> {
  const fromEnv = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (fromEnv) return fromEnv;
  const entered = (await promptFn(
    'Paste your Claude subscription OAuth token (from `claude setup-token`).\n' +
      'This run bills your personal plan only: ',
  )).trim();
  if (!entered) {
    throw new Error(
      'No OAuth token provided. Mint one with `claude setup-token` (requires an active ' +
        'Claude Pro/Max subscription) and paste it when prompted, or set CLAUDE_CODE_OAUTH_TOKEN.',
    );
  }
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = entered;
  return entered;
}

export function runClaudeSubscription(
  args: string[],
  opts: ClaudeSubscriptionOpts,
): Promise<ClaudeSpawnResult> {
  const token = requireOAuthToken();
  const env = buildSubscriptionEnv(process.env, {
    token,
    ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
  });

  return new Promise((resolve) => {
    // spawnHardened (not a bare spawn) so a Windows `claude.cmd` shim launches
    // instead of throwing EINVAL. stdio ['ignore','pipe','pipe'] → non-null out/err.
    const child = spawnHardened('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<null, Readable, Readable>;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const handle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, opts.timeoutMs);

    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

    child.on('close', (code) => {
      clearTimeout(handle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code,
        timedOut,
      });
    });

    child.on('error', () => {
      clearTimeout(handle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: -1,
        timedOut: false,
      });
    });
  });
}
