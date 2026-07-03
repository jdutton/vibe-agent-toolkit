import { safeExecResult } from '../safe-exec.js';

import { buildForwardedEnv } from './env-scrub.js';

export type AuthMode = 'inherit' | 'subscription' | 'api-key' | 'auto';
export type AuthMechanism = 'subscription' | 'api-key';

export interface AuthStatusResult {
  loggedIn: boolean;
  authMethod?: string;
  apiKeySource?: string;
}

export type AuthStatusProbe = (env: NodeJS.ProcessEnv) => AuthStatusResult | null;

export interface ResolveAuthOptions {
  mode: AuthMode;
  requireAuth?: AuthMechanism;
  sourceEnv: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to the real CLI probe in production. */
  probe?: AuthStatusProbe;
  modelVars?: string[];
}

export interface ResolvedAuth {
  forwardedEnv: NodeJS.ProcessEnv;
  effectiveMechanism: AuthMechanism;
  authMethod?: string;
  apiKeySource?: string;
}

/** A preflight auth failure — maps to exit code 2. */
export class AuthPreflightError extends Error {
  readonly exitCode = 2 as const;
  constructor(message: string) {
    super(message);
    this.name = 'AuthPreflightError';
  }
}

/**
 * Token-free auth probe (spec §8/§10). Runs `claude auth status --json` in the
 * given env: returns in ~150ms, exit 0, spends NO tokens. NOT a `-p` call.
 */
export function probeAuthStatus(env: NodeJS.ProcessEnv): AuthStatusResult | null {
  const res = safeExecResult('claude', ['auth', 'status', '--json'], { env, encoding: 'utf8', stdio: 'pipe' });
  if (!res.success) return null;
  try {
    const parsed = JSON.parse(res.stdout.toString()) as Record<string, unknown>;
    return {
      loggedIn: parsed['loggedIn'] === true,
      ...(typeof parsed['authMethod'] === 'string' ? { authMethod: parsed['authMethod'] } : {}),
      ...(typeof parsed['apiKeySource'] === 'string' ? { apiKeySource: parsed['apiKeySource'] } : {}),
    };
  } catch {
    return null;
  }
}

function hasInferenceKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['ANTHROPIC_API_KEY'] ?? env['ANTHROPIC_AUTH_TOKEN']);
}

/** Decide whether to scrub the inference key, given mode + a subscription-present probe. */
function decideScrub(mode: AuthMode, sourceEnv: NodeJS.ProcessEnv, probe: AuthStatusProbe): boolean {
  if (mode === 'subscription') return true;
  if (mode === 'api-key' || mode === 'auto') return false;
  // inherit: scrub the key only if a subscription is actually logged in.
  const scrubbed = buildForwardedEnv(sourceEnv, { scrubInferenceKey: true });
  const status = probe(scrubbed);
  return status?.loggedIn === true;
}

export function resolveAuth(opts: ResolveAuthOptions): ResolvedAuth {
  const probe = opts.probe ?? probeAuthStatus;
  const baseOpts = opts.modelVars ? { modelVars: opts.modelVars } : {};

  if (opts.mode === 'api-key' && !hasInferenceKey(opts.sourceEnv)) {
    throw new AuthPreflightError('--auth api-key requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to be set.');
  }

  const scrubInferenceKey = decideScrub(opts.mode, opts.sourceEnv, probe);
  const forwardedEnv = buildForwardedEnv(opts.sourceEnv, { scrubInferenceKey, ...baseOpts });

  const status = probe(forwardedEnv);
  if (opts.mode === 'subscription' && status?.loggedIn !== true) {
    throw new AuthPreflightError('--auth subscription requires a logged-in subscription (claude auth status reports not logged in).');
  }

  const effectiveMechanism: AuthMechanism =
    !scrubInferenceKey && hasInferenceKey(forwardedEnv) ? 'api-key' : 'subscription';

  if (opts.requireAuth && opts.requireAuth !== effectiveMechanism) {
    throw new AuthPreflightError(
      `--require-auth ${opts.requireAuth} but the effective mechanism is ${effectiveMechanism}. Refusing to spend tokens.`,
    );
  }

  return {
    forwardedEnv,
    effectiveMechanism,
    ...(status?.authMethod ? { authMethod: status.authMethod } : {}),
    ...(status?.apiKeySource ? { apiKeySource: status.apiKeySource } : {}),
  };
}
