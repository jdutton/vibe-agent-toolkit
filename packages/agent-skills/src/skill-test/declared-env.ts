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

import { dirname } from 'node:path';

import { applyDeclaredEnv, formatForwardedEnvLine, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { withPluginRootEnv } from './plugin-env.js';

/** Resolved stage-time interpolation tokens (all absolute, forward-slash). */
export interface EnvInterpolationTokens {
  fixturesDir: string;
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

export interface EnvTokenInputs {
  subjectStagedDir: string;
  harnessRoot: string;
  resultsDir: string;
  /** Evals subpath (e.g. `evals/evals.json`); fixtures live in its dir's `fixtures/`. */
  evalsSubpath: string;
}

/**
 * Compute the interpolation tokens from the known staged dirs. `fixturesDir`
 * tracks the eval suite's directory (`<evalsDir>/fixtures`), so the default
 * `evals/evals.json` yields `<staged>/evals/fixtures`.
 */
export function computeEnvTokens(inputs: EnvTokenInputs): EnvInterpolationTokens {
  const evalsDir = dirname(toForwardSlash(inputs.evalsSubpath));
  return {
    fixturesDir: safePath.join(inputs.subjectStagedDir, evalsDir, 'fixtures'),
    stagedSkillDir: inputs.subjectStagedDir,
    harnessRoot: inputs.harnessRoot,
    resultsDir: inputs.resultsDir,
  };
}

function lookupToken(name: string, key: string, tokens: EnvInterpolationTokens): string {
  switch (name) {
    case 'fixturesDir': return tokens.fixturesDir;
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
