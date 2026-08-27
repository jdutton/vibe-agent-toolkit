/**
 * declared-env.ts — resolve and assemble the declared test environment
 * (Features A + B) for the experimenter spawn.
 *
 * Feature A (passEnv): forward named host env vars if present.
 * Feature B (env): inject explicit key→value pairs whose values support
 * stage-time interpolation tokens. An unknown token is a hard preflight error.
 *
 * The security-critical union (protected-key collisions, redaction) lives in
 * `applyDeclaredEnv`/`formatForwardedEnvLine` (utils); this module owns the
 * agent-skills-specific concerns: token computation, interpolation, and gluing
 * the result onto the plugin-root env.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { applyDeclaredEnv, formatForwardedEnvLine } from '@vibe-agent-toolkit/utils/skill-test';

import { withPluginRootEnv } from './plugin-env.js';

/**
 * Resolved stage-time interpolation tokens (all absolute, forward-slash).
 *
 * `fixturesDir` is optional because it is PER-EVAL: it names the eval's own staged
 * input workspace, which exists only when that eval declares input `files`. Every
 * other token is run-scoped.
 */
export interface EnvInterpolationTokens {
  fixturesDir?: string;
  stagedSkillDir: string;
  harnessRoot: string;
  resultsDir: string;
}

/**
 * A declared `env` value referenced an unknown `${token}`. Exit 2 (preflight):
 * fail loud naming the offending token rather than forwarding a literal `${x}`.
 */
export class UnknownEnvTokenError extends Error {
  readonly exitCode = 2 as const;
  constructor(public readonly token: string, public readonly key: string) {
    super(
      `Unknown interpolation token \${${token}} in env value for "${key}". ` +
        `Known tokens: fixturesDir, stagedSkillDir, harnessRoot, resultsDir.`,
    );
    this.name = 'UnknownEnvTokenError';
  }
}

/**
 * A declared `env` value used `${fixturesDir}` for an eval that has no staged
 * input workspace, so the token names nothing. Exit 2 (preflight): fail loud
 * rather than hand the executor a path that does not exist.
 *
 * This is the failure mode that made the token's own regression invisible —
 * `interpolateEnvValue` is a plain string substitution, so a token resolving to a
 * deleted directory produced a dead path the skill only discovered at runtime,
 * where it read as a skill bug rather than a harness one.
 */
export class UnresolvableEnvTokenError extends Error {
  readonly exitCode = 2 as const;
  constructor(public readonly token: string, public readonly key: string) {
    super(
      `Cannot resolve \${${token}} in env value for "${key}": this eval declares no input ` +
        `\`files\`, so it has no staged fixtures directory. Declare the fixture under the ` +
        `eval's \`files\` list (it is staged into the eval's own workspace, which is also the ` +
        `executor's working directory), or drop \${${token}} from that env value.`,
    );
    this.name = 'UnresolvableEnvTokenError';
  }
}

export interface EnvTokenInputs {
  subjectStagedDir: string;
  harnessRoot: string;
  resultsDir: string;
  /** Evals subpath (e.g. `evals/evals.json`). Retained for the run-scoped tokens. */
  evalsSubpath: string;
  /**
   * The eval's staged input workspace, when it declares input `files`. `fixtures/`
   * beneath it is what `${fixturesDir}` names.
   */
  workspaceDir?: string;
}

/**
 * Compute the interpolation tokens from the known staged dirs.
 *
 * `fixturesDir` used to be `<staged>/<evalsDir>/fixtures`. Eval-suite isolation
 * DELETES that directory from every staged subject — it holds the answer key, and
 * `fixtures/` is its child — so the old token named a path that provably does not
 * exist. Each eval's declared input `files` are now staged into the eval's own
 * workspace, which is also the executor's working directory, so that workspace's
 * `fixtures/` is what the token means. An eval with no declared `files` has no
 * workspace and therefore no fixtures dir: the token stays undefined and
 * interpolating it throws {@link UnresolvableEnvTokenError} rather than silently
 * producing a dead path.
 *
 * Pointing this back at the staged (or held) suite directory would hand the
 * executor a sibling path to `evals.json` and reopen the answer-key leak.
 */
export function computeEnvTokens(inputs: EnvTokenInputs): EnvInterpolationTokens {
  return {
    ...(inputs.workspaceDir === undefined
      ? {}
      : { fixturesDir: safePath.join(inputs.workspaceDir, 'fixtures') }),
    stagedSkillDir: inputs.subjectStagedDir,
    harnessRoot: inputs.harnessRoot,
    resultsDir: inputs.resultsDir,
  };
}

function lookupToken(name: string, key: string, tokens: EnvInterpolationTokens): string {
  switch (name) {
    case 'fixturesDir': {
      if (tokens.fixturesDir === undefined) throw new UnresolvableEnvTokenError(name, key);
      return tokens.fixturesDir;
    }
    case 'stagedSkillDir': return tokens.stagedSkillDir;
    case 'harnessRoot': return tokens.harnessRoot;
    case 'resultsDir': return tokens.resultsDir;
    default: throw new UnknownEnvTokenError(name, key);
  }
}

/** Interpolate every `${token}` in `value`. Throws UnknownEnvTokenError on an unknown token. */
export function interpolateEnvValue(value: string, key: string, tokens: EnvInterpolationTokens): string {
  return value.replaceAll(/\$\{([^}]*)\}/g, (_match, name: string) => lookupToken(name, key, tokens));
}

/** Token names this module knows how to resolve. */
const KNOWN_TOKENS = new Set(['fixturesDir', 'stagedSkillDir', 'harnessRoot', 'resultsDir']);

/**
 * Preflight check for token NAMES only, with no resolution.
 *
 * `${fixturesDir}` cannot be resolved run-scoped — it names a per-eval workspace —
 * but a TYPO in any token should still fail before the run spends a cent. This
 * runs once at preflight; {@link resolveInjectEnv} then resolves per eval.
 */
export function assertKnownEnvTokens(injectEnv: Record<string, string> | undefined): void {
  if (injectEnv === undefined) return;
  for (const [key, value] of Object.entries(injectEnv)) {
    for (const [, name] of value.matchAll(/\$\{([^}]*)\}/g)) {
      if (!KNOWN_TOKENS.has(name ?? '')) throw new UnknownEnvTokenError(name ?? '', key);
    }
  }
}

/** Resolve every value in a declared `env` map. undefined in → undefined out. */
export function resolveInjectEnv(
  injectEnv: Record<string, string> | undefined,
  tokens: EnvInterpolationTokens,
): Record<string, string> | undefined {
  if (injectEnv === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(injectEnv)) {
    out[key] = interpolateEnvValue(value, key, tokens);
  }
  return out;
}

export interface AssembleChildEnvInput {
  /** The scrubbed, auth-resolved forwarded env (the deny-all base). */
  base: NodeJS.ProcessEnv;
  /** Parent env to read Feature-A pass-through values from. */
  source: NodeJS.ProcessEnv;
  /** Feature A names. */
  passEnv?: readonly string[];
  /** Feature B values, already interpolated. */
  injectEnv?: Record<string, string>;
  /** Subject's staged plugin root (null = standalone). */
  subjectPluginRoot: string | null;
}

export interface AssembledChildEnv {
  env: NodeJS.ProcessEnv;
  warnings: string[];
  /** Single-line stderr transparency summary (no trailing newline). */
  line: string;
}

/**
 * Union the declared test env onto `base`, add the plugin-root var, and render
 * the transparency line. Protected-key collisions surface as warnings; secrets
 * and pass-through values are redacted in the line.
 */
export function assembleChildEnv(input: AssembleChildEnvInput): AssembledChildEnv {
  const declared = applyDeclaredEnv(input.base, {
    source: input.source,
    ...(input.passEnv ? { passEnv: input.passEnv } : {}),
    ...(input.injectEnv ? { injectEnv: input.injectEnv } : {}),
  });
  const env = withPluginRootEnv(declared.env, input.subjectPluginRoot);
  const line = formatForwardedEnvLine(env, declared);
  return { env, warnings: declared.warnings, line };
}
