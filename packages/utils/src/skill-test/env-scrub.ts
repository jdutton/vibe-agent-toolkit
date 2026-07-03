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

/**
 * Process-essential vars that must survive for the child to even start. Includes
 * the standard Windows essentials (APPDATA/LOCALAPPDATA — Claude's default config
 * dir derives from these when CLAUDE_CONFIG_DIR is unset; SystemDrive, windir,
 * PATHEXT, COMSPEC — needed to locate and launch executables). None are
 * secret-bearing; the allowlist stays strict/exact-name.
 *
 * USER/LOGNAME (the POSIX username vars) are load-bearing for subscription auth
 * on macOS: the `claude` CLI resolves the OAuth/subscription token from the login
 * Keychain, and that lookup needs $USER — strip it and `claude auth status`
 * reports loggedIn:false even with an active subscription, so `--auth
 * subscription` (and inherit's subscription fallback) wrongly fail preflight, and
 * the experimenter child can't authenticate. Neither is secret-bearing (the
 * username is already derivable from the forwarded HOME), so they fit the policy.
 * Not needed for api-key auth (key is self-contained) or Linux subscription auth
 * (token is a HOME-relative file) — which is why this gap went unnoticed.
 */
const PROCESS_ESSENTIALS = [
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'APPDATA', 'LOCALAPPDATA', 'SystemDrive', 'windir', 'PATHEXT', 'COMSPEC',
] as const;

/** The only auth/config vars ever forwarded. */
const AUTH_CONFIG_ALLOWLIST = ['CLAUDE_CONFIG_DIR'] as const;

/** The active inference credential candidates (forwarded unless scrubbed). */
const INFERENCE_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Vars that a declared env entry (injectEnv / passEnv) may NEVER override.
 * These are deny-only — they are not in the forward allowlist either.
 *
 * WHY: Any of these names let a committed config attack without skill code:
 *   • ANTHROPIC_*_BASE_URL / ANTHROPIC_API_URL — redirect the inference endpoint
 *     so the forwarded ANTHROPIC_API_KEY is sent to an attacker-controlled server.
 *   • *_PROXY / *_proxy — redirect all HTTPS traffic (including API calls) through
 *     a MITM proxy even when the base URL looks correct.
 *   • NODE_OPTIONS — inject arbitrary code into the claude child process via
 *     --require or --import before any userland code runs.
 *   • NODE_EXTRA_CA_CERTS — add a rogue CA certificate, enabling TLS interception.
 *   • LD_PRELOAD / LD_LIBRARY_PATH / DYLD_INSERT_LIBRARIES / DYLD_LIBRARY_PATH —
 *     the OS-linker siblings of NODE_OPTIONS: load an attacker .so/.dylib into the
 *     child before any userland code runs (native code injection, bundler-agnostic).
 *   • NODE_PATH — prepend an attacker directory to Node's module resolution so a
 *     rogue package shadows a legitimate `require`.
 *   • GIT_SSH_COMMAND — run an arbitrary command on any git operation the harness
 *     performs (e.g. a git: source clone).
 */
const CREDENTIAL_ROUTING_DENY = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'GIT_SSH_COMMAND',
] as const;

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

/**
 * The full set of env var names protected from declared override. A declared
 * passEnv/injectEnv entry naming one of these is ignored (the protected value
 * wins) and a warning is surfaced — a test must never clobber PATH, the auth
 * credentials, or the admin key. `modelVars` (run-specific model env var names)
 * join the set so a declared var can't shadow them either.
 */
export function protectedEnvNames(modelVars: readonly string[] = []): Set<string> {
  return new Set<string>([
    ...PROCESS_ESSENTIALS,
    ...AUTH_CONFIG_ALLOWLIST,
    ...INFERENCE_CREDENTIALS,
    'ANTHROPIC_ADMIN_API_KEY',
    ...CREDENTIAL_ROUTING_DENY,
    ...modelVars,
  ]);
}

/**
 * Returns true if `name` is in `protectedSet`.
 *
 * On Windows (win32) env names are case-insensitive — `path` and `PATH` are the
 * same variable — so we upper-case both sides before comparing. On POSIX, names
 * are genuinely case-distinct, so the comparison stays exact.
 *
 * The `platform` parameter defaults to `process.platform` but is exposed so
 * unit tests can exercise the win32 branch on any host OS.
 */
export function isProtectedName(
  name: string,
  protectedSet: Set<string>,
  platform: string = process.platform,
): boolean {
  if (platform === 'win32') {
    const upper = name.toUpperCase();
    for (const p of protectedSet) {
      if (p.toUpperCase() === upper) return true;
    }
    return false;
  }
  return protectedSet.has(name);
}

/** Declared test env (Features A + B) to union onto a forwarded env. */
export interface DeclaredEnvInput {
  /** Parent env to read Feature-A pass-through values from. */
  source: NodeJS.ProcessEnv;
  /** Feature A: names to forward from `source` if present. */
  passEnv?: readonly string[];
  /** Feature B: explicit key→value injections (already interpolated). */
  injectEnv?: Record<string, string>;
  /** Run-specific model env var names that are also protected. */
  modelVars?: readonly string[];
}

export interface DeclaredEnvResult {
  /** The forwarded env with declared additions unioned in. */
  env: NodeJS.ProcessEnv;
  /** Human-readable warnings (protected-key collisions). */
  warnings: string[];
  /** Names injected via Feature B (shown in the transparency line). */
  injected: string[];
  /** Names passed through via Feature A (redacted in the transparency line). */
  passedThrough: string[];
}

/**
 * Union declared test env (Features A + B) onto an already-built forwarded env.
 * Protected keys always win: a declared name colliding with a process-essential,
 * auth, model, or admin var is ignored and a warning emitted. Feature-B injection
 * (explicit value) takes precedence over Feature-A pass-through for the same key.
 * The input `base` object is never mutated.
 */
export function applyDeclaredEnv(base: NodeJS.ProcessEnv, input: DeclaredEnvInput): DeclaredEnvResult {
  const out: NodeJS.ProcessEnv = { ...base };
  const protectedNames = protectedEnvNames(input.modelVars);
  const warnings: string[] = [];
  const injected: string[] = [];
  const passedThrough: string[] = [];

  const injectKeys = new Set(Object.keys(input.injectEnv ?? {}));

  // Feature A: pass-through by name.
  for (const name of input.passEnv ?? []) {
    if (isProtectedName(name, protectedNames)) {
      warnings.push(`passEnv "${name}" ignored: it collides with a protected variable.`);
      continue;
    }
    if (injectKeys.has(name)) continue; // Feature B wins for the same key.
    const value = input.source[name];
    if (value === undefined) continue; // absent host var → simply not forwarded.
    out[name] = value;
    passedThrough.push(name);
  }

  // Feature B: explicit value injection.
  for (const [name, value] of Object.entries(input.injectEnv ?? {})) {
    if (isProtectedName(name, protectedNames)) {
      warnings.push(`env "${name}" ignored: it collides with a protected variable.`);
      continue;
    }
    out[name] = value;
    injected.push(name);
  }

  return { env: out, warnings, injected, passedThrough };
}

/** Names whose VALUES are secrets and must be redacted in the transparency line. */
const SECRET_NAMES = new Set<string>(INFERENCE_CREDENTIALS);

/**
 * Render the single-line stderr transparency summary of the forwarded env. Key
 * names are always shown. Auth/secret values are redacted; Feature-A pass-through
 * values are redacted (host-sourced, may be a secret); Feature-B injected values
 * are shown (they come from committed config).
 */
export function formatForwardedEnvLine(
  env: NodeJS.ProcessEnv,
  classified: { injected: readonly string[]; passedThrough: readonly string[] },
): string {
  const injected = new Set(classified.injected);
  const passedThrough = new Set(classified.passedThrough);
  const parts = Object.keys(env).map((name) => {
    if (injected.has(name)) return `${name}=${env[name] ?? ''}`;
    if (passedThrough.has(name)) return `${name}(passed-through, redacted)`;
    if (SECRET_NAMES.has(name)) return `${name}(redacted)`;
    return name;
  });
  return `forwarded env: ${parts.join(', ')}`;
}
