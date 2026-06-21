import { existsSync } from 'node:fs';

import {
  AuthPreflightError,
  resolveAuth,
  type AuthMechanism,
  type AuthMode,
  type AuthStatusProbe,
  type ResolvedAuth,
} from '@vibe-agent-toolkit/utils';

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

const REQUIRED_FLAGS = [
  '--plugin-dir', '--setting-sources', '--output-format',
  '--permission-mode', '--max-turns', '--max-budget-usd',
] as const;

function checkExists(label: string, paths: string[]): PreflightCheck {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own resolved absolute paths
  const missing = paths.filter(p => !existsSync(p));
  return missing.length === 0
    ? { name: label, passed: true, message: `all ${paths.length} present` }
    : { name: label, passed: false, message: `missing: ${missing.join(', ')}`, suggestion: 'These are declared but absent (exit 2).' };
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const checks: PreflightCheck[] = [];

  const version = input.claudeVersionProbe();
  checks.push(version
    ? { name: 'claude binary', passed: true, message: version }
    : { name: 'claude binary', passed: false, message: 'not reachable', suggestion: 'Install Claude Code CLI.' });

  for (const flag of REQUIRED_FLAGS) {
    const ok = input.flagParseProbe(flag);
    checks.push({
      name: `flag ${flag}`,
      passed: ok,
      message: ok ? 'supported' : 'NOT supported by this claude',
      ...(flag === '--max-turns' && !ok
        ? { suggestion: '--max-turns is functional-but-undocumented in 2.x; its absence is load-bearing.' }
        : {}),
    });
  }

  checks.push(input.integrityOk()
    ? { name: 'vendored skill-creator integrity', passed: true, message: 'manifest verified' }
    : { name: 'vendored skill-creator integrity', passed: false, message: 'hash manifest mismatch', suggestion: 'Re-sync the vendored copy.' });

  checks.push(checkExists('eval input files', input.evalInputPaths));
  checks.push(checkExists('declared dependencies', input.declaredDepDirs));

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
