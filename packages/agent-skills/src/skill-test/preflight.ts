import { existsSync } from 'node:fs';

import {
  AuthPreflightError,
  resolveAuth,
  type AuthMechanism,
  type AuthMode,
  type AuthStatusProbe,
  type ResolvedAuth,
} from '@vibe-agent-toolkit/utils/skill-test';

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  suggestion?: string;
}

export interface PreflightInput {
  claudeVersionProbe: () => string | null;
  flagParseProbe: (flag: string) => boolean;
  authProbe: AuthStatusProbe;
  evalInputPaths: string[];
  declaredDepDirs: string[];
  integrityOk: () => boolean;
  costEstimate: { evalCount: number; configurations: number; runsPerQuery: number; maxBudgetUsd?: number };
  authMode: AuthMode;
  requireAuth?: AuthMechanism;
  sourceEnv: NodeJS.ProcessEnv;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  passed: boolean;
  resolvedAuth: ResolvedAuth | null;
}

/**
 * Flags vat's spawn argv depends on that `claude --help` DOES document, so their
 * absence is a real, detectable incompatibility and a hard preflight failure.
 *
 * `--no-session-persistence` is here for integrity, not convenience: without it
 * Claude Code writes each headless session — grading nonce, answer key, the whole
 * transcript — to `$CLAUDE_CONFIG_DIR/projects/`, which vat hands the untrusted
 * child. See {@link assembleClaudeArgs}. A `claude` that cannot suppress that
 * cannot run these evals honestly, so it fails closed rather than silently
 * persisting.
 */
const REQUIRED_FLAGS = [
  '--plugin-dir', '--setting-sources', '--output-format',
  '--permission-mode', '--max-budget-usd', '--no-session-persistence',
] as const;

/**
 * Flags vat passes that are functional but NOT listed in `claude --help`.
 *
 * `--max-turns` works and its absence would be load-bearing, but it is
 * undocumented in 2.x — so a help-text probe reports it missing on a claude that
 * supports it perfectly. Reporting these as verified would be a lie in the other
 * direction, so they are surfaced as unverifiable and never fail the run.
 *
 * Keep this list SHORT and re-check it when the vendor documents a flag: an entry
 * here is a check vat is choosing not to make.
 */
const UNVERIFIABLE_FLAGS = ['--max-turns'] as const;

function checkExists(label: string, paths: string[]): PreflightCheck {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own resolved absolute paths
  const missing = paths.filter(p => !existsSync(p));
  return missing.length === 0
    ? { name: label, passed: true, message: `all ${paths.length} present` }
    : { name: label, passed: false, message: `missing: ${missing.join(', ')}`, suggestion: 'These are declared but absent (exit 2).' };
}

/**
 * Why a missing flag stops the run. `--no-session-persistence` gets its own text
 * because its absence is not a compatibility inconvenience — it puts the grading
 * nonce and the eval answer key on a disk the skill under test can read.
 */
function upgradeSuggestionFor(flag: string): string {
  return flag === '--no-session-persistence'
    ? 'Upgrade Claude Code. Without --no-session-persistence the harness cannot keep the grading nonce and answer key off a disk the skill under test can read, so it refuses to run.'
    : 'Upgrade Claude Code — this flag is part of the harness spawn and has no fallback.';
}

/**
 * One check per flag the spawn argv carries: gated for the ones `claude --help`
 * documents, informational for the ones it does not (see {@link UNVERIFIABLE_FLAGS}).
 * Both are REPORTED — the probe this replaced said "supported" about every flag
 * without being able to tell, so silence about a flag is exactly the failure mode.
 */
function flagChecks(probe: (flag: string) => boolean): PreflightCheck[] {
  const gated = REQUIRED_FLAGS.map((flag): PreflightCheck => {
    const ok = probe(flag);
    return {
      name: `flag ${flag}`,
      passed: ok,
      message: ok ? 'supported' : 'NOT supported by this claude',
      ...(ok ? {} : { suggestion: upgradeSuggestionFor(flag) }),
    };
  });
  const informational = UNVERIFIABLE_FLAGS.map((flag): PreflightCheck => ({
    name: `flag ${flag}`,
    passed: true,
    message: 'passed but undocumented — support not verifiable from --help',
  }));
  return [...gated, ...informational];
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const checks: PreflightCheck[] = [];

  const version = input.claudeVersionProbe();
  checks.push(
    version
      ? { name: 'claude binary', passed: true, message: version }
      : { name: 'claude binary', passed: false, message: 'not reachable', suggestion: 'Install Claude Code CLI.' },
    ...flagChecks(input.flagParseProbe),
    input.integrityOk()
      ? { name: 'vendored skill-creator integrity', passed: true, message: 'manifest verified' }
      : { name: 'vendored skill-creator integrity', passed: false, message: 'hash manifest mismatch', suggestion: 'Re-sync the vendored copy.' },
    checkExists('eval input files', input.evalInputPaths),
    checkExists('declared dependencies', input.declaredDepDirs),
  );

  let resolvedAuth: ResolvedAuth | null = null;
  try {
    resolvedAuth = resolveAuth({
      mode: input.authMode,
      ...(input.requireAuth ? { requireAuth: input.requireAuth } : {}),
      sourceEnv: input.sourceEnv,
      probe: input.authProbe,
    });
    const apiKeyPart = resolvedAuth.apiKeySource ? ` (apiKeySource=${resolvedAuth.apiKeySource})` : '';
    const authMethodPart = resolvedAuth.authMethod ? ` authMethod=${resolvedAuth.authMethod}` : '';
    const authMessage = `mechanism=${resolvedAuth.effectiveMechanism}${apiKeyPart}${authMethodPart}`;
    checks.push({
      name: 'auth',
      passed: true,
      message: authMessage,
    });
  } catch (e) {
    const msg = e instanceof AuthPreflightError ? e.message : String(e);
    checks.push({ name: 'auth', passed: false, message: msg, suggestion: 'Adjust --auth / --require-auth or your credentials.' });
  }

  const { evalCount, configurations, runsPerQuery, maxBudgetUsd } = input.costEstimate;
  const totalExecutions = evalCount * configurations * runsPerQuery;
  const budgetPart = maxBudgetUsd ? `, budget $${maxBudgetUsd}` : '';
  const costMessage = `${evalCount} evals × ${configurations} config × ${runsPerQuery} runs = ${totalExecutions} executions${budgetPart}`;
  checks.push({
    name: 'cost estimate',
    passed: true,
    message: costMessage,
  });

  return { checks, passed: checks.every(c => c.passed), resolvedAuth };
}
