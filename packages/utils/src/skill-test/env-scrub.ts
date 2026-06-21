/**
 * Build the forwarded environment for the headless `claude` child using a
 * STRICT exact-name allowlist (spec §14). We never forward ANTHROPIC_* by
 * prefix — that would silently leak ANTHROPIC_ADMIN_API_KEY, proxy overrides,
 * etc. into untrusted skill code. Anything not enumerated is dropped.
 */

export interface ForwardEnvOptions {
  /** True under --auth subscription (and inherit-with-subscription): drop the inference key so the child uses OAuth. */
  scrubInferenceKey: boolean;
  /** Additional exact model var names the run needs (e.g. ANTHROPIC_MODEL). */
  modelVars?: string[];
}

/** Process-essential vars that must survive for the child to even start. */
const PROCESS_ESSENTIALS = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

/** The only auth/config vars ever forwarded. */
const AUTH_CONFIG_ALLOWLIST = ['CLAUDE_CONFIG_DIR'] as const;

/** The active inference credential candidates (forwarded unless scrubbed). */
const INFERENCE_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export function buildForwardedEnv(
  source: NodeJS.ProcessEnv,
  opts: ForwardEnvOptions,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};

  const allow = new Set<string>([
    ...PROCESS_ESSENTIALS,
    ...AUTH_CONFIG_ALLOWLIST,
    ...(opts.modelVars ?? []),
  ]);
  if (!opts.scrubInferenceKey) {
    for (const name of INFERENCE_CREDENTIALS) allow.add(name);
  }

  for (const name of allow) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }

  // ANTHROPIC_ADMIN_API_KEY and CLAUDECODE/CLAUDE_CODE_* are never in `allow`,
  // so they are dropped by construction. No explicit delete needed — but assert
  // the invariant defensively so a future allowlist edit can't reintroduce it.
  delete out['ANTHROPIC_ADMIN_API_KEY'];

  return out;
}
